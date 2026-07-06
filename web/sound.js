// sound.js — synthesised collision knocks (ported from the 2D renderer).
//
// A short noise burst → bandpass → fast decay, volume/brightness scaled by impact speed. Ball-ball
// (pair) is a bright click; cushions (rail/jaw/frame) a duller knock; a bed landing a low thud.
// Leaf module: owns the WebAudio graph only. The caller supplies an `isEnabled` predicate (the Sound
// toggle) and decides WHEN to knock (the replay/render loop keeps its own event index).

let audioCtx = null;
let master = null; // compressor → destination, so overlapping knocks stay clean
let enabled = () => true;

// Vendored CC0/public-domain crowd samples (see web/audio/CREDITS.md). Loaded + decoded once on
// unlock; each cheer plays randomly picked / detuned / windowed slices layered together so it varies.
// If they're absent or fail to decode we fall back to the synthesised applause below, so the app
// still works with no assets. `_samples`: null = not tried yet, [] = tried (none), [buf…] = ready.
const SAMPLE_URLS = ['./audio/applause-1.wav', './audio/applause-2.oga'];
let _samples = null, _samplesLoading = false;
function loadSamples() {
  if (_samples !== null || _samplesLoading || !audioCtx) return;
  _samplesLoading = true;
  const ctx = audioCtx;
  Promise.all(SAMPLE_URLS.map((u) =>
    fetch(u)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('missing'))))
      .then((a) => ctx.decodeAudioData(a))
      .catch(() => null),
  )).then((bufs) => { _samples = bufs.filter(Boolean); _samplesLoading = false; })
    .catch(() => { _samples = []; _samplesLoading = false; });
}

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
    bakeClap(); // pre-render the clap timbre so the synth fallback is ready
    loadSamples(); // fetch + decode the real crowd samples (async; falls back to synth until ready)
  } catch { /* audio unavailable */ }
}

// A hall reverb impulse (decaying stereo noise), synthesised once and cached — routing the claps
// through it blurs them into a room, which is most of what makes a crowd read as a crowd.
let _reverbIR = null;
function reverbIR() {
  if (_reverbIR) return _reverbIR;
  const len = Math.ceil(audioCtx.sampleRate * 1.5);
  const b = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let j = 0; j < len; j++) d[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 2.6);
  }
  _reverbIR = b;
  return b;
}

// One realistic hand-clap, BAKED once via an offline render so it can be played cheaply (one source,
// no per-clap filters). A hand-clap = a low "thud" (air trapped between the palms, ~450 Hz) UNDER a mid
// "smack" (~1 kHz), with the high sizzle rolled off — without the thud it just sounds like a dry tick /
// rattling beans. Sharp attack, ~20 ms body. Cached in _clap; each clap plays it pitched for variety.
let _clap = null, _baking = false;
function bakeClap() {
  if (_clap || _baking || !audioCtx) return;
  _baking = true;
  const SR = audioCtx.sampleRate;
  const dur = 0.045;
  const off = new OfflineAudioContext(1, Math.ceil(SR * dur), SR);
  const n = Math.ceil(SR * dur);
  const nb = off.createBuffer(1, n, SR); const nd = nb.getChannelData(0);
  for (let j = 0; j < n; j++) nd[j] = Math.random() * 2 - 1;
  const src = off.createBufferSource(); src.buffer = nb;
  const env = off.createGain(); // sharp attack, exp decay ≈20 ms
  env.gain.setValueAtTime(0.0001, 0);
  env.gain.exponentialRampToValueAtTime(1, 0.0015);
  env.gain.exponentialRampToValueAtTime(0.02, 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, dur);
  const thud = off.createBiquadFilter(); thud.type = 'lowpass'; thud.frequency.value = 460; thud.Q.value = 0.9;
  const thudG = off.createGain(); thudG.gain.value = 1.15;
  const smack = off.createBiquadFilter(); smack.type = 'bandpass'; smack.frequency.value = 1050; smack.Q.value = 0.8;
  const smackG = off.createGain(); smackG.gain.value = 0.85;
  const hicut = off.createBiquadFilter(); hicut.type = 'lowpass'; hicut.frequency.value = 2600; // kill the "beans" sizzle
  src.connect(env);
  env.connect(thud).connect(thudG).connect(hicut);
  env.connect(smack).connect(smackG).connect(hicut);
  hicut.connect(off.destination);
  src.start(0);
  off.startRendering().then((b) => { _clap = b; _baking = false; }).catch(() => { _baking = false; });
}

// Crowd applause/cheer. `level` (0..1) scales loudness, length and density: a light ripple for a
// routine pot up to a full roar for a century / frame win. Prefers the vendored real-crowd samples
// (varied per shot); falls back to the synthesised version below until/unless they load.
export function applause(level = 0.5) {
  if (!enabled() || !audioCtx || audioCtx.state !== 'running') return;
  loadSamples(); // in case unlock hasn't kicked it off yet
  if (_samples && _samples.length) { applauseSamples(level); return; }
  applauseSynth(level);
}

// Real-crowd applause from the vendored samples. Layers a few voices, each a randomly picked clip
// played from a random offset, subtly detuned, and gated to a shot-scaled length — so a real crowd
// recording becomes a bigger, always-varying crowd instead of the same clip every time.
function applauseSamples(level) {
  try {
    const t0 = audioCtx.currentTime;
    const dur = 1.1 + level * 2.6;
    const swell = audioCtx.createGain(); // gate: a routine pot gets a short burst, not the whole clip
    swell.gain.setValueAtTime(0.0001, t0);
    swell.gain.exponentialRampToValueAtTime(0.6 + level * 0.7, t0 + 0.12); // swell in
    swell.gain.setValueAtTime(0.6 + level * 0.7, t0 + Math.max(0.2, dur - 0.6));
    swell.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // and fade
    swell.connect(master || audioCtx.destination);
    const voices = level > 0.6 ? 3 : level > 0.3 ? 2 : 1; // more hands for a bigger moment
    for (let v = 0; v < voices; v++) {
      const buf = _samples[(Math.random() * _samples.length) | 0];
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      src.playbackRate.value = 0.93 + Math.random() * 0.14; // subtle detune → a fuller, non-identical crowd
      const window = dur / src.playbackRate.value;
      const off = Math.random() * Math.max(0, buf.duration - window - 0.05); // vary the slice each time
      const g = audioCtx.createGain(); g.gain.value = (0.7 + Math.random() * 0.5) / Math.sqrt(voices);
      src.connect(g).connect(swell);
      const st = t0 + Math.random() * 0.06 * v; // stagger the voices a touch
      src.start(st, off, window);
    }
  } catch { /* ignore a dropped cheer */ }
}

// Synthesised crowd applause/cheer — the network-independent fallback when no samples are present.
// Sharp clap transients scattered in time, sent through a hall reverb (wet+dry), with a low crowd
// roar under the big cheers.
function applauseSynth(level = 0.5) {
  if (!enabled() || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t0 = audioCtx.currentTime;
    const dur = 1.1 + level * 2.6;
    // overall swell envelope, feeding the compressor/output
    const swell = audioCtx.createGain();
    swell.gain.setValueAtTime(0.0001, t0);
    swell.gain.exponentialRampToValueAtTime(0.5 + level * 0.6, t0 + 0.15); // swell in
    swell.gain.setValueAtTime(0.5 + level * 0.6, t0 + dur * 0.5);
    swell.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // and fade
    swell.connect(master || audioCtx.destination);
    // dry claps + a reverberated copy → the "room"
    const dry = audioCtx.createGain(); dry.gain.value = 0.55;
    const conv = audioCtx.createConvolver(); conv.buffer = reverbIR();
    const wet = audioCtx.createGain(); wet.gain.value = 0.6;
    dry.connect(swell); conv.connect(wet); wet.connect(swell);
    bakeClap();
    if (!_clap) return; // timbre not rendered yet (only in the first instant after unlock)
    const claps = Math.round(20 + level * 70);
    for (let i = 0; i < claps; i++) {
      const ct = t0 + 0.01 + Math.random() * (dur - 0.1);
      const src = audioCtx.createBufferSource(); src.buffer = _clap;
      src.playbackRate.value = 0.82 + Math.random() * 0.42; // pitch each pair of hands a little differently
      const g = audioCtx.createGain(); g.gain.value = 0.85 + Math.random() * 1.3;
      src.connect(g); g.connect(dry); g.connect(conv); // dry + into the room
      src.start(ct); src.stop(ct + 0.07);
    }
    if (level > 0.65) { // a low crowd roar under a big cheer
      const rlen = Math.ceil(audioCtx.sampleRate * dur);
      const rbuf = audioCtx.createBuffer(1, rlen, audioCtx.sampleRate);
      const rd = rbuf.getChannelData(0);
      for (let j = 0; j < rlen; j++) rd[j] = Math.random() * 2 - 1;
      const rsrc = audioCtx.createBufferSource(); rsrc.buffer = rbuf;
      const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 450;
      const rg = audioCtx.createGain();
      rg.gain.setValueAtTime(0.0001, t0);
      rg.gain.exponentialRampToValueAtTime(0.28 * level, t0 + 0.35);
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
