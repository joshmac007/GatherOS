import loadingUrl from '../assets/loading.mp3';

// Tiny Web Audio "pop" — synthesized so we don't ship an audio
// asset. A brief high-to-low pitch sweep with a fast attack/decay
// envelope; reads as a satisfying drop confirmation.

let lastPopAt = 0;
const POP_THROTTLE_MS = 80;

export function playPop() {
  const now = Date.now();
  if (now - lastPopAt < POP_THROTTLE_MS) return;
  lastPopAt = now;

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t0 = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // Pitch slides 900 → 180Hz over 80ms — that descending glide is
    // most of what makes it sound like a "drop."
    osc.frequency.setValueAtTime(900, t0);
    osc.frequency.exponentialRampToValueAtTime(180, t0 + 0.08);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.32, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.15);

    setTimeout(() => { try { ctx.close(); } catch {} }, 220);
  } catch {
    // Audio unavailable (no user gesture yet, denied permissions,
    // etc.) — silently skip.
  }
}

// ── Splash sound ─────────────────────────────────────────────────────
// Plays the bundled loading MP3 once on app start. Held in module
// scope so we can also stop/fade it when the splash exits.

let loadingAudio = null;

export function playLoading({ volume = 0.7 } = {}) {
  try {
    loadingAudio = new Audio(loadingUrl);
    loadingAudio.volume = volume;
    // Chromium may reject autoplay if there's been no user gesture
    // yet — swallow the rejection so the splash visuals still run.
    loadingAudio.play().catch(() => {});
  } catch {}
}

export function stopLoading({ fadeMs = 320 } = {}) {
  const a = loadingAudio;
  if (!a) return;
  loadingAudio = null;
  if (fadeMs <= 0) {
    try { a.pause(); a.currentTime = 0; } catch {}
    return;
  }
  // Linear gain ramp to zero — Audio elements don't have a native
  // gain ramp, so we step the volume down on a tight interval.
  const start = a.volume;
  const startedAt = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - startedAt) / fadeMs);
    try { a.volume = start * (1 - t); } catch {}
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      try { a.pause(); a.currentTime = 0; } catch {}
    }
  };
  requestAnimationFrame(step);
}

