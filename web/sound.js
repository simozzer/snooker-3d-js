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
const SAMPLE_URLS = [
  './audio/applause-1.wav', './audio/applause-2.oga', './audio/applause-3.ogg', './audio/applause-4.ogg',
  './audio/applause-5.ogg', './audio/applause-6.ogg', './audio/applause-7.mp3',
];
let _samples = null, _sampleGains = null, _samplesLoading = false;
// The clips were recorded at very different levels; measure each one's peak so grains from a quiet clip
// and a loud clip contribute equally (else the bed sounds lumpy). Subsampled — plenty accurate for a peak.
function bufPeak(b) {
  let peak = 0;
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < d.length; i += 128) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  return peak || 1;
}
function loadSamples() {
  if (_samples !== null || _samplesLoading || !audioCtx) return;
  _samplesLoading = true;
  const ctx = audioCtx;
  Promise.all(SAMPLE_URLS.map((u) =>
    fetch(u)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('missing'))))
      .then((a) => ctx.decodeAudioData(a))
      .catch(() => null),
  )).then((bufs) => {
    _samples = bufs.filter(Boolean);
    _sampleGains = _samples.map((b) => Math.min(3, Math.max(0.4, 0.6 / bufPeak(b)))); // normalise clip loudness
    _samplesLoading = false;
  }).catch(() => { _samples = []; _sampleGains = []; _samplesLoading = false; });
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

// Real-crowd applause built as a BED of overlapping grains. Rather than play N clips once, we scatter
// many short slices across the cheer's span — each a randomly picked sample, from a random offset,
// subtly detuned, with its own fade-in / hold / fade-out at its own level. As one grain fades out
// another fades in, so the crowd never repeats and never chops. Grains are front-loaded (dense at the
// start, thinning out toward the end) and later ones are quieter and fade slower, so — together with a
// long, gentle release on the whole bus and a fading, darkening echo tail — the cheer dies away
// gradually like a real crowd winding down rather than stopping. `level` (0..1) scales the body length,
// the release length, how many grains overlap and their loudness — a light ripple up to a roar.
function applauseSamples(level) {
  try {
    const t0 = audioCtx.currentTime;
    const body = 0.8 + level * 2.0; // the main cheer
    const rel = 1.3 + level * 2.2; // a long, gradual wind-down after it
    const span = body + rel;
    const grains = Math.round(4 + level * 9); // 4..13 overlapping voices
    const out = audioCtx.createGain();
    // overall shape: BURST in fast (loudest right at the top, like a crowd erupting), settle back through
    // the body, then a long gentle fade across the release
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(1.05 + level * 0.5, t0 + 0.07); // fast, loud burst in
    out.gain.exponentialRampToValueAtTime(0.65 + level * 0.4, t0 + body * 0.6); // settle to a steadier clap
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + span); // gradual fade-out
    const dry = audioCtx.createGain(); dry.gain.value = 0.9;
    dry.connect(out);
    // Space is now mostly a FADING FEEDBACK ECHO rather than reverb. A slap delay feeds back through a
    // lowpass whose cutoff sweeps DOWN over the cheer, so each repeat is quieter AND darker — the tail
    // dissolves into muffled echoes instead of a bright reverb wash.
    const delay = audioCtx.createDelay(1.0); delay.delayTime.value = 0.18 + Math.random() * 0.06;
    const fbLP = audioCtx.createBiquadFilter(); fbLP.type = 'lowpass'; fbLP.Q.value = 0.3;
    fbLP.frequency.setValueAtTime(3000, t0); // echoes start fairly open…
    fbLP.frequency.exponentialRampToValueAtTime(480, t0 + span); // …then sweep down to muffled as they fade
    const fb = audioCtx.createGain(); fb.gain.value = 0.3 + level * 0.1; // low feedback → a short, subtle echo
    const echo = audioCtx.createGain(); echo.gain.value = 0.5 + level * 0.22;
    delay.connect(fbLP).connect(fb).connect(delay); // feedback loop
    delay.connect(echo).connect(out);
    // just a touch of darkened reverb for glue — much less than before, and rolled off up top
    const conv = audioCtx.createConvolver(); conv.buffer = reverbIR();
    const revLP = audioCtx.createBiquadFilter(); revLP.type = 'lowpass'; revLP.frequency.value = 2000; // kill the bright wash
    const wet = audioCtx.createGain(); wet.gain.value = 0.14 + level * 0.08;
    conv.connect(revLP).connect(wet).connect(out);
    // roll off the low end — recorded crowds carry a lot of room rumble/boom that muddies the mix
    const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 260; hp.Q.value = 0.5;
    const hp2 = audioCtx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 260; hp2.Q.value = 0.5; // 2nd order → steeper (~24 dB/oct)
    out.connect(hp).connect(hp2).connect(master || audioCtx.destination);
    const norm = 1 / Math.sqrt(grains); // keep the summed level in check as grains pile up
    for (let i = 0; i < grains; i++) {
      const si = (Math.random() * _samples.length) | 0;
      const buf = _samples[si];
      const rate = 0.9 + Math.random() * 0.2; // detune → a fuller, non-identical crowd
      // Strongly front-loaded: dense at the start (a roar of overlapping claps), then quickly thinning to
      // just a few sparse, scattered claps that get FEWER and quieter as the cheer dies — a crowd petering
      // out to the odd isolated clap.
      const frac = Math.pow(Math.random(), 3.0);
      // extra timing jitter that grows with frac, so late claps land at irregular intervals (not a patter)
      const st = t0 + Math.min(span, frac * span * 0.9 + (Math.random() - 0.5) * frac * 0.9);
      const fin = 0.04 + Math.random() * 0.08 + frac * 0.16; // early grains snap in (punchy); later ones soften
      const fout = 0.3 + Math.random() * 0.35 + frac * 0.8; // later grains fade slower → a smoother tail
      const life = Math.max(fin + fout + 0.12, Math.min(0.5 + Math.random() * 1.0, t0 + span + 0.3 - st));
      // loudest + most dynamic at the start: emphasise early grains and give them a wider level spread,
      // then ease down over the cheer so it settles into a steadier clap
      const emph = 0.15 + 0.85 * Math.pow(1 - frac, 1.6); // loud up front (~1.0), fading to a faint ~0.15 late
      const dyn = 0.5 + Math.random() * (0.5 + 0.7 * (1 - frac)); // wider punch/variation early
      const peak = Math.max(0.0004, norm * dyn * emph * (0.7 + level * 0.6) * _sampleGains[si]);
      const src = audioCtx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
      const consumed = (life + 0.1) * rate; // buffer-seconds this grain uses at its rate
      const off = Math.random() * Math.max(0, buf.duration - consumed); // vary the slice each time
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(peak, st + fin); // fade in
      g.gain.setValueAtTime(peak, st + life - fout); // hold…
      g.gain.exponentialRampToValueAtTime(0.0001, st + life); // …then fade out
      src.connect(g); g.connect(dry); g.connect(delay); g.connect(conv); // dry + echo + a little room
      src.start(st, off); src.stop(st + life + 0.05);
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
