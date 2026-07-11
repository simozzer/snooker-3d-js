// home.js — the compendium landing page's small bits of chrome: the build stamp, a multiplayer
// server online/offline light (bottom-left, same as the game pages), and an OPTIONAL login control.
// Nothing here gates the games — the cards are plain links that always work. Login is a choice, and
// staying offline needs no action. Login state (the token) lives in sessionStorage, so signing in
// here carries into every game page on the same origin.

import { VERSION } from './version.js';
import { createAuth } from './auth.js';
import { AUTH } from './auth-config.js';
import { RelayClient } from './net.js';

const el = (id) => document.getElementById(id);
el('version').textContent = `v${VERSION}`;

// --- multiplayer reachability light -------------------------------------------------------------
const netstat = el('netstat');
function setNetStat(state, label) {
  netstat.classList.remove('online', 'connecting', 'offline');
  netstat.classList.add('show', state);
  el('netstat-label').textContent = label;
}
setNetStat('connecting', 'Connecting…');
const relay = new RelayClient({});
relay.on('welcome', () => setNetStat('online', 'Multiplayer online'));
relay.on('reconnecting', () => setNetStat('connecting', 'Connecting…'));
relay.on('neterror', () => setNetStat('offline', 'Multiplayer offline'));
relay.connect().then(() => setNetStat('online', 'Multiplayer online')).catch(() => setNetStat('offline', 'Multiplayer offline'));

// --- optional login -----------------------------------------------------------------------------
const auth = createAuth(AUTH);
function updateAuthUI() {
  if (!auth.enabled) { el('authbar').style.display = 'none'; return; } // no login configured → nothing to show
  el('authbar').style.display = '';
  const user = auth.getUser();
  el('userchip').textContent = user ? `Signed in as ${user.name}` : 'Playing offline';
  el('login').style.display = user ? 'none' : '';
  el('logout').style.display = user ? '' : 'none';
}
el('login').addEventListener('click', () => auth.login());   // → Keycloak (Google/Microsoft/Facebook)
el('logout').addEventListener('click', () => auth.logout());
(async () => {
  updateAuthUI();
  if (auth.enabled) { try { await auth.handleRedirect(); } catch { /* stay anonymous */ } updateAuthUI(); }
})();
