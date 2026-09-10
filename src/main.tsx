import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Hud } from './hud/Hud';
import './index.css';

/**
 * Two windows, one bundle.
 *
 * The corner popup is a separate OS window and therefore a separate page load,
 * but it is the same application and nearly all of the same code. A hash costs
 * nothing and keeps it that way; a second entry point would mean a second
 * build to keep in step.
 *
 * The window's own label is checked as well as the hash. Tauri builds the URL
 * for a window from a path, and a fragment is not something it promises to
 * carry through untouched — whereas the label is the one thing a window is
 * certain to know about itself. Getting this wrong would put the entire
 * application, network services and all, inside a 340-pixel popup.
 */
function isHud(): boolean {
  if (window.location.hash === '#hud') return true;
  try {
    const internals = (window as unknown as Record<string, any>).__TAURI_INTERNALS__;
    return internals?.metadata?.currentWindow?.label === 'hud';
  } catch {
    return false;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isHud() ? <Hud /> : <App />}</React.StrictMode>,
);
