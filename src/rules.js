// rules.js — pure snooker frame rules. No physics, no geometry: it consumes a classified
// shot outcome (what was contacted / potted, by colour) and mutates an abstract frame state.
// Unit-tested directly. game.js owns the ball objects/positions and asks rules.js what to do.
//
// Modelled (singles, simplified but faithful):
//   • Reds (1 pt) are the ball-on; pot a red → then a nominated COLOUR (2–7), which is
//     re-spotted; repeat until reds are gone. The colour AFTER the last red may be any colour.
//   • Then clear the colours in ascending order (yellow→black); these stay down once potted.
//   • Pot the ball-on → score it and continue. Pot nothing legal → turn passes ("miss").
//   • Foul (wrong/no first contact, wrong ball potted, or cue in-off): opponent scores the
//     penalty = max(4, value of the ball-on, values of balls wrongly involved). Reds potted on
//     a foul stay down (no score); colours potted on a foul are re-spotted; cue returns in-hand.
//   • Frame ends when the black is potted with nothing else left (or no balls remain).
//
// Not modelled yet (TODO): free ball after a snooker, "respotted black" tie, miss-rule recalls.

export const VALUES = { red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7 };
export const COLOUR_ORDER = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];

export function newFrame(reds = 15) {
  return {
    reds,
    colours: { yellow: true, green: true, brown: true, blue: true, pink: true, black: true },
    scores: [0, 0],
    turn: 0, // 0 | 1
    onColour: false, // a red has been potted; a colour is now the ball-on
    ballInHand: true, // cue ball to be placed in the D (break, or after an in-off)
    frameOver: false,
    winner: null, // 0 | 1 | 'tie'
    message: 'Player 1 to break',
  };
}

const cap = (c) => c[0].toUpperCase() + c.slice(1);
const playerName = (t) => `Player ${t + 1}`;
export const lowestColour = (state) => COLOUR_ORDER.find((c) => state.colours[c]) ?? null;

// The colour/category that is legally "on" right now.
//   'red'        — must hit/pot a red
//   'any-colour' — a red was just potted (or it's the colour after the last red): any colour
//   <colour>     — clearing phase: the named lowest colour
export function ballOn(state) {
  if (state.onColour) return 'any-colour';
  if (state.reds > 0) return 'red';
  return lowestColour(state);
}

const isColour = (c) => c in VALUES && c !== 'red';

// Apply a classified outcome. info = { firstContact: colour|null, potted: colour[], cuePotted }
// `potted` lists every object ball potted this shot (excludes the cue ball). Mutates state.
export function applyOutcome(state, info) {
  if (state.frameOver) return { events: ['Frame over'], foul: false, continues: false, message: state.message };
  const { firstContact = null, potted = [], cuePotted = false } = info;
  const on = ballOn(state);
  const me = state.turn;
  const opp = 1 - me;
  const events = [];

  // re-spot / removal decisions returned to game.js
  const respot = []; // colours to put back on their spots
  const remove = []; // balls removed from the table (potted legally / reds always)

  let foul = false;
  let penalty = 4;
  const raise = (val) => {
    penalty = Math.max(penalty, val);
  };

  // --- legality of the FIRST contact ---
  if (firstContact === null) {
    foul = true;
    events.push('Foul: no ball hit');
    raise(on !== 'any-colour' && on ? VALUES[on] : 4);
  } else if (on === 'red' && firstContact !== 'red') {
    foul = true;
    raise(VALUES[firstContact]);
    events.push(`Foul: hit ${firstContact} first, on red`);
  } else if (on === 'any-colour' && firstContact === 'red') {
    foul = true;
    raise(4);
    events.push('Foul: hit a red, on a colour');
  } else if (isColour(on) && firstContact !== on) {
    foul = true;
    raise(VALUES[on]);
    raise(VALUES[firstContact]);
    events.push(`Foul: hit ${firstContact} first, on ${on}`);
  }

  // --- classify potted balls ---
  const reds = potted.filter((c) => c === 'red');
  const cols = potted.filter(isColour);
  if (on === 'red') {
    if (cols.length) {
      foul = true;
      cols.forEach((c) => raise(VALUES[c]));
      events.push(`Foul: potted ${cols.join(', ')} on red`);
    }
    if (reds.length > 1 && !foul) events.push(`Potted ${reds.length} reds`);
  } else if (on === 'any-colour') {
    if (reds.length) {
      foul = true;
      raise(4);
      events.push('Foul: potted a red on a colour');
    }
    if (cols.length > 1) {
      foul = true;
      cols.forEach((c) => raise(VALUES[c]));
      events.push('Foul: potted more than one colour');
    }
  } else if (isColour(on)) {
    const wrong = cols.filter((c) => c !== on);
    if (wrong.length || reds.length) {
      foul = true;
      wrong.forEach((c) => raise(VALUES[c]));
      if (reds.length) raise(1);
      events.push('Foul: potted the wrong ball');
    }
  }

  if (cuePotted) {
    foul = true;
    raise(on && on !== 'any-colour' ? VALUES[on] : 4);
    events.push('Foul: cue ball potted (in-off)');
  }

  // --- resolve ---
  if (foul) {
    // reds potted go down with no score; colours potted are re-spotted; cue returns to D
    for (let i = 0; i < reds.length; i++) {
      state.reds -= 1;
      remove.push('red');
    }
    for (const c of cols) respot.push(c);
    if (cuePotted) state.ballInHand = true;
    state.scores[opp] += penalty;
    state.onColour = false;
    state.turn = opp;
    events.push(`${playerName(opp)} + ${penalty} (foul)`);
    return finish(state, events, false, foul, { respot, remove });
  }

  // legal shot
  let scored = 0;
  let pottedSomething = potted.length > 0;

  if (on === 'red') {
    for (const _ of reds) {
      state.reds -= 1;
      scored += VALUES.red;
      remove.push('red');
    }
    if (reds.length) state.onColour = true;
  } else if (on === 'any-colour') {
    if (cols.length === 1) {
      const c = cols[0];
      scored += VALUES[c];
      // A colour potted on 'any-colour' is always re-spotted — both while reds remain AND for
      // the colour taken after the last red (clearing only begins once reds === 0 and onColour
      // is cleared, which the next ballOn() reflects).
      respot.push(c);
      state.onColour = false;
    }
  } else if (isColour(on)) {
    if (cols.length === 1 && cols[0] === on) {
      scored += VALUES[on];
      state.colours[on] = false;
      remove.push(on);
    }
  }

  state.scores[me] += scored;
  if (scored) events.push(`${playerName(me)} + ${scored}`);

  const continues = pottedSomething; // any legal pot keeps the player at the table
  if (!continues) {
    state.onColour = false; // a missed shot ends the break — the incoming player is back on a red
    state.turn = opp;
    events.push(`${playerName(me)} missed`);
  }
  return finish(state, events, continues, false, { respot, remove });
}

function frameEnded(state) {
  return state.reds === 0 && COLOUR_ORDER.every((c) => !state.colours[c]);
}

function finish(state, events, continues, foul, spots) {
  if (frameEnded(state)) {
    state.frameOver = true;
    const [a, b] = state.scores;
    state.winner = a === b ? 'tie' : a > b ? 0 : 1;
    events.push(state.winner === 'tie' ? `Frame tied ${a}–${b}` : `${playerName(state.winner)} wins the frame ${Math.max(a, b)}–${Math.min(a, b)}`);
  } else {
    events.push(continues ? `${playerName(state.turn)} continues` : `${playerName(state.turn)} to play`);
  }
  state.message = events.join(' · ');
  return { events, foul, continues, respot: spots.respot, remove: spots.remove, message: state.message };
}
