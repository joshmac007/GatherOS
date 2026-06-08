// Web Audio "save" sounds — all synthesized in-browser so we ship no
// audio assets. A single shared AudioContext + master gain (volume).
// Ten selectable effects; the user's chosen one plays when an image
// lands in the library (or none, if sound is turned off). The settings
// panel drives the live config via configureSaveSound().

let ac = null;
let masterGain = null;
function ctx() {
  if (!ac) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ac = new Ctx();
    masterGain = ac.createGain();
    masterGain.gain.value = config.volume;
    masterGain.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

const clamp = (v) => Math.max(0, Math.min(1, v));

// Live config — mirrors the saved prefs (saveSound / saveSoundEnabled /
// saveSoundVolume). Updated on app load and whenever Settings changes.
const config = { sound: 'collect', enabled: true, volume: 0.6 };
export function configureSaveSound(next = {}) {
  if (next.sound != null) config.sound = next.sound;
  if (typeof next.enabled === 'boolean') config.enabled = next.enabled;
  if (typeof next.volume === 'number') {
    config.volume = clamp(next.volume);
    if (masterGain) masterGain.gain.value = config.volume;
  }
}

// ── synthesis helpers ──────────────────────────────────────────────
function env(g, t, a, d, peak) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + Math.max(a, 0.001));
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function tone(o) {
  const c = ctx(); if (!c) return;
  const t = o.t0 ?? c.currentTime;
  const osc = c.createOscillator(); osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1 != null) osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
  let node = osc;
  if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; osc.connect(f); node = f; }
  const g = c.createGain(); node.connect(g); g.connect(masterGain);
  env(g, t, o.a ?? 0.004, o.dur - (o.a ?? 0.004), o.peak ?? 0.3);
  osc.start(t); osc.stop(t + o.dur + 0.03);
}
function noise(o) {
  const c = ctx(); if (!c) return;
  const t = o.t0 ?? c.currentTime;
  const len = Math.ceil(c.sampleRate * Math.max(o.dur, 0.05));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const n = c.createBufferSource(); n.buffer = buf;
  const filt = c.createBiquadFilter(); filt.type = o.type || 'bandpass';
  filt.frequency.setValueAtTime(o.f || 1500, t); filt.Q.value = o.q || 1;
  if (o.f1) filt.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
  const g = c.createGain(); n.connect(filt); filt.connect(g); g.connect(masterGain);
  env(g, t, o.a ?? 0.002, o.dur - (o.a ?? 0.002), o.peak ?? 0.3);
  n.start(t); n.stop(t + o.dur + 0.03);
}
const at = (off) => (ac ? ac.currentTime + off : 0);

// ── the ten sounds ─────────────────────────────────────────────────
const DEFS = {
  'collect': () => { tone({ type: 'triangle', f0: 660, dur: 0.07, peak: 0.22, lp: 3200 }); tone({ t0: at(0.075), type: 'triangle', f0: 990, dur: 0.13, peak: 0.22, lp: 3200 }); },
  'soft-pop': () => tone({ type: 'sine', f0: 210, f1: 90, dur: 0.13, a: 0.002, peak: 0.5, lp: 1300 }),
  'pluck': () => tone({ type: 'triangle', f0: 494, dur: 0.30, a: 0.001, peak: 0.34, lp: 2600 }),
  'marimba': () => { tone({ type: 'sine', f0: 523, dur: 0.42, a: 0.002, peak: 0.34 }); tone({ type: 'sine', f0: 1046, dur: 0.22, a: 0.002, peak: 0.10 }); },
  'bubble': () => tone({ type: 'sine', f0: 240, f1: 680, dur: 0.12, a: 0.005, peak: 0.4, lp: 2200 }),
  'chime': () => { tone({ type: 'sine', f0: 523, dur: 0.5, a: 0.004, peak: 0.27 }); tone({ t0: at(0.05), type: 'sine', f0: 659, dur: 0.55, a: 0.004, peak: 0.2 }); },
  'glass': () => { tone({ type: 'sine', f0: 1500, dur: 0.18, a: 0.001, peak: 0.24 }); tone({ type: 'sine', f0: 2700, dur: 0.10, a: 0.001, peak: 0.07 }); },
  'shutter': () => { noise({ dur: 0.04, type: 'highpass', f: 2200, peak: 0.4 }); noise({ t0: at(0.06), dur: 0.05, type: 'bandpass', f: 1100, q: 1.6, peak: 0.32 }); },
  'whoosh': () => { noise({ dur: 0.17, type: 'lowpass', f: 300, f1: 1100, peak: 0.26, a: 0.06 }); tone({ t0: at(0.15), type: 'sine', f0: 520, f1: 360, dur: 0.06, peak: 0.3 }); },
  'thock': () => { tone({ type: 'sine', f0: 135, f1: 80, dur: 0.10, a: 0.001, peak: 0.55, lp: 650 }); noise({ dur: 0.05, type: 'lowpass', f: 1100, peak: 0.22 }); },
};

// Metadata for the settings picker (order shown in the UI).
export const SAVE_SOUNDS = [
  { id: 'collect', name: 'Collect', desc: 'Two quick rising blips' },
  { id: 'soft-pop', name: 'Soft pop', desc: 'A small rounded low pop' },
  { id: 'pluck', name: 'Pluck', desc: 'A warm plucked-string note' },
  { id: 'marimba', name: 'Marimba', desc: 'A soft wooden mallet note' },
  { id: 'bubble', name: 'Bubble', desc: 'A watery rising pop' },
  { id: 'chime', name: 'Chime', desc: 'Two soft bell notes' },
  { id: 'glass', name: 'Glass tap', desc: 'A bright high tink' },
  { id: 'shutter', name: 'Camera shutter', desc: 'A crisp click-clack' },
  { id: 'whoosh', name: 'Whoosh', desc: 'An airy swell into a tap' },
  { id: 'thock', name: 'Thock', desc: 'A deep mechanical thock' },
];
export const DEFAULT_SAVE_SOUND = 'collect';

let lastAt = 0;
const THROTTLE_MS = 80;
function playId(id) {
  try { (DEFS[id] || DEFS[DEFAULT_SAVE_SOUND])(); } catch { /* audio unavailable — skip */ }
}

// Plays the user's selected sound when a save lands (respects the
// enabled toggle + a small throttle for rapid multi-saves).
export function playSaveSound() {
  if (!config.enabled) return;
  const now = Date.now();
  if (now - lastAt < THROTTLE_MS) return;
  lastAt = now;
  playId(config.sound);
}

// Plays a specific sound regardless of settings — for the picker preview.
export function previewSaveSound(id) { playId(id); }

// ── trash sounds (whoosh-away) ──────────────────────────────────────
// Share the save sound's enabled toggle + volume. Move-to-trash is a
// short downward swoosh; empty-trash is a longer sweep into a low thud.
let lastTrashAt = 0;
export function playTrashSound() {
  if (!config.enabled) return;
  const now = Date.now();
  if (now - lastTrashAt < THROTTLE_MS) return;
  lastTrashAt = now;
  try { noise({ type: 'lowpass', f: 1700, f1: 200, dur: 0.20, a: 0.005, peak: 0.30 }); }
  catch { /* audio unavailable — skip */ }
}
export function playEmptyTrashSound() {
  if (!config.enabled) return;
  try {
    noise({ type: 'lowpass', f: 2300, f1: 130, dur: 0.46, a: 0.02, peak: 0.32 });
    tone({ type: 'sine', f0: 150, f1: 60, dur: 0.18, t0: at(0.4), peak: 0.34, lp: 400 });
  } catch { /* audio unavailable — skip */ }
}

// Back-compat: useLibrary imports playPop; route it to the selected sound.
export const playPop = playSaveSound;
