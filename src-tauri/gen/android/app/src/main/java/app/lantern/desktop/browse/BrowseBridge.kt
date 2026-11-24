package app.lantern.desktop.browse

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import app.lantern.desktop.MainActivity
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * `window.LanternBrowse`: the phone's own storage, other computers' shared drives
 * and media servers, for the Browse screen.
 *
 * Everything is asynchronous. A share can take many seconds to list, and a JavaScript
 * call into this object blocks the page until it returns - so the page sends
 * `request(id, json)`, which returns at once, and the answer arrives later as
 * `window.__browseEvent({id, ok, data | error})`.
 *
 * Phones only (registered in MainActivity.onWebViewCreate). Nothing here reaches
 * out until the page asks: no discovery runs in the background.
 */
class BrowseBridge(private val context: Context, private val webView: WebView) {
  private val main = Handler(Looper.getMainLooper())
  private val pool = Executors.newCachedThreadPool()
  private val prefs = context.getSharedPreferences("lantern.browse", Context.MODE_PRIVATE)
  private val server = BrowseServer()
  private val local = LocalSource()

  /** What the last look at the network found, by id, so a listing can be asked for by id. */
  private val network = ConcurrentHashMap<String, Found>()
  private val smb = ConcurrentHashMap<String, SmbSource>()

  @JavascriptInterface
  fun request(id: String, json: String) {
    pool.execute {
      val reply = JSONObject().put("id", id)
      try {
        reply.put("ok", true).put("data", handle(JSONObject(json)))
      } catch (e: AuthRequired) {
        reply.put("ok", false).put("error", "auth")
      } catch (e: Exception) {
        Log.w("BrowseBridge", "request failed", e)
        reply.put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
      }
      val script = "window.__browseEvent && window.__browseEvent($reply)"
      main.post { webView.evaluateJavascript(script, null) }
    }
  }

  fun destroy() {
    server.stop()
    pool.shutdownNow()
  }

  /* --------------------------------------------------------------- requests */

  private fun handle(q: JSONObject): Any = when (q.getString("op")) {
    "sources" -> sources()
    "scan" -> {
      scan()
      sources()
    }
    "list" -> list(q.getString("source"), q.optString("path"))
    "open" -> JSONObject().put("url", open(q.getString("source"), q.getString("path"), q.optBoolean("subtitle")))
    "login" -> {
      login(q.getString("host"), q.getString("user"), q.getString("password"), q.optBoolean("remember", true))
      JSONObject()
    }
    "addFolder" -> {
      change("folders") { it.put(JSONObject().put("path", q.getString("path")).put("name", q.optString("name"))) }
      sources()
    }
    "removeFolder" -> {
      removeFrom("folders") { it.optString("path") == q.getString("path") }
      sources()
    }
    "addServer" -> {
      val host = q.getString("host").trim()
      require(host.matches(Regex("[A-Za-z0-9._-]{1,253}"))) { "that is not a computer name or address" }
      change("servers") { it.put(JSONObject().put("host", host).put("name", q.optString("name").ifEmpty { host })) }
      sources()
    }
    "removeServer" -> {
      removeFrom("servers") { it.optString("host") == q.getString("host") }
      forgetLogin(q.getString("host"))
      sources()
    }
    else -> throw IllegalArgumentException("unknown request")
  }

  private fun sources(): JSONObject {
    val phone = JSONArray()
    for ((path, name) in Discovery.phoneVolumes(context)) {
      phone.put(JSONObject().put("id", "local").put("kind", "local").put("name", name).put("path", path))
    }
    val folders = JSONArray()
    array("folders").forEach { f ->
      folders.put(JSONObject().put("id", "local").put("kind", "local").put("name", f.optString("name").ifEmpty { f.optString("path").substringAfterLast('/') }).put("path", f.optString("path")).put("pinned", true))
    }
    val net = JSONArray()
    val seen = HashSet<String>()
    // Servers the person added come first, then whatever the last scan found.
    array("servers").forEach { s ->
      val host = s.optString("host")
      seen.add("smb:$host")
      net.put(JSONObject().put("id", "smb:$host").put("kind", "smb").put("name", s.optString("name")).put("host", host).put("added", true).put("saved", hasLogin(host)))
    }
    for (found in network.values.sortedBy { it.name.lowercase() }) {
      if (!seen.add(found.id)) continue
      net.put(JSONObject().put("id", found.id).put("kind", found.kind).put("name", found.name).put("host", found.host).put("saved", found.kind == "smb" && hasLogin(found.host)))
    }
    return JSONObject().put("phone", phone).put("folders", folders).put("network", net).put("allFiles", MainActivity.allFilesAccess())
  }

  /** Looks for shared drives and media servers, both at once, and remembers what answered. */
  private fun scan() {
    val smbJob = pool.submit<List<Found>> { runCatching { Discovery.sharedDrives() }.getOrDefault(emptyList()) }
    val upnpJob = pool.submit<List<Found>> { runCatching { Discovery.mediaServers() }.getOrDefault(emptyList()) }
    network.clear()
    (smbJob.get() + upnpJob.get()).forEach { network[it.id] = it }
  }

  private fun list(source: String, path: String): JSONObject {
    val entries: List<Entry> = when {
      source == "local" -> local.list(path)
      source.startsWith("smb:") -> smbFor(source.removePrefix("smb:")).list(path)
      source.startsWith("upnp:") -> UpnpSource(
        (network[source] ?: throw IllegalStateException("that media server is not on the network any more - refresh")).controlUrl,
      ).list(path)
      else -> throw IllegalArgumentException("unknown source")
    }
    val sorted = entries.sortedWith(compareByDescending<Entry> { it.dir }.thenBy { it.name.lowercase() })
    val out = JSONArray()
    for (e in sorted) {
      out.put(
        JSONObject().put("name", e.name).put("path", e.path).put("dir", e.dir).put("size", e.size).put("modified", e.modified)
          .put("video", !e.dir && (BrowseCore.isVideo(e.name) || (e.url != null && source.startsWith("upnp:"))))
          .put("subtitle", !e.dir && BrowseCore.isSubtitle(e.name))
          .put("url", e.url ?: JSONObject.NULL),
      )
    }
    return JSONObject().put("entries", out)
  }

  /** An address the player can open for a file or a subtitle. */
  private fun open(source: String, path: String, subtitle: Boolean): String {
    val name = path.substringAfterLast('/')
    val streamable: Streamable = when {
      source == "local" -> local
      source.startsWith("smb:") -> smbFor(source.removePrefix("smb:"))
      else -> throw IllegalArgumentException("this source plays by its own address")
    }
    return server.urlFor(streamable, path, name, subtitle)
  }

  /* ------------------------------------------------------------ credentials */

  private fun smbFor(host: String): SmbSource = smb.getOrPut(host) {
    val login = prefs.getString("login.$host", null)
    val user = login?.substringBefore('\u0000')
    val password = login?.substringAfter('\u0000', "")
    SmbSource(host, user, password)
  }

  private fun hasLogin(host: String) = prefs.contains("login.$host")

  /**
   * Keeps a login the person typed for one computer, in the app's private storage.
   *
   * Not yet wrapped in the Android Keystore - it sits where the rest of this app's
   * private data does, which only this app can read, and a device that is rooted or
   * backed up unencrypted can see it. Said here so it is not mistaken for finished.
   */
  private fun login(host: String, user: String, password: String, remember: Boolean) {
    smb[host] = SmbSource(host, user, password)
    if (remember) prefs.edit().putString("login.$host", "$user\u0000$password").apply()
  }

  private fun forgetLogin(host: String) {
    smb.remove(host)
    prefs.edit().remove("login.$host").apply()
  }

  /* ---------------------------------------------------------- saved folders */

  private fun array(key: String): List<JSONObject> {
    val saved = JSONArray(prefs.getString(key, "[]"))
    return (0 until saved.length()).map { saved.getJSONObject(it) }
  }

  private fun change(key: String, edit: (JSONArray) -> Unit) {
    val saved = JSONArray(prefs.getString(key, "[]"))
    edit(saved)
    prefs.edit().putString(key, saved.toString()).apply()
  }

  private fun removeFrom(key: String, matches: (JSONObject) -> Boolean) {
    val kept = JSONArray()
    array(key).filterNot(matches).forEach { kept.put(it) }
    prefs.edit().putString(key, kept.toString()).apply()
  }
}
