// stats.js — per-player game stats (games played, wins), keyed by the OIDC `sub` claim so they follow
// a real identity, not a socket. Pure in-memory logic plus an injectable `persist(snapshot)` — the
// relay wires that to an atomic JSON file write and seeds `initial` from disk on boot. Anonymous
// players (no sub) are never recorded. This backs the invite gate ("played N games") and the leaderboard.

export class Stats {
  constructor({ initial = {}, persist = () => {}, now = () => Date.now() } = {}) {
    this._m = new Map(Object.entries(initial || {}));
    this._persist = persist;
    this._now = now;
  }

  // Current totals for a player (zeros if unseen). Never throws on unknown/undefined sub.
  get(sub) {
    const r = sub && this._m.get(sub);
    return r ? { games: r.games, wins: r.wins, name: r.name ?? null } : { games: 0, wins: 0, name: null };
  }

  // Record one completed game for a player. `won` bumps their win count. `game` (optional) is the
  // game type (chess, othello, …) so we can also keep a per-game breakdown for the score tables.
  // Returns the new OVERALL totals. Older snapshots without a `byGame` map upgrade lazily on write.
  recordGame(sub, name, won = false, game = null) {
    if (!sub) return { games: 0, wins: 0 };
    const r = this._m.get(sub) || { games: 0, wins: 0, name: name ?? null, firstSeen: this._now() };
    r.games += 1;
    if (won) r.wins += 1;
    if (name) r.name = name;
    r.lastSeen = this._now();
    if (game) {
      if (!r.byGame) r.byGame = {};
      const g = r.byGame[game] || { games: 0, wins: 0 };
      g.games += 1;
      if (won) g.wins += 1;
      r.byGame[game] = g;
    }
    this._m.set(sub, r);
    this._persist(this.snapshot());
    return { games: r.games, wins: r.wins };
  }

  // Plain object for persistence (sub → record).
  snapshot() { return Object.fromEntries(this._m); }

  // Leaderboard: top N by wins, then games as a tiebreak. Only players with ≥1 game.
  top(n = 10) {
    return [...this._m.values()]
      .filter((r) => r.games > 0)
      .sort((a, b) => b.wins - a.wins || b.games - a.games)
      .slice(0, n)
      .map((r) => ({ name: r.name ?? 'player', games: r.games, wins: r.wins }));
  }

  // Top N players for ONE game type (chess, othello, …), same ranking as `top`. Players who've never
  // played that game are excluded. Empty array for an unseen game.
  topByGame(game, n = 10) {
    return [...this._m.values()]
      .filter((r) => r.byGame?.[game]?.games > 0)
      .map((r) => ({ name: r.name ?? 'player', games: r.byGame[game].games, wins: r.byGame[game].wins }))
      .sort((a, b) => b.wins - a.wins || b.games - a.games)
      .slice(0, n);
  }

  // The whole score board in one shot, for the Community page: the overall top N, a per-game map
  // (only game types with recorded results appear), and how many distinct players are registered.
  board(n = 10) {
    const gameKeys = new Set();
    for (const r of this._m.values()) if (r.byGame) for (const k of Object.keys(r.byGame)) gameKeys.add(k);
    const byGame = {};
    for (const k of [...gameKeys].sort()) byGame[k] = this.topByGame(k, n);
    const players = [...this._m.values()].filter((r) => r.games > 0).length;
    return { overall: this.top(n), byGame, players };
  }
}
