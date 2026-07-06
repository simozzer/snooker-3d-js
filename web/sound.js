// sound.js — synthesised collision knocks (ported from the 2D renderer).
//
// A short noise burst → bandpass → fast decay, volume/brightness scaled by impact speed. Ball-ball
// (pair) is a bright click; cushions (rail/jaw/frame) a duller knock; a bed landing a low thud.
// Leaf module: owns the WebAudio graph only. The caller supplies an `isEnabled` predicate (the Sound
// toggle) and decides WHEN to knock (the replay/render loop keeps its own event index).

let audioCtx = null;
let master = null; // compressor → destination, so overlapping knocks stay clean
let enabled = () => true;

// Wire up: remember the enable check and resume audio on the first user gesture (browsers require one).
export function initSound(isEnabled) {
  enabled = isEnabled;
  const unlockOnce = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', unlockOnce, true);
    window.removeEventListener('keydown', unlockOnce, true);
  };
  window.addEventListener('pointerdown', unlockOnce, true);
  window.addEventListener('keydown', unlockOnce, true);
}

export function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!audioCtx) {
      audioCtx = new AC();
      const comp = audioCtx.createDynamicsCompressor();
      const out = audioCtx.createGain();
      out.gain.value = 1.6;
      comp.connect(out).connect(audioCtx.destination);
      master = comp;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio unavailable */ }
}

// Synthesised crowd applause/cheer — no audio files, so the app stays network-independent. `level`
// (0..1) scales loudness, length and density: a light ripple for a routine pot up to a full roar for a
// century / frame win. Built from many short band-passed noise "claps" at random times under a shared
// swell envelope, plus a low crowd roar beneath the big cheers.
export function applause(level = 0.5) {
  if (!enabled() || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t0 = audioCtx.currentTime;
    const dur = 1.1 + level * 2.4;
    const swell = audioCtx.createGain();
    swell.gain.setValueAtTime(0.0001, t0);
    swell.gain.exponentialRampToValueAtTime(0.32 + level * 0.5, t0 + 0.12); // swell in
    swell.gain.setValueAtTime(0.32 + level * 0.5, t0 + dur * 0.55);
    swell.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // and fade
    swell.connect(master || audioCtx.destination);
    // one short noise buffer, reused by every clap source (cheap)
    const clapLen = Math.ceil(audioCtx.sampleRate * 0.03);
    const buf = audioCtx.createBuffer(1, clapLen, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < clapLen; j++) { const e = 1 - j / clapLen; d[j] = (Math.random() * 2 - 1) * e * e; }
    const claps = Math.round(22 + level * 66);
    for (let i = 0; i < claps; i++) {
      const ct = t0 + 0.02 + Math.random() * (dur - 0.12);
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 1400 + Math.random() * 2500; bp.Q.value = 0.9;
      const g = audioCtx.createGain(); g.gain.value = 0.1 + Math.random() * 0.16;
      src.connect(bp).connect(g).connect(swell);
      src.start(ct); src.stop(ct + 0.05);
    }
    if (level > 0.65) { // a low crowd roar under a big cheer
      const rlen = Math.ceil(audioCtx.sampleRate * dur);
      const rbuf = audioCtx.createBuffer(1, rlen, audioCtx.sampleRate);
      const rd = rbuf.getChannelData(0);
      for (let j = 0; j < rlen; j++) rd[j] = Math.random() * 2 - 1;
      const rsrc = audioCtx.createBufferSource(); rsrc.buffer = rbuf;
      const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 480;
      const rg = audioCtx.createGain();
      rg.gain.setValueAtTime(0.0001, t0);
      rg.gain.exponentialRampToValueAtTime(0.22 * level, t0 + 0.3);
      rg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      rsrc.connect(lp).connect(rg).connect(master || audioCtx.destination);
      rsrc.start(t0); rsrc.stop(t0 + dur);
    }
  } catch { /* ignore a dropped cheer */ }
}

export function knock(kind, intensity) {
  if (!enabled() || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t = audioCtx.currentTime;
    const cushion = kind === 'rail' || kind === 'jaw' || kind === 'frame';
    const bed = kind === 'bed';
    const hard = Math.max(0, Math.min(1, intensity / 3.5));
    const len = Math.ceil(audioCtx.sampleRate * 0.05);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    const baseHz = bed ? 320 : cushion ? 900 : 2000;
    const spread = bed ? 200 : cushion ? 400 : 1000;
    bp.frequency.value = baseHz * (0.9 + Math.random() * 0.2) + hard * spread;
    bp.Q.value = bed ? 3 : cushion ? 4 : 8;
    const g = audioCtx.createGain();
    const peak = (bed ? 0.8 : cushion ? 1.1 : 1.4) * Math.max(bed ? 0.18 : 0.28, hard);
    g.gain.setValueAtTime(Math.max(0.0003, peak), t);
    g.gain.exponentialRampToValueAtTime(0.0003, t + (cushion ? 0.06 : bed ? 0.07 : 0.04));
    src.connect(bp).connect(g).connect(master || audioCtx.destination);
    src.start(t);
    src.stop(t + 0.08);
  } catch { /* ignore a dropped knock */ }
}
