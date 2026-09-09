/**
 * Copying text, on platforms that disagree about how.
 *
 * `navigator.clipboard` needs a secure context. The desktop webview provides
 * one; the Android WebView serving from `tauri://localhost` does not, so every
 * copy button in the app silently did nothing on a phone. The Tauri plugin
 * goes through the OS clipboard instead and works on all four platforms.
 *
 * The browser path stays for the simulator, with the old `execCommand` route
 * behind it — deprecated, but it is the only thing that works in a page served
 * over plain HTTP, which is exactly where the modern API refuses.
 */
import { isTauri } from './bridge';

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  if (isTauri()) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return true;
    } catch {
      // Fall through: a desktop webview may still have the web API.
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied, or not a secure context.
  }

  // Last resort. Deprecated everywhere and still the only thing that works
  // when the page is not a secure context.
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Off-screen rather than hidden: `display: none` cannot be selected.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export async function readText(): Promise<string> {
  if (isTauri()) {
    try {
      const { readText: read } = await import('@tauri-apps/plugin-clipboard-manager');
      return (await read()) ?? '';
    } catch {
      // Fall through to the web API.
    }
  }
  try {
    return (await navigator.clipboard?.readText()) ?? '';
  } catch {
    return '';
  }
}
