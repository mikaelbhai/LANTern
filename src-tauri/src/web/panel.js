/*
 * The browser client's whole script.
 *
 * Two jobs: remember where a video got to, and ask for a pass phrase when a
 * title is locked. Inlined by hosting.rs for the same reason as the
 * stylesheet — these pages are opened on a network that may have no way out,
 * by somebody with nothing installed, and a second request that has to land
 * before the page works is a second thing that can fail.
 *
 * No framework, no build step. It is read by people looking at a folder, on
 * whatever they happened to be holding.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------- cookies */

  /*
   * Progress lives in a cookie, not on the server.
   *
   * The server has no idea who is watching: a browser typing the address in
   * is nobody, deliberately, because the plain-HTTP library is a feature and
   * anybody on the network can open it. So where a film got to is the
   * browser's own business, and keeping it here means no account, no
   * identity, and nothing to clear up when somebody stops using it.
   *
   * One cookie per title rather than one big one, because cookies are capped
   * at about 4KB each and a shelf with fifty films on it would otherwise
   * silently start dropping the oldest positions.
   */
  var PREFIX = 'lt_at_';
  var YEAR = 60 * 60 * 24 * 365;

  function setCookie(name, value, maxAge) {
    document.cookie =
      name +
      '=' +
      encodeURIComponent(value) +
      ';path=/;max-age=' +
      maxAge +
      ';samesite=lax';
  }

  function getCookie(name) {
    var all = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < all.length; i++) {
      var eq = all[i].indexOf('=');
      if (all[i].slice(0, eq) === name) {
        return decodeURIComponent(all[i].slice(eq + 1));
      }
    }
    return null;
  }

  /*
   * A short, stable key for a title's path.
   *
   * A cookie name cannot hold a path — separators, spaces and non-ASCII are
   * all out — and encoding one produces a name longer than some browsers
   * accept. A 32-bit hash collides about as often as two files in one house
   * sharing one, which is to say not.
   */
  function keyFor(path) {
    var h = 2166136261;
    for (var i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return PREFIX + h.toString(36);
  }

  /* -------------------------------------------------------------- player */

  function clock(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
  }

  function wirePlayer(video) {
    var key = keyFor(video.getAttribute('data-title') || video.currentSrc || '');
    var saved = parseFloat(getCookie(key) || '0');

    /*
     * Offered, not applied.
     *
     * Seeking on its own the moment the page opens is the behaviour people
     * complain about: somebody who came back to watch the opening again is
     * dropped forty minutes in with no way to tell what happened. The offer
     * costs one tap and is unambiguous.
     */
    if (saved > 30) {
      var bar = document.querySelector('.resume');
      if (bar) {
        bar.hidden = false;
        var where = bar.querySelector('.where');
        if (where) where.textContent = clock(saved);
        var go = bar.querySelector('button');
        if (go) {
          go.addEventListener('click', function () {
            video.currentTime = saved;
            video.play();
            bar.hidden = true;
          });
        }
      }
    }

    /*
     * Written on a timer, not on every `timeupdate`.
     *
     * That event fires three to four times a second, and rewriting a cookie
     * that often is work the browser does on the main thread while a video is
     * decoding. Every five seconds loses at most five seconds.
     */
    var last = 0;
    video.addEventListener('timeupdate', function () {
      var now = video.currentTime;
      if (Math.abs(now - last) < 5) return;
      last = now;
      // Within thirty seconds of the end is finished, not paused part way -
      // and a film that reopens two seconds from its own credits is a worse
      // outcome than one that reopens at the start.
      if (video.duration && video.duration - now < 30) {
        setCookie(key, '0', YEAR);
      } else {
        setCookie(key, String(Math.floor(now)), YEAR);
      }
    });

    video.addEventListener('ended', function () {
      setCookie(key, '0', YEAR);
    });
  }

  /* ----------------------------------------------------------- pass phrase */

  function wirePin(form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = form.querySelector('input');
      var said = form.parentNode.querySelector('.said');
      var phrase = (input.value || '').trim();
      if (!phrase) {
        said.className = 'said bad';
        said.textContent = 'Enter the phrase first.';
        return;
      }

      said.className = 'said';
      said.textContent = 'Checking…';

      fetch('/unlock?pin=' + encodeURIComponent(phrase), { credentials: 'same-origin' })
        .then(function (r) {
          return r.json();
        })
        .then(function (result) {
          if (result && result.age !== null && result.age !== undefined) {
            said.className = 'said good';
            said.textContent = 'Unlocked. Reloading…';
            // The gate runs on the server, so what this browser may see is
            // decided there - the page has to be asked again rather than
            // revealing anything it was already given.
            location.reload();
          } else {
            said.className = 'said bad';
            said.textContent = 'That phrase does not open anything here.';
            input.value = '';
            input.focus();
          }
        })
        .catch(function () {
          said.className = 'said bad';
          said.textContent = 'Could not reach this machine. Try again.';
        });
    });

    // Clearing the error the moment they start over, rather than leaving a
    // red line sitting under a field they are already fixing.
    var input = form.querySelector('input');
    input.addEventListener('input', function () {
      var said = form.parentNode.querySelector('.said');
      if (said.className.indexOf('bad') !== -1) {
        said.className = 'said';
        said.textContent = '';
      }
    });
  }

  /* ------------------------------------------------------------- speed */

  /*
   * How fast this network actually moves a file, measured rather than
   * assumed. The server streams zeros until told to stop; this reads them
   * for a few seconds, then aborts and reports what arrived. Aborting is
   * the point rather than a size limit — a fixed download either finishes
   * too fast to average out jitter on a quick link, or takes unreasonably
   * long on a slow one, and neither answer is what somebody pressing a
   * button wants to wait for.
   */
  function wireSpeedTest(button) {
    var out = button.parentNode.querySelector('.speedresult');
    var DURATION_MS = 4000;

    button.addEventListener('click', function () {
      if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
        out.textContent = 'This browser cannot run the test.';
        return;
      }

      button.disabled = true;
      out.textContent = 'Testing…';

      var controller = new AbortController();
      var started = performance.now();
      var bytes = 0;
      var timer = setInterval(function () {
        var elapsed = (performance.now() - started) / 1000;
        if (elapsed > 0) out.textContent = mbps(bytes, elapsed) + ' — testing…';
      }, 200);

      var finish = function () {
        clearInterval(timer);
        button.disabled = false;
        var elapsed = (performance.now() - started) / 1000;
        if (bytes === 0 || elapsed < 0.05) {
          out.textContent = 'Could not measure — connection interrupted.';
          return;
        }
        out.textContent =
          mbps(bytes, elapsed) + ' (' + mb(bytes) + ' in ' + elapsed.toFixed(1) + 's)';
      };

      fetch('/speedtest', { signal: controller.signal, cache: 'no-store' })
        .then(function (res) {
          var reader = res.body.getReader();
          function pump() {
            return reader.read().then(function (step) {
              if (step.done) return;
              bytes += step.value.length;
              if (performance.now() - started >= DURATION_MS) {
                controller.abort();
                return;
              }
              return pump();
            });
          }
          return pump();
        })
        .catch(function () {
          /* Abort throws too; either way there is bytes and elapsed to report. */
        })
        .then(finish);
    });
  }

  function mbps(bytes, seconds) {
    return ((bytes * 8) / seconds / 1e6).toFixed(1) + ' Mbps';
  }

  function mb(bytes) {
    return (bytes / 1e6).toFixed(0) + ' MB';
  }

  /* ---------------------------------------------------------------- start */

  document.addEventListener('DOMContentLoaded', function () {
    var video = document.querySelector('video[data-title]');
    if (video) wirePlayer(video);

    var form = document.querySelector('.pin form');
    if (form) wirePin(form);

    var speedBtn = document.getElementById('speedtestBtn');
    if (speedBtn) wireSpeedTest(speedBtn);
  });
})();
