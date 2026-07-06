// referee.js — a spoken snooker referee using the browser's built-in SpeechSynthesis (local TTS, no
// assets, network-independent). The renderer builds a short phrase per shot ("Foul, 5 away. Miss.",
// "Free ball.", "Century.", "Player 1 wins the frame, 72 to 54.") and calls announce(); this module
// owns voice selection and delivery. Gated by the caller's enable predicate (the Referee toggle).

let enabled = () => false;
let voice = null;

// A British-English voice reads most like a snooker referee; fall back through any English to default.
function chooseVoice() {
  try {
    const vs = window.speechSynthesis.getVoices();
    if (!vs || !vs.length) return null;
    return vs.find((v) => /en-GB/i.test(v.lang) && /male|daniel|george|arthur|oliver/i.test(v.name))
      || vs.find((v) => /en-GB/i.test(v.lang))
      || vs.find((v) => /^en[-_]/i.test(v.lang))
      || vs.find((v) => /^en/i.test(v.lang))
      || vs[0];
  } catch { return null; }
}

export function initReferee(isEnabled) {
  enabled = isEnabled;
  if (!('speechSynthesis' in window)) return;
  voice = chooseVoice();
  // voices load asynchronously in most browsers — re-pick when they arrive
  try { window.speechSynthesis.addEventListener('voiceschanged', () => { voice = chooseVoice(); }); } catch { /* older API */ }
}

// Speak a referee line. The latest call supersedes any still in progress (the freshest event matters
// most), so calls never pile up into a backlog.
export function announce(text) {
  if (!text || !enabled() || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 0.96; u.pitch = 0.82; u.volume = 1; // measured, a touch low — an authoritative read
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* speech unavailable — stay silent */ }
}
