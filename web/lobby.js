// lobby.js — the Community page. Read-only chrome over the relay: it shows who's connected right now
// (with what they're mid-game in) and the score tables for every game type, overall and per game.
// Nothing here gates play — it's a scoreboard. Login is OPTIONAL: sign in and you appear in the online
// list and your rows highlight; stay anonymous and you just watch. Both the online list and the scores
// come from the relay as plain names + counts (no identity leaked), so the page needs no privileges.

import { VERSION } from './version.js';
import { createAuth } from './auth.js';
import { AUTH } from './auth-config.js';
import { RelayClient } from './net.js';

const el = (id) => document.getElementById(id);
el('version').textContent = `v${VERSION}`;

// Display metadata for each game type. Unknown keys fall back to the raw key with a generic icon, so a
// game added later (e.g. the 3D cue games going online) shows up without a code change here.
const GAME_META = {
  chess: { icon: '♞', label: 'Chess' },
  draughts: { icon: '⛀', label: 'Draughts' },
  backgammon: { icon: '🎲', label: 'Backgammon' },
  othello: { icon: '⚫', label: 'Othello' },
  connect4: { icon: '🔴', label: 'Connect 4' },
  dice: { icon: '🎲', label: 'Dice' },
  snooker: { icon: '🎱', label: 'Snooker' },
  pool: { icon: '🎱', label: '8-Ball' },
  nineball: { icon: '🎱', label: '9-Ball' },
  carrom: { icon: '⚪', label: 'Carrom' },
};
const meta = (key) => GAME_META[key] || { icon: '🎮', label: key };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Community display name: first name + the first two letters of the surname (e.g. "Jane Do"). Mirrors
// server/roster.js exactly so our own row still highlights; falls back to the full name/username.
const communityName = (first, last, fallback) => {
  const f = (first && first.trim()) || '';
  const l = (last && last.trim()) || '';
  if (f && l) return `${f} ${l.slice(0, 2)}`;
  return f || (fallback && String(fallback).trim()) || null;
};

// --- multiplayer reachability light (bottom-left, matches the other pages) ----------------------
const netstat = el('netstat');
function setNetStat(state, label) {
  netstat.classList.remove('online', 'connecting', 'offline');
  netstat.classList.add('show', state);
  el('netstat-label').textContent = label;
}
setNetStat('connecting', 'Connecting…');

// --- optional login -----------------------------------------------------------------------------
// If the viewer is signed in (here or on any other compendium page — the token is shared in
// sessionStorage), we authenticate the relay so they appear in "online now" and their own rows glow.
const auth = createAuth(AUTH);
let myName = null;  // our full login name — matches the score tables (recorded from the token)
let myShort = null; // our Community roster name (first + surname initials) — matches the members list
function updateAuthUI() {
  if (!auth.enabled) { el('authbar').style.display = 'none'; el('join').classList.remove('show'); return; }
  const user = auth.getUser();
  // Signed in → a compact chip + Log out, top-right. Signed out → the friendly "join in" card, so
  // logging in OR creating an account is a single obvious click.
  el('authbar').style.display = user ? '' : 'none';
  el('join').classList.toggle('show', !user);
  el('userchip').textContent = user ? `Signed in as ${user.name}` : 'Playing offline';
  el('login').style.display = 'none';       // login now lives in the join card when signed out
  el('logout').style.display = user ? '' : 'none';
}
el('logout').addEventListener('click', () => auth.logout());
el('join-login').addEventListener('click', () => auth.login());
el('join-register').addEventListener('click', () => auth.register()); // straight to the sign-up form

// --- relay + data -------------------------------------------------------------------------------
const relay = new RelayClient({});
let scores = null;   // last { overall, byGame, players }
let activeTab = 'overall';

relay.on('reconnecting', () => setNetStat('connecting', 'Connecting…'));
relay.on('neterror', () => setNetStat('offline', 'Multiplayer offline'));
relay.on('close', () => setNetStat('offline', 'Multiplayer offline'));
relay.on('members', renderMembers);
relay.on('scores', (m) => { scores = m; renderTabs(); renderScores(); });

async function boot() {
  updateAuthUI();
  if (auth.enabled) { try { await auth.handleRedirect(); } catch { /* stay anonymous */ } updateAuthUI(); }
  try {
    await relay.connect();
    setNetStat('online', 'Multiplayer online');
    // Authenticate if we have a token, so we count as signed-in and can highlight our own rows.
    if (auth.enabled) {
      const token = await auth.getAccessToken();
      const user = auth.getUser();
      if (token) {
        myName = user?.name ?? null;
        myShort = communityName(user?.given_name, user?.family_name, user?.name);
        try { await relay.authenticate(token); } catch { /* anon is fine */ }
      }
    }
    refreshAll();
  } catch {
    setNetStat('offline', 'Multiplayer offline');
    el('online-sub').textContent = 'Server unreachable — showing nothing to see here yet.';
  }
}

function refreshAll() { relay.requestMembers(); relay.requestScores(); }
// Presence (who's online) changes fast, so poll the membership briskly; scores change only when a
// game ends, so slower.
const onlineTimer = setInterval(() => relay.requestMembers(), 4000);
const scoresTimer = setInterval(() => relay.requestScores(), 20000);
window.addEventListener('beforeunload', () => { clearInterval(onlineTimer); clearInterval(scoresTimer); });
el('online-refresh').addEventListener('click', () => relay.requestMembers());
el('scores-refresh').addEventListener('click', () => relay.requestScores());

// --- render: registered members -----------------------------------------------------------------
// Shows EVERYONE who has an account (first names), not just who's online. Online players float to the
// top with a live dot and a "what they're playing" badge; offline members sit below, dimmed, with
// their win/played tally. Anonymous visitors are counted but stay unnamed.
function renderMembers(m) {
  const members = m.members ?? [];
  const online = m.online ?? members.filter((u) => u.online).length;
  const total = m.registered ?? members.length;
  const anon = Math.max(0, (m.count ?? 0) - online);
  el('online-n').textContent = online;
  el('online-sub').textContent = total
    ? `${total} registered · ${online} online${anon ? ` · ${anon} anon` : ''}`
    : `${m.count ?? 0} here — no registered players yet`;
  const people = el('people');
  if (!members.length) {
    people.innerHTML = `<li class="empty">No registered players yet. Create an account on any game page and your first name shows up here.</li>`;
    return;
  }
  people.innerHTML = members.map((u) => {
    const isMe = myShort && u.name.toLowerCase() === myShort.toLowerCase();
    const dot = u.online ? `<span class="live-dot"></span>` : `<span class="off-dot"></span>`;
    const badge = u.online && u.playing
      ? `<span class="badge">${meta(u.playing).icon} ${esc(meta(u.playing).label)}</span>`
      : (u.games ? `<span class="stat">${u.wins}/${u.games}</span>` : '');
    return `<li class="${isMe ? 'me' : ''}${u.online ? '' : ' offline'}">${dot}<span class="nm">${esc(u.name)}</span>${badge}</li>`;
  }).join('');
}

// --- render: score tables -----------------------------------------------------------------------
function renderTabs() {
  const tabs = el('tabs');
  const keys = Object.keys(scores?.byGame ?? {});
  if (!keys.includes(activeTab) && activeTab !== 'overall') activeTab = 'overall';
  const btn = (key, label, icon) =>
    `<button class="tab ${activeTab === key ? 'active' : ''}" data-tab="${esc(key)}">${icon ? icon + ' ' : ''}${esc(label)}</button>`;
  tabs.innerHTML = btn('overall', 'Overall', '🏆') + keys.map((k) => btn(k, meta(k).label, meta(k).icon)).join('');
  tabs.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    activeTab = b.dataset.tab; renderTabs(); renderScores();
  }));
}

function renderScores() {
  const body = el('scores-body');
  if (!scores) { body.innerHTML = `<div class="empty">Loading…</div>`; return; }
  const rows = activeTab === 'overall' ? scores.overall : (scores.byGame[activeTab] ?? []);
  if (!rows.length) {
    body.innerHTML = `<div class="empty">No games recorded yet${activeTab === 'overall' ? '' : ` for ${esc(meta(activeTab).label)}`}. Play an online game while signed in and the winner lands here.</div>`;
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const tr = rows.map((r, i) => {
    const isMe = myName && r.name.toLowerCase() === myName.toLowerCase();
    const rank = medals[i] ? `<span class="medal">${medals[i]}</span>` : (i + 1);
    const pct = r.games ? Math.round((r.wins / r.games) * 100) : 0;
    return `<tr class="${isMe ? 'me' : ''}"><td class="rk">${rank}</td><td class="nm">${esc(r.name)}</td>`
      + `<td class="num">${r.wins}</td><td class="num">${r.games}</td><td class="num">${pct}%</td></tr>`;
  }).join('');
  body.innerHTML = `<table class="scores"><thead><tr>`
    + `<th class="rk"></th><th>Player</th><th class="num">Won</th><th class="num">Played</th><th class="num">Win&nbsp;%</th>`
    + `</tr></thead><tbody>${tr}</tbody></table>`;
}

boot();
