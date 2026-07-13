// config.local.js — per-DEPLOYMENT overrides, loaded as a plain script BEFORE the app modules on every
// online-capable page (it must run first so config.js sees the values). This committed copy is NEUTRAL:
// it names no host, enables no login, and is safe to serve from any CDN. The app runs fully anonymous
// and offline-capable exactly as-is.
//
// To switch online features on, a deployment REPLACES this file in place (it lives with the served
// files, NOT in the CDN artifact you publish widely) with something like:
//
//   window.__GAMES_CONFIG__ = {
//     authIssuer: 'https://YOUR-HOST/auth/realms/games',  // turns login on, points it at your Keycloak
//     // relayUrl: 'wss://YOUR-HOST/relay',                // only if the relay isn't same-origin
//   };
//
// Failure mode is safe: if this file is missing or left neutral, login is simply off — never broken.
window.__GAMES_CONFIG__ = window.__GAMES_CONFIG__ || {};
