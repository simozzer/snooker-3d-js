// klondike.js — Klondike Solitaire (the classic "Patience"). Pure client-side, no backend: a solo game
// that drops straight into the compendium's offline build. Seven tableau piles built DOWN in alternating
// colours; four foundations built UP by suit from the Ace; a stock you deal to the waste (draw 1 or 3,
// unlimited redeals). Interaction is click-to-pick then click-to-place, with double-click and a Collect
// button as shortcuts to the foundations. Win by moving all 52 cards home.

import { VERSION } from '../../version.js';

const SUITS = ['S', 'H', 'D', 'C'];              // foundation order matches the ♠♥♦♣ slots in the HTML
const GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const isRed = (s) => s === 'H' || s === 'D';
const el = (id) => document.getElementById(id);

let stock, waste, foundations, tableau, drawCount, moves, selected, history;

// --- setup ------------------------------------------------------------------------------------------
function shuffled() {
  const deck = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) deck.push({ r, s, up: false });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

function deal() {
  const deck = shuffled();
  tableau = Array.from({ length: 7 }, () => []);
  for (let col = 0; col < 7; col++) {
    for (let k = 0; k <= col; k++) { const c = deck.pop(); c.up = (k === col); tableau[col].push(c); }
  }
  stock = deck;              // remaining 24, all face down
  waste = []; foundations = { S: [], H: [], D: [], C: [] };
  moves = 0; selected = null; history = [];
}

const snapshot = () => history.push(JSON.stringify({ stock, waste, foundations, tableau, moves }));
function undo() {
  const s = history.pop(); if (!s) return;
  ({ stock, waste, foundations, tableau, moves } = JSON.parse(s));
  selected = null; render();
}

// A movable tableau group (cards[i..end]) must be a valid descending, alternating-colour run.
function isSequence(cards) {
  for (let k = 0; k < cards.length - 1; k++) {
    if (cards[k].r !== cards[k + 1].r + 1 || isRed(cards[k].s) === isRed(cards[k + 1].s)) return false;
  }
  return true;
}

// --- legality ---------------------------------------------------------------------------------------
const foundationTop = (s) => foundations[s][foundations[s].length - 1];
function canToFoundation(card) {
  const top = foundationTop(card.s);
  return top ? top.r === card.r - 1 : card.r === 1;
}
function canToTableau(head, destPile) {
  if (!destPile.length) return head.r === 13;                 // only a King starts an empty column
  const top = destPile[destPile.length - 1];
  return top.up && top.r === head.r + 1 && isRed(top.s) !== isRed(head.s);
}

// The cards a selection would move, and where they come from (so we can splice them out on drop).
function movingCards() {
  if (!selected) return [];
  if (selected.from === 'waste') return waste.length ? [waste[waste.length - 1]] : [];
  if (selected.from === 'foundation') { const p = foundations[selected.suit]; return p.length ? [p[p.length - 1]] : []; }
  return tableau[selected.pile].slice(selected.index); // tableau group
}
function removeSelectedFromSource() {
  if (selected.from === 'waste') waste.pop();
  else if (selected.from === 'foundation') foundations[selected.suit].pop();
  else {
    tableau[selected.pile].length = selected.index;
    const src = tableau[selected.pile];
    if (src.length && !src[src.length - 1].up) src[src.length - 1].up = true; // flip newly exposed card
  }
}

// --- moves ------------------------------------------------------------------------------------------
function moveToFoundation() {
  const cards = movingCards();
  if (cards.length !== 1 || !canToFoundation(cards[0])) return false;
  snapshot();
  const card = cards[0];
  removeSelectedFromSource();
  foundations[card.s].push(card);
  moves += 1; selected = null;
  return true;
}
function moveToTableau(destIdx) {
  const cards = movingCards();
  if (!cards.length || !isSequence(cards) || !canToTableau(cards[0], tableau[destIdx])) return false;
  // Can't drop a group back onto the very pile it came from.
  if (selected.from === 'tableau' && selected.pile === destIdx) return false;
  snapshot();
  removeSelectedFromSource();
  tableau[destIdx].push(...cards);
  moves += 1; selected = null;
  return true;
}

// Stock: deal drawCount to the waste; when empty, recycle the waste back (unlimited redeals).
function drawStock() {
  if (!stock.length && !waste.length) return;
  snapshot();
  if (!stock.length) {
    stock = waste.reverse().map((c) => ({ ...c, up: false })); waste = [];
  } else {
    for (let k = 0; k < drawCount && stock.length; k++) { const c = stock.pop(); c.up = true; waste.push(c); }
  }
  moves += 1; selected = null;
}

// Sweep every card that can legally go home, repeatedly, as one undo-able step.
function collect() {
  let moved = false, progress = true;
  const before = JSON.stringify({ stock, waste, foundations, tableau, moves });
  while (progress) {
    progress = false;
    const tops = [];
    if (waste.length) tops.push(() => { const c = waste[waste.length - 1]; if (canToFoundation(c)) { waste.pop(); foundations[c.s].push(c); return true; } return false; });
    for (let i = 0; i < 7; i++) tops.push(() => {
      const p = tableau[i]; if (!p.length) return false; const c = p[p.length - 1];
      if (c.up && canToFoundation(c)) { p.pop(); if (p.length && !p[p.length - 1].up) p[p.length - 1].up = true; foundations[c.s].push(c); return true; }
      return false;
    });
    for (const t of tops) if (t()) { progress = true; moved = true; moves += 1; }
  }
  if (moved) { history.push(before); selected = null; }
  return moved;
}

const won = () => SUITS.every((s) => foundations[s].length === 13);

// --- interaction ------------------------------------------------------------------------------------
// One resolver for every click. With nothing held, a click PICKS UP; with a selection, a click PLACES.
function handleClick(loc) {
  if (loc.kind === 'stock') { drawStock(); render(); return; }

  if (!selected) {
    if (loc.kind === 'waste' && waste.length) selected = { from: 'waste' };
    else if (loc.kind === 'foundation' && foundations[loc.suit].length) selected = { from: 'foundation', suit: loc.suit };
    else if (loc.kind === 'tableau') {
      const card = tableau[loc.pile][loc.index];
      if (card && card.up && isSequence(tableau[loc.pile].slice(loc.index))) selected = { from: 'tableau', pile: loc.pile, index: loc.index };
    }
    render(); return;
  }

  // A selection is active — clicking the same card cancels it.
  if (loc.kind === selected.from && loc.pile === selected.pile && loc.index === selected.index && loc.suit === selected.suit) {
    selected = null; render(); return;
  }
  let ok = false;
  if (loc.kind === 'foundation' || (loc.kind === 'tableau-to-foundation')) ok = moveToFoundation();
  else if (loc.kind === 'tableau' || loc.kind === 'tableau-empty') ok = moveToTableau(loc.pile);
  if (!ok) selected = null; // an illegal target just drops the selection
  render();
}

// Double-click shortcut: send this card straight home if it's a single, accessible top.
function tryAutoFoundation(loc) {
  if (loc.kind === 'waste') selected = waste.length ? { from: 'waste' } : null;
  else if (loc.kind === 'tableau') {
    const p = tableau[loc.pile]; if (loc.index !== p.length - 1) return; // only the top card
    selected = { from: 'tableau', pile: loc.pile, index: loc.index };
  } else return;
  if (moveToFoundation()) render(); else { selected = null; render(); }
}

// --- rendering --------------------------------------------------------------------------------------
function cardEl(card, extra = {}) {
  const d = document.createElement('div');
  if (!card.up) { d.className = 'card down'; return decorate(d, extra); }
  d.className = `card face ${isRed(card.s) ? 'red' : 'black'}`;
  d.innerHTML = `<span class="corner">${RANKS[card.r]}${GLYPH[card.s]}</span><span class="pip">${GLYPH[card.s]}</span>`;
  return decorate(d, extra);
}
function decorate(d, extra) {
  if (extra.sel) d.classList.add('sel');
  if (extra.i != null) d.style.setProperty('--i', extra.i);
  if (extra.j != null) d.style.setProperty('--j', extra.j);
  if (extra.onClick) d.addEventListener('click', (e) => { e.stopPropagation(); extra.onClick(); });
  if (extra.onDbl) d.addEventListener('dblclick', (e) => { e.stopPropagation(); extra.onDbl(); });
  return d;
}
const selEquals = (a) => selected && selected.from === a.from && selected.pile === a.pile && selected.index === a.index && selected.suit === a.suit;

function render() {
  // stock
  const stockEl = el('stock');
  stockEl.className = 'slot stock'; stockEl.innerHTML = '';
  stockEl.onclick = () => handleClick({ kind: 'stock' });
  if (stock.length) stockEl.appendChild(cardEl({ up: false }));
  else stockEl.innerHTML = '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.3);font-size:calc(var(--cw)*0.5)">↺</span>';

  // waste (fan the last few in draw-3; only the very top is playable)
  const wasteEl = el('waste'); wasteEl.className = ''; wasteEl.innerHTML = '';
  const fan = document.createElement('div'); fan.className = 'waste-fan';
  const show = waste.slice(-Math.min(3, Math.max(1, drawCount)));
  show.forEach((c, k) => {
    const top = k === show.length - 1;
    fan.appendChild(cardEl(c, { j: k, sel: top && selEquals({ from: 'waste' }),
      onClick: top ? () => handleClick({ kind: 'waste' }) : null, onDbl: top ? () => tryAutoFoundation({ kind: 'waste' }) : null }));
  });
  wasteEl.appendChild(fan);

  // foundations
  document.querySelectorAll('.foundation-slot').forEach((slot, i) => {
    const suit = SUITS[i]; slot.innerHTML = ''; slot.className = 'foundation-slot';
    slot.onclick = () => handleClick({ kind: 'foundation', suit });
    const pile = foundations[suit];
    if (pile.length) slot.appendChild(cardEl(pile[pile.length - 1], { sel: selEquals({ from: 'foundation', suit }), onClick: () => handleClick({ kind: 'foundation', suit }) }));
    else { const s = document.createElement('div'); s.className = 'slot empty-foundation'; s.dataset.suit = GLYPH[suit]; slot.appendChild(s); }
  });

  // tableau
  const tab = el('tableau'); tab.innerHTML = '';
  tableau.forEach((pile, i) => {
    const col = document.createElement('div');
    col.className = pile.length ? 'pile' : 'pile empty';
    col.onclick = () => handleClick({ kind: pile.length ? 'tableau' : 'tableau-empty', pile: i, index: pile.length });
    pile.forEach((card, j) => {
      const held = selected && selected.from === 'tableau' && selected.pile === i && j >= selected.index;
      col.appendChild(cardEl(card, { i: j, sel: held,
        onClick: () => handleClick({ kind: 'tableau', pile: i, index: j }),
        onDbl: () => tryAutoFoundation({ kind: 'tableau', pile: i, index: j }) }));
    });
    tab.appendChild(col);
  });

  el('moves').textContent = moves;
  el('undo').disabled = history.length === 0;
  el('msg').textContent = won() ? '🎉 You won! Every card home.' : '';
}

// --- controls ---------------------------------------------------------------------------------------
function setDraw(n) {
  drawCount = n;
  el('draw1').classList.toggle('active', n === 1);
  el('draw3').classList.toggle('active', n === 3);
}
el('draw1').addEventListener('click', () => { setDraw(1); });
el('draw3').addEventListener('click', () => { setDraw(3); });
el('collect').addEventListener('click', () => { if (collect()) render(); });
el('undo').addEventListener('click', undo);
el('newgame').addEventListener('click', () => { deal(); render(); });

el('build').textContent = `Klondike · v${VERSION}`;
setDraw(1);
deal();
render();
