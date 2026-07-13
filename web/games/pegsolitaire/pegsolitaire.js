// pegsolitaire.js — English-cross (33-hole) peg solitaire. Pure client-side, no backend: a solo puzzle
// that fits the compendium's offline build as-is. The board is a 7x7 grid with the four 2x2 corners
// removed; a move jumps a peg orthogonally over an adjacent peg into an empty hole two away, removing
// the jumped peg. You win by reducing the 32 starting pegs to one — perfectly, that one sits in the centre.

import { VERSION } from '../../version.js';

const SIZE = 7;
const CENTRE = 3;
const el = (id) => document.getElementById(id);

// A cell is part of the cross if it's on the 7x7 grid and NOT in one of the four 2x2 corner blocks.
// (The bounds check matters: a jump target can land off-grid, and valid() guards those array accesses.)
const valid = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && !((r < 2 || r > 4) && (c < 2 || c > 4));

// State: board[r][c] is 'peg' | 'empty' | null(off-board). history holds snapshots for undo.
let board, moves, selected, history;

function fresh() {
  board = Array.from({ length: SIZE }, (_, r) =>
    Array.from({ length: SIZE }, (_, c) => (!valid(r, c) ? null : (r === CENTRE && c === CENTRE ? 'empty' : 'peg'))));
  moves = 0; selected = null; history = [];
}

const clone = (b) => b.map((row) => row.slice());
const pegCount = () => board.flat().filter((v) => v === 'peg').length;

// The four orthogonal jumps from (r,c): each is [landingRow, landingCol, jumpedRow, jumpedCol].
const JUMPS = [[-2, 0], [2, 0], [0, -2], [0, 2]];
function legalTargetsFrom(r, c) {
  if (board[r]?.[c] !== 'peg') return [];
  const out = [];
  for (const [dr, dc] of JUMPS) {
    const tr = r + dr, tc = c + dc, mr = r + dr / 2, mc = c + dc / 2;
    if (valid(tr, tc) && board[tr][tc] === 'empty' && board[mr][mc] === 'peg') out.push({ tr, tc, mr, mc });
  }
  return out;
}
const anyMoves = () => {
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (legalTargetsFrom(r, c).length) return true;
  return false;
};

function jump(r, c, t) {
  history.push({ board: clone(board), moves });
  board[r][c] = 'empty';
  board[t.mr][t.mc] = 'empty';
  board[t.tr][t.tc] = 'peg';
  moves += 1;
  selected = null;
  render();
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  board = prev.board; moves = prev.moves; selected = null;
  render();
}

// --- rendering --------------------------------------------------------------------------------------
const boardEl = el('board');

function onCellClick(r, c) {
  const cell = board[r][c];
  if (cell === 'peg') {
    // Select this peg (or deselect if it was already selected). Only worth selecting if it can move.
    selected = (selected && selected.r === r && selected.c === c) ? null : { r, c };
    render();
    return;
  }
  if (cell === 'empty' && selected) {
    // Is this empty hole a legal landing for the selected peg?
    const t = legalTargetsFrom(selected.r, selected.c).find((x) => x.tr === r && x.tc === c);
    if (t) jump(selected.r, selected.c, t);
  }
}

function render() {
  boardEl.innerHTML = '';
  const targets = selected ? legalTargetsFrom(selected.r, selected.c) : [];
  const isTarget = (r, c) => targets.some((t) => t.tr === r && t.tc === c);

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const div = document.createElement('div');
      div.className = 'cell';
      if (!valid(r, c)) { div.classList.add('invalid'); boardEl.appendChild(div); continue; }
      if (selected && selected.r === r && selected.c === c) div.classList.add('selected');
      if (isTarget(r, c)) div.classList.add('target');
      const hole = document.createElement('div'); hole.className = 'hole'; div.appendChild(hole);
      if (board[r][c] === 'peg') { const p = document.createElement('div'); p.className = 'peg'; div.appendChild(p); }
      div.addEventListener('click', () => onCellClick(r, c));
      boardEl.appendChild(div);
    }
  }

  const pegs = pegCount();
  el('pegs').textContent = pegs;
  el('moves').textContent = moves;
  el('undo').disabled = history.length === 0;

  const msg = el('msg');
  msg.className = '';
  if (pegs === 1) {
    const won = board[CENTRE][CENTRE] === 'peg';
    msg.textContent = won ? '🏆 Perfect — one peg, dead centre!' : '✔ Solved — one peg left. (A perfect finish lands it in the centre.)';
    msg.classList.add('win');
  } else if (!anyMoves()) {
    msg.textContent = `No moves left — ${pegs} pegs stranded. New game?`;
    msg.classList.add('lose');
  } else {
    msg.textContent = '';
  }
}

el('undo').addEventListener('click', undo);
el('restart').addEventListener('click', () => { fresh(); render(); });

el('build').textContent = `Peg Solitaire · v${VERSION}`;
fresh();
render();
