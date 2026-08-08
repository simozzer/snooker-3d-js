// version.js — the single source of truth for the build number shown top-left on every screen
// (the compendium landing page, the 3D cue tables, and the board games). Bump this one line to
// re-stamp every screen at once. (Keep the VERSION in /sw.js in step so returning visitors get the
// fresh build offline.)
export const VERSION = '1.56';

// Offline support: register the service worker. Every screen imports this module to stamp the version,
// so this one line makes the whole site installable+offline. Guarded and best-effort — the site works
// perfectly without it, and registration never blocks or throws into the page.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof location !== 'undefined' && location.protocol.startsWith('http')) {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
