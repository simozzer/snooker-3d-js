// dice-view.js — the 3D VIEW + input controller for DICE (Farkle). The dice are physically simulated:
// pressing Roll runs the headless rigid-body sim in src/board/dice-physics.js, which returns a
// trajectory (per-frame poses) plus the settled face values; this view plays that trajectory back in a
// three.js tray, then hands the settled values to the Farkle engine in src/board/dice.js. Set-aside
// dice park on a rail; you click the tumbled dice to choose your scorers. The AI plays the same way.
//
// Everything visual lives here; the game rules/scoring/turn order/AI-decision live in the two engines.
// The outer chrome (Roll/Bank buttons, New game, rules, result banner) comes from the board.js shell.

import * as THREE from 'three';
import { createDice, MIN_BANK, TARGET } from '../../src/board/dice.js';
import { createDiceSim, FACES } from '../../src/board/dice-physics.js';
import { makeStudioEnv, feltMaterial, woodMaterial } from '../materials.js';

const GREEN = 0x54c98a;

// ---- pip textures: one ivory face per value, pips laid out on a 3×3 grid ----------------------
const PIP_CELLS = {
  1: [[.5, .5]],
  2: [[.28, .28], [.72, .72]],
  3: [[.28, .28], [.5, .5], [.72, .72]],
  4: [[.28, .28], [.72, .28], [.28, .72], [.72, .72]],
  5: [[.28, .28], [.72, .28], [.5, .5], [.28, .72], [.72, .72]],
  6: [[.28, .28], [.28, .5], [.28, .72], [.72, .28], [.72, .5], [.72, .72]],
};
function makePipTexture(value) {
  const S = 128;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = '#f4efe4'; c.fillRect(0, 0, S, S);
  // faint inner border so the cube's edges read
  c.strokeStyle = 'rgba(0,0,0,0.06)'; c.lineWidth = 6; c.strokeRect(3, 3, S - 6, S - 6);
  c.fillStyle = '#1c2126';
  for (const [x, y] of PIP_CELLS[value]) {
    c.beginPath(); c.arc(x * S, y * S, S * 0.085, 0, Math.PI * 2); c.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// three.js BoxGeometry material order is [+X,-X,+Y,-Y,+Z,-Z]; map each to the FACES value on that
// normal so the face you see up is exactly the value the sim reads (readUpValue).
const BOX_FACE_ORDER = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];
const faceValue = (n) => FACES.find((f) => f.n.x === n.x && f.n.y === n.y && f.n.z === n.z).value;

// Quaternion (as THREE.Quaternion) that rests a die with `value` pointing up (used for parked dice).
function restQuatFor(value) {
  const face = FACES.find((f) => f.value === value);
  const from = new THREE.Vector3(face.n.x, face.n.y, face.n.z);
  const q = new THREE.Quaternion().setFromUnitVectors(from, new THREE.Vector3(0, 1, 0));
  return q;
}

export default function mount(ctx) {
  const { canvas, box, gameControls, ui } = ctx;
  const engine = createDice();
  const sim = createDiceSim({ count: 6 });
  const S = sim.size, H = S / 2;
  let seedCounter = 0x9e3779b9; // sim seeds come from an LCG stepped on each throw

  let mode = ctx.getMode();
  let difficulty = ctx.getDifficulty();
  let over = false;
  let busy = false;               // animation / AI acting — blocks human input
  let playback = null;            // active roll trajectory being played back
  let raf = 0;

  // ---- three.js scene ------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12161b);
  scene.environment = makeStudioEnv(renderer);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 8.4, 6.6);
  camera.lookAt(0, 0, -0.2);

  // lights
  const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x24303a, 0.85);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff2d8, 1.7);
  key.position.set(3.5, 9, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -7; sc.right = 7; sc.top = 6; sc.bottom = -6; sc.near = 1; sc.far = 24;
  key.shadow.bias = -0.0005;
  scene.add(key);

  // tray: felt floor + wooden rim
  const halfX = sim.tray.halfX, halfZ = sim.tray.halfZ;
  const floorMat = feltMaterial('#1a5138');
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2 + 2.4, halfZ * 2 + 2.4), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);

  const rimMat = woodMaterial('#3a2417');
  const rimH = S * 1.15, rimT = 0.35;
  const addRim = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, rimH, d), rimMat);
    m.position.set(x, rimH / 2, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
  };
  addRim(halfX * 2 + rimT * 2, rimT, 0, -halfZ - rimT / 2);
  addRim(halfX * 2 + rimT * 2, rimT, 0, halfZ + rimT / 2);
  addRim(rimT, halfZ * 2 + rimT * 2, -halfX - rimT / 2, 0);
  addRim(rimT, halfZ * 2 + rimT * 2, halfX + rimT / 2, 0);

  // six dice, each with its own cloned material array so we can highlight individually
  const pipTex = {}; for (let v = 1; v <= 6; v++) pipTex[v] = makePipTexture(v);
  const dieGeo = new THREE.BoxGeometry(S, S, S);
  const diceMeshes = [];
  for (let i = 0; i < 6; i++) {
    const mats = BOX_FACE_ORDER.map((n) => new THREE.MeshStandardMaterial({
      map: pipTex[faceValue(n)], roughness: 0.34, metalness: 0.0,
    }));
    const mesh = new THREE.Mesh(dieGeo, mats);
    mesh.castShadow = true; mesh.userData.index = i;
    // selection outline: a slightly larger translucent green shell, hidden by default
    const glow = new THREE.Mesh(new THREE.BoxGeometry(S * 1.14, S * 1.14, S * 1.14),
      new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.0, depthWrite: false }));
    mesh.add(glow); mesh.userData.glow = glow;
    scene.add(mesh);
    diceMeshes.push(mesh);
  }

  // ---- controls -----------------------------------------------------------------------------
  gameControls.innerHTML = '';
  const rollBtn = document.createElement('button'); rollBtn.textContent = '🎲 Roll';
  const bankBtn = document.createElement('button'); bankBtn.textContent = '💰 Bank'; bankBtn.className = 'sec';
  gameControls.append(rollBtn, bankBtn);
  rollBtn.addEventListener('click', onRoll);
  bankBtn.addEventListener('click', onBank);

  // ---- HUD overlay (scoreboard + turn total + prompt) ---------------------------------------
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:0;right:0;top:0;pointer-events:none;padding:10px 12px;'
    + 'display:flex;flex-direction:column;gap:6px;font-family:system-ui,sans-serif;';
  hud.innerHTML = `
    <div id="dv-scores" style="display:flex;gap:10px;"></div>
    <div id="dv-prompt" style="text-align:center;font-size:13px;color:#9fb4c7;text-shadow:0 1px 3px #000;"></div>`;
  box.appendChild(hud);
  const scoresEl = hud.querySelector('#dv-scores');
  const promptEl = hud.querySelector('#dv-prompt');

  function renderHud() {
    const s = engine.state();
    const sel = engine.selectionScore();
    scoresEl.innerHTML = s.players.map((p, i) => {
      const active = i === s.current && s.phase !== 'over';
      const strikes = p.strikes ? ` <span style="color:#e23b3b">${'✕'.repeat(p.strikes)}</span>` : '';
      return `<div style="flex:1;background:${active ? 'rgba(46,125,91,.34)' : 'rgba(0,0,0,.32)'};
        border:1px solid ${active ? '#2e7d5b' : 'transparent'};border-radius:10px;padding:6px 10px;text-align:center;">
        <div style="font-size:12px;font-weight:700;color:${active ? '#eafff3' : '#9fb4c7'}">${p.name}${strikes}</div>
        <div style="font-size:22px;font-weight:800;color:${active ? '#ffdf6b' : '#e8e8e8'}">${p.score}</div>
      </div>`;
    }).join('');
    let line;
    if (s.phase === 'over') line = winMsg(s.players[s.winner].name);
    else if (busy && mode === 'ai' && s.current === 1) line = `Computer rolling…`;
    else if (s.farkled) line = 'Farkle! No score — turn lost.';
    else if (s.phase === 'await-roll') line = `First to ${TARGET} · roll to start your turn`;
    else line = sel > 0 ? `Selected ${sel} · turn ${s.turnScore + sel}`
      : `Turn ${s.turnScore} — tap the glowing dice to keep them`;
    promptEl.textContent = line;
  }

  const winMsg = (name) => (name === 'You' ? 'You win!' : `${name} wins!`);

  // ---- layout / sizing ----------------------------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = box.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width) - 8), h = Math.max(1, Math.floor(rect.height) - 8);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, true); // let three.js set the canvas CSS size so it fills #view
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderScene();
  }

  // ---- die placement ------------------------------------------------------------------------
  // Rail slot for the k-th set-aside die: a row along the back edge, behind the tray.
  function railPos(k) {
    const x = -halfX + 0.6 + k * (S + 0.35);
    return new THREE.Vector3(x, H, -halfZ - 1.15);
  }

  // Sync every mesh to engine state: held dice sit on the rail (value up, dimmed), live dice keep
  // their tumbled pose (set during playback) or hide before the first roll of a turn.
  let railCount = 0;
  function placeDice() {
    const s = engine.state();
    railCount = 0;
    for (let i = 0; i < 6; i++) {
      const d = s.dice[i];
      const mesh = diceMeshes[i];
      if (d.held) {
        mesh.visible = true;
        mesh.position.copy(railPos(railCount++));
        mesh.quaternion.copy(restQuatFor(d.value));
        setDim(mesh, true);
      } else if (s.phase === 'await-roll') {
        mesh.visible = false; // nothing thrown yet this turn
      } else {
        mesh.visible = true;
        setDim(mesh, false);
      }
    }
    updateHighlights();
  }

  function setDim(mesh, dim) {
    for (const m of mesh.material) { m.color.setScalar(dim ? 0.55 : 1); m.needsUpdate = false; }
  }

  function updateHighlights() {
    const s = engine.state();
    for (let i = 0; i < 6; i++) {
      const d = s.dice[i];
      const glow = diceMeshes[i].userData.glow;
      let op = 0;
      if (!over && !busy && s.phase === 'pick' && !d.held) {
        if (d.picked) op = 0.5;
        else if (engine.eligible(i) && humanControlling()) op = 0.22;
      }
      glow.material.opacity = op;
    }
  }

  // ---- roll trajectory playback -------------------------------------------------------------
  // Which engine dice indices get thrown next (see dice.js commit semantics).
  function thrownIndices() {
    const s = engine.state();
    if (s.phase === 'await-roll') return [0, 1, 2, 3, 4, 5];
    const live = [];
    for (let i = 0; i < 6; i++) if (!s.dice[i].held && !s.dice[i].picked) live.push(i);
    return live.length ? live : [0, 1, 2, 3, 4, 5]; // empty ⇒ hot dice (fresh six)
  }

  // Run the physics for the thrown dice and play it back, then commit the settled values to the
  // Farkle engine and call `onSettled`.
  function rollAndPlay(onSettled) {
    const s = engine.state();
    const thrown = thrownIndices();
    const result = createDiceSim({ count: thrown.length }).simulate((seedCounter = (seedCounter * 1664525 + 1013904223) >>> 0));
    busy = true; syncButtons(); renderHud();
    // make thrown meshes visible; held stay on rail
    for (const i of thrown) { diceMeshes[i].visible = true; setDim(diceMeshes[i], false); }
    playback = {
      thrown,
      frames: result.frames,
      start: perfNow(),
      done: () => {
        // feed the settled faces into the rules engine
        const values = result.values;
        const res = s.phase === 'await-roll' ? engine.roll(values) : engine.rollAgain(values);
        playback = null;
        busy = false;
        placeDice(); renderHud(); syncButtons();
        onSettled(res);
      },
    };
  }

  function stepPlayback() {
    if (!playback) return;
    const elapsed = (perfNow() - playback.start) / 1000;
    let fi = Math.floor(elapsed / (1 / 60));
    const frames = playback.frames;
    if (fi >= frames.length) {
      // land on the final pose, then finish
      applyFrame(frames.length - 1);
      const cb = playback.done; playback.done = () => {}; cb();
      return;
    }
    applyFrame(fi);
  }

  function applyFrame(fi) {
    const frame = playback.frames[fi];
    playback.thrown.forEach((idx, j) => {
      const pose = frame[j];
      const mesh = diceMeshes[idx];
      mesh.position.set(pose.p.x, pose.p.y, pose.p.z);
      mesh.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
    });
  }

  // ---- turn flow ----------------------------------------------------------------------------
  function humanControlling() {
    const s = engine.state();
    return mode === 'human' || s.current === 0;
  }

  function onRoll() {
    if (busy || over || engine.state().phase === 'over') return;
    rollAndPlay((res) => {
      if (res.farkle) {
        renderHud();
        setTimeout(() => { engine.endFarkle(); afterTurnChange(); }, 1100);
      } else {
        syncButtons(); updateHighlights(); renderHud(); maybeAI();
      }
    });
  }

  function onBank() {
    if (busy || over || !engine.canBank()) { if (!engine.canBank()) ui.status(`Need ${MIN_BANK}+ in a turn to bank.`); return; }
    const res = engine.bank();
    if (res.won) { finishGame(); return; }
    afterTurnChange();
  }

  function afterTurnChange() {
    busy = false;
    placeDice(); syncButtons(); renderHud(); announceTurn();
    maybeAI();
  }

  function announceTurn() {
    const s = engine.state();
    if (s.phase === 'over') return;
    const name = s.players[s.current].name;
    ui.turn(mode === 'ai' && s.current === 1 ? `${name} to roll…` : `${name}: your roll`);
  }

  function finishGame() {
    const s = engine.state();
    over = true; busy = false;
    ui.turn(null); ui.result(winMsg(s.players[s.winner].name));
    placeDice(); syncButtons(); renderHud();
  }

  // ---- AI -----------------------------------------------------------------------------------
  const FARKLE_P = { 6: 0.023, 5: 0.077, 4: 0.157, 3: 0.278, 2: 0.444, 1: 0.667 };

  function maybeAI() {
    if (mode !== 'ai' || over) return;
    const s = engine.state();
    if (s.phase === 'over' || s.current !== 1) return;
    busy = true; syncButtons(); renderHud();
    setTimeout(aiRoll, 550);
  }

  function aiRoll() {
    const s = engine.state();
    rollAndPlay((res) => {
      if (res.farkle) { renderHud(); setTimeout(() => { engine.endFarkle(); afterTurnChange(); }, 1200); return; }
      selectAllScoring(); updateHighlights(); renderHud();
      setTimeout(aiDecide, 750);
    });
  }

  function aiDecide() {
    const st = engine.state();
    const sel = engine.selectionScore();
    const projected = st.turnScore + sel;
    let remaining = st.dice.filter((d) => !d.held && !d.picked).length;
    if (remaining === 0) remaining = 6;
    const p = FARKLE_P[remaining] ?? 0.5;
    const cap = { easy: 400, medium: 800, hard: 1400 }[difficulty] || 800;
    const evGain = (1 - p) * expectedRollValue(remaining);
    const evLoss = p * projected;
    let press;
    if (projected < MIN_BANK) press = true;
    else if (projected >= cap) press = false;
    else if (difficulty === 'easy') press = false;
    else if (difficulty === 'hard') press = evGain > evLoss;
    else press = remaining >= 2 && evGain > evLoss * 0.8;

    busy = true; syncButtons();
    if (press) setTimeout(aiRoll, 500);
    else { const won = engine.bank().won; if (won) finishGame(); else afterTurnChange(); }
  }

  const expectedRollValue = (n) => ({ 6: 480, 5: 350, 4: 240, 3: 150, 2: 85, 1: 35 })[n] ?? 100;

  function selectAllScoring() {
    const s = engine.state();
    for (let i = 0; i < 6; i++) if (!s.dice[i].held && !s.dice[i].picked && engine.eligible(i)) engine.toggleSelect(i);
  }

  // ---- input (raycast pick) -----------------------------------------------------------------
  const rayc = new THREE.Raycaster();
  function onPointer(ev) {
    if (busy || over || !humanControlling()) return;
    const rect = canvas.getBoundingClientRect();
    const p = ev.touches ? ev.touches[0] : ev;
    const ndc = new THREE.Vector2(
      ((p.clientX - rect.left) / rect.width) * 2 - 1,
      -((p.clientY - rect.top) / rect.height) * 2 + 1,
    );
    rayc.setFromCamera(ndc, camera);
    const s = engine.state();
    const live = diceMeshes.filter((_, i) => !s.dice[i].held && diceMeshes[i].visible);
    const hit = rayc.intersectObjects(live, false)[0];
    if (!hit) return;
    const i = hit.object.userData.index;
    if (engine.toggleSelect(i)) { updateHighlights(); renderHud(); syncButtons(); }
  }

  // ---- buttons ------------------------------------------------------------------------------
  function syncButtons() {
    const s = engine.state();
    const aiTurn = mode === 'ai' && s.current === 1;
    const lock = busy || over || aiTurn;
    rollBtn.disabled = lock || s.phase === 'over' || s.farkled
      || (s.phase === 'pick' && !engine.canRoll());
    bankBtn.disabled = lock || !engine.canBank();
    rollBtn.textContent = s.phase === 'await-roll' ? '🎲 Roll' : '🎲 Roll on';
  }

  // ---- main loop ----------------------------------------------------------------------------
  const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function renderScene() { renderer.render(scene, camera); }
  function loop() {
    if (playback) stepPlayback();
    renderScene();
    raf = requestAnimationFrame(loop);
  }

  // ---- controller ---------------------------------------------------------------------------
  const controller = {
    newGame() {
      over = false; busy = false; playback = null;
      mode = ctx.getMode(); difficulty = ctx.getDifficulty();
      const names = mode === 'ai' ? ['You', 'Computer'] : ['Player 1', 'Player 2'];
      engine.newGame(names);
      ui.result(null); ui.setUndo(false);
      resize(); placeDice(); announceTurn(); syncButtons(); renderHud();
    },
    setMode(m) { mode = m; controller.newGame(); },
    setDifficulty(d) { difficulty = d; },
    undo() { /* dice are already cast — no meaningful undo */ },
    resize,
    // ---- test/debug hooks (see window.boardController) ----
    // Screen-space centre of a pickable die, so smoke tests can drive the real raycast picker.
    dieScreenPos(i) {
      const s = engine.state();
      if (!diceMeshes[i] || s.dice[i].held || !diceMeshes[i].visible) return null;
      const v = diceMeshes[i].position.clone().project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
    },
    peek() { return { ...engine.state(), busy, over }; },
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointer);
      hud.remove();
      renderer.dispose();
    },
    rulesHtml: `
      <h4>Goal</h4>
      <ul><li>First player to <b>${TARGET}</b> points wins.</li></ul>
      <h4>Each turn</h4>
      <ul>
        <li>Press <b>Roll</b> to throw the dice into the tray, then <b>tap the glowing (scoring) dice</b> to set them aside.</li>
        <li><b>Roll on</b> with the dice that are left to build your turn total — or <b>Bank</b> to keep it.</li>
        <li>You need <b>${MIN_BANK}+</b> in a turn before you're allowed to bank.</li>
        <li>Set all six aside and you earn <b>hot dice</b> — throw a fresh six and keep going.</li>
        <li>Roll and score <b>nothing</b> and you <b>farkle</b>: the whole turn's points are lost.</li>
      </ul>
      <h4>Scoring</h4>
      <ul>
        <li>Single <b>1</b> = 100, single <b>5</b> = 50.</li>
        <li>Three of a kind = face ×100 (three 1s = 1000).</li>
        <li>Each extra die of that face doubles the triple (4-of ×2, 5-of ×4, 6-of ×8).</li>
      </ul>
      <h4>Strikes</h4>
      <ul><li>Three farkles in a row costs you 1000 points.</li></ul>`,
  };

  canvas.addEventListener('pointerdown', onPointer);
  resize();
  loop();
  return controller;
}
