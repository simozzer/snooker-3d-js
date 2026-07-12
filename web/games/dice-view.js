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
import { decideRoll, AI_STYLE } from '../../src/board/dice-ai.js';
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
  // Random start so throws differ every page load; each throw then steps this LCG for a varied stream.
  let seedCounter = ((Math.random() * 0x100000000) >>> 0) || 1;

  let mode = ctx.getMode();
  let difficulty = ctx.getDifficulty();
  let over = false;
  let busy = false;               // animation / AI acting — blocks human input
  let playback = null;            // active roll trajectory being played back
  let aiMsg = null;               // a transient line shown while the AI deliberates (bank vs roll on)

  // Deliberate AI pacing so its bank-or-risk decision is readable — it "considers the Bank button",
  // then pauses BEFORE rolling again (or holds a beat as it banks) rather than snapping through its turn.
  const AI_ROLLON_MS = 1050;      // it COULD bank but chooses to risk another roll — a real gamble, held longest
  const AI_BUILD_MS = 650;        // below the 350 minimum, so it has no choice but to roll on — a shorter beat
  const AI_BANK_MS = 1050;        // hold on the bank so the human sees the computer "press" Bank
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
  camera.position.set(0, 12.8, 10.4);
  camera.lookAt(0, 0, -0.6);

  // lights
  const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x24303a, 0.85);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff2d8, 1.7);
  key.position.set(3.5, 9, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -9; sc.right = 9; sc.top = 8; sc.bottom = -8; sc.near = 1; sc.far = 28;
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
    // selection halo: a larger additive green shell that glows around the die. Faint + static for a
    // merely SELECTABLE die; bright + pulsing (plus an emissive glow on the die) once SELECTED.
    const glow = new THREE.Mesh(new THREE.BoxGeometry(S * 1.32, S * 1.32, S * 1.32),
      new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.visible = false;
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
    else if (aiMsg) line = aiMsg; // the computer's bank-or-roll deliberation (shown during its pause)
    else if (busy && mode === 'ai' && s.current === 1) line = `Computer (${AI_STYLE[difficulty].split(' — ')[0]}) rolling…`;
    else if (s.farkled) line = 'Bust! No score — turn lost.';
    else if (s.phase === 'await-roll') line = s.finalRound
      ? `🏁 Final turn — beat ${beatOf(s)} to win · roll`
      : `First to ${TARGET} · roll to start your turn`;
    else if (sel > 0) {
      const bankable = s.turnScore + sel;
      if (s.finalRound) {
        const my = s.players[s.current].score, beat = beatOf(s);
        line = my + bankable > beat
          ? `Turn ${bankable} · ${my + bankable} beats ${beat} — 🏆 Bank to win!`
          : `Turn ${bankable} · need > ${beat} (have ${my + bankable}) — roll on`;
      } else {
        line = engine.canBank()
          ? `Selected ${sel} · turn ${bankable} · 💰 Bank to keep ${bankable}`
          : `Selected ${sel} · turn ${bankable} · ${s.minBank - bankable} more to bank`;
      }
    } else line = `Turn ${s.turnScore} — tap the glowing dice to keep them`;
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

  // Mark each die as selected / selectable / neither. Actual halo opacity for selected dice is
  // driven per-frame in pulseHalos() so it breathes; selectable dice get a faint constant outline.
  function updateHighlights() {
    const s = engine.state();
    for (let i = 0; i < 6; i++) {
      const d = s.dice[i];
      const mesh = diceMeshes[i];
      const glow = mesh.userData.glow;
      let mood = 'none';
      if (!over && !busy && s.phase === 'pick' && !d.held) {
        if (d.picked) mood = 'selected';
        else if (engine.eligible(i) && humanControlling()) mood = 'selectable';
      }
      mesh.userData.mood = mood;
      glow.visible = mood !== 'none';
      if (mood === 'selectable') { glow.scale.setScalar(0.86); glow.material.opacity = 0.18; }
      setEmissive(mesh, mood === 'selected' ? 0x1f7a45 : 0x000000);
    }
  }

  // Selected dice pulse: a living green halo that's unmistakable next to a static selectable outline.
  function pulseHalos() {
    const t = perfNow() / 1000;
    const puls = 0.5 + 0.28 * Math.sin(t * 5.5);
    for (const mesh of diceMeshes) {
      if (mesh.userData.mood !== 'selected') continue;
      const glow = mesh.userData.glow;
      glow.material.opacity = puls;
      glow.scale.setScalar(1 + 0.05 * Math.sin(t * 5.5));
    }
  }

  function setEmissive(mesh, hex) {
    for (const m of mesh.material) if (m.emissive) m.emissive.setHex(hex);
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

  // Clear the felt for a fresh throw: park every previously selected/banked die onto the rail (off
  // the table) and hide anything else, so only the dice about to be thrown remain in the tray.
  function clearTableForThrow(thrown) {
    let rc = 0;
    const s = engine.state();
    for (let i = 0; i < 6; i++) {
      if (thrown.includes(i)) { diceMeshes[i].visible = true; setDim(diceMeshes[i], false); continue; }
      const d = s.dice[i];
      if (d.held || d.picked) {
        diceMeshes[i].visible = true;
        diceMeshes[i].position.copy(railPos(rc++));
        diceMeshes[i].quaternion.copy(restQuatFor(d.value));
        setDim(diceMeshes[i], true);
      } else {
        diceMeshes[i].visible = false;
      }
    }
  }

  const nextSeed = () => (seedCounter = (seedCounter * 1664525 + 1013904223) >>> 0);
  const MAX_REROLLS = 6; // safety cap so a pathological throw can never loop forever

  // Roll the live dice, play the throw back, then commit the settled faces to the Farkle engine. A die
  // that lands COCKED (didn't lie flat) is picked up and thrown again on its own — just like at a real
  // table — while the dice that landed flat stay exactly where they are; only when every die is flat do
  // we read the faces. `onSettled` fires once, with the final result.
  function rollAndPlay(onSettled) {
    const s = engine.state();
    const thrown = thrownIndices();
    const firstRoll = s.phase === 'await-roll';
    busy = true; syncButtons(); renderHud();
    clearTableForThrow(thrown);

    const finalPose = {}; // engine idx → last settled { p, q } (re-rolls read the flat dice as obstacles)
    const value = {};     // engine idx → settled face value
    let rerolls = 0;

    const commit = () => {
      if (rerolls > 0) ui.status(null); // clear the "re-rolling" note
      const values = thrown.map((i) => value[i]);
      const res = firstRoll ? engine.roll(values) : engine.rollAgain(values);
      busy = false;
      placeDice(); renderHud(); syncButtons();
      onSettled(res);
    };

    // Throw `slots` (engine indices) as dynamic dice; every other thrown die rests as an obstacle so a
    // re-rolled die can't land on top of one. Record each die's pose/value/flatness, then re-roll any
    // that came up cocked (capped), or commit once all are flat.
    const throwSlots = (slots) => {
      const obstacles = thrown.filter((i) => !slots.includes(i)).map((i) => finalPose[i]);
      const result = createDiceSim({ count: slots.length }).simulate(nextSeed(), obstacles);
      playback = {
        thrown: slots,
        frames: result.frames,
        start: perfNow(),
        done: () => {
          playback = null;
          const last = result.frames.at(-1);
          const cocked = [];
          slots.forEach((idx, j) => {
            finalPose[idx] = last[j];
            value[idx] = result.values[j];
            if (!result.flat[j]) cocked.push(idx);
          });
          if (cocked.length && rerolls < MAX_REROLLS) {
            rerolls++;
            ui.status(cocked.length === 1 ? 'Cocked die — re-rolling it…' : `${cocked.length} cocked dice — re-rolling…`);
            setTimeout(() => throwSlots(cocked), 650);
            return;
          }
          commit();
        },
      };
      applyFrame(0); // lift the thrown dice to their airborne start now, before the next paint
    };

    throwSlots(thrown);
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

  // In the final round, the score the CURRENT player must OVERTAKE to win (the best of everyone else).
  const beatOf = (s) => Math.max(...s.players.filter((_, i) => i !== s.current).map((p) => p.score));

  // A turn just ended: if reaching the target concluded the game, show the result; otherwise play on.
  function resolveTurnEnd() {
    if (engine.state().phase === 'over') finishGame();
    else afterTurnChange();
  }

  // Someone reached the target — announce the "last licks" chase.
  function announceFinalRound(res) {
    const s = engine.state();
    const leader = s.players[res.target];
    ui.status(`${leader.name} reached ${TARGET}! Final turn — beat ${leader.score} to win.`);
  }

  function onRoll() {
    if (busy || over || engine.state().phase === 'over') return;
    rollAndPlay((res) => {
      if (res.farkle) {
        renderHud();
        setTimeout(() => { engine.endFarkle(); resolveTurnEnd(); }, 1100);
      } else {
        syncButtons(); updateHighlights(); renderHud(); maybeAI();
      }
    });
  }

  function onBank() {
    if (busy || over || !engine.canBank()) { if (!engine.canBank()) ui.status(`Need ${MIN_BANK}+ in a turn to bank.`); return; }
    const res = engine.bank();
    if (res.finalRound) announceFinalRound(res);
    resolveTurnEnd();
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
    if (s.finalRound) { ui.turn(`🏁 Final turn — ${name} must beat ${beatOf(s)}!`); return; }
    ui.turn(mode === 'ai' && s.current === 1 ? `${name} to roll…` : `${name}: your roll`);
  }

  function finishGame() {
    const s = engine.state();
    over = true; busy = false;
    ui.turn(null); ui.result(winMsg(s.players[s.winner].name));
    placeDice(); syncButtons(); renderHud();
  }

  // ---- AI -----------------------------------------------------------------------------------
  // The computer keeps every scoring die, then asks the shared gambling brain (src/board/dice-ai.js)
  // whether to bank or roll on — an exact expected-value call tempered by the chosen difficulty.
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
      if (res.farkle) { renderHud(); setTimeout(() => { engine.endFarkle(); resolveTurnEnd(); }, 1200); return; }
      selectAllScoring(); updateHighlights(); renderHud();
      setTimeout(aiDecide, 750);
    });
  }

  function aiDecide() {
    const st = engine.state();
    const projected = st.turnScore + engine.selectionScore();
    const remaining = st.dice.filter((d) => !d.held && !d.picked).length; // 0 ⇒ hot dice
    const action = decideRoll({
      turnScore: projected,
      diceRemaining: remaining,
      myScore: st.players[st.current].score,
      oppScore: st.players[1 - st.current].score,
      target: TARGET,
      minBank: MIN_BANK,
      needToBeat: st.finalRound ? beatOf(st) : null, // final round: chase past the leader, not just to the target
    }, difficulty);

    busy = true; syncButtons();
    const canBankNow = projected >= MIN_BANK; // is the Bank button one the computer could actually press?
    if (action === 'roll') {
      // Pause BEFORE rolling again so the choice reads. If it could have banked, show that it considered
      // the Bank button and chose to gamble; otherwise it's simply still building toward the minimum.
      if (canBankNow) { flashBank('consider', projected); aiMsg = `Computer could bank ${projected} — rolling on…`; }
      else aiMsg = `Computer building a break… ${projected}`;
      renderHud();
      setTimeout(() => { flashBank(null); aiMsg = null; aiRoll(); }, canBankNow ? AI_ROLLON_MS : AI_BUILD_MS);
    } else {
      // Banking: hold a beat with the Bank button lit so the human sees the computer take its points.
      flashBank('press', projected); aiMsg = `💰 Computer banks ${projected}`;
      renderHud();
      setTimeout(() => {
        flashBank(null); aiMsg = null;
        const res = engine.bank();
        if (res.finalRound) announceFinalRound(res);
        resolveTurnEnd();
      }, AI_BANK_MS);
    }
  }

  // Momentarily style the Bank button to show the computer's thinking: 'press' = it's banking now
  // (lit green), 'consider' = it could bank this many but is rolling on (outlined), null = clear.
  function flashBank(state, value) {
    if (state === null) { bankBtn.style.background = ''; bankBtn.style.opacity = ''; bankBtn.style.boxShadow = ''; return; }
    bankBtn.textContent = `💰 Bank ${value}`;
    bankBtn.style.opacity = '1';
    bankBtn.style.background = state === 'press' ? '#2e8b57' : '#33404c';
    bankBtn.style.boxShadow = state === 'press' ? '0 0 0 3px rgba(127,201,127,.7)' : '0 0 0 2px rgba(127,201,127,.35)';
  }

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
    // Show what the bank is worth: banking commits the current selection, so it's worth the points
    // already set aside this turn PLUS whatever is selected right now. Below the minimum, show how
    // close you are so the "get on the board" threshold isn't a mystery.
    const bankable = s.turnScore + engine.selectionScore();
    if (engine.canBank()) bankBtn.textContent = `💰 Bank ${bankable}`;
    else if (bankable > 0 && bankable < s.minBank) bankBtn.textContent = `💰 Bank ${bankable}/${s.minBank}`;
    else bankBtn.textContent = '💰 Bank';
    bankBtn.title = engine.canBank()
      ? `Bank ${bankable} and end your turn`
      : `Reach ${s.minBank} in a turn to bank (you have ${bankable})`;
  }

  // ---- main loop ----------------------------------------------------------------------------
  const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function renderScene() { renderer.render(scene, camera); }
  function loop() {
    if (playback) stepPlayback();
    pulseHalos();
    renderScene();
    raf = requestAnimationFrame(loop);
  }

  // ---- controller ---------------------------------------------------------------------------
  const controller = {
    newGame() {
      over = false; busy = false; playback = null; aiMsg = null; flashBank(null);
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
    // Settled orientation of each currently-in-tray (not railed) die, for smoke tests: the world-space
    // up-face verticality (1 = perfectly flat) and the heading (yaw about the vertical, degrees).
    dicePoses() {
      const s = engine.state();
      const up = new THREE.Vector3(0, 1, 0);
      const out = [];
      for (let i = 0; i < 6; i++) {
        const d = s.dice[i];
        if (d.held || !diceMeshes[i].visible) continue;
        const q = diceMeshes[i].quaternion;
        let best = -Infinity;
        for (const f of FACES) best = Math.max(best, new THREE.Vector3(f.n.x, f.n.y, f.n.z).applyQuaternion(q).dot(up));
        const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        out.push({ upFaceY: best, yaw: Math.atan2(fwd.z, fwd.x) * 180 / Math.PI });
      }
      return out;
    },
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointer);
      hud.remove();
      renderer.dispose();
    },
    rulesHtml: `
      <p style="margin:0 0 6px;color:#8fa3b5">A push-your-luck dice game — the “Dice” house rules.</p>
      <h4>Goal</h4>
      <ul>
        <li>Reach <b>${TARGET}</b> points to trigger the <b>final round</b>.</li>
        <li>Everyone else then gets <b>one last turn</b> to beat that score — highest total wins (a tie is held by whoever got there first).</li>
      </ul>
      <h4>Each turn</h4>
      <ul>
        <li>Press <b>Roll</b> to throw the dice into the tray, then <b>tap the glowing (scoring) dice</b> to set them aside.</li>
        <li><b>Roll on</b> with the dice that are left to build your turn total — or <b>Bank</b> to keep it.</li>
        <li>You need <b>${MIN_BANK}+</b> in a turn before you're allowed to bank.</li>
        <li>Set all six aside and you earn <b>hot dice</b> — throw a fresh six and keep going.</li>
        <li>Roll and score <b>nothing</b> and you <b>bust</b>: the whole turn's points are lost.</li>
      </ul>
      <h4>Scoring</h4>
      <ul>
        <li>Single <b>1</b> = 100, single <b>5</b> = 50.</li>
        <li>Three of a kind = face ×100 (three 1s = 1000).</li>
        <li>Each extra die of that face doubles the triple (4-of ×2, 5-of ×4, 6-of ×8).</li>
      </ul>
      <h4>Strikes</h4>
      <ul><li>Three busts in a row costs you 1000 points.</li></ul>
      <h4>Computer players</h4>
      <ul>
        <li><b>Easy</b> — ${AI_STYLE.easy}.</li>
        <li><b>Medium</b> — ${AI_STYLE.medium}.</li>
        <li><b>Hard</b> — ${AI_STYLE.hard}.</li>
      </ul>`,
  };

  canvas.addEventListener('pointerdown', onPointer);
  resize();
  loop();
  return controller;
}
