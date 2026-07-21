export async function startSocialImportLease({ progress, startArgs, release } = {}) {
  if (!progress || typeof progress.start !== 'function' || typeof progress.beforeNext !== 'function') {
    throw new TypeError('progress reporter required');
  }
  if (typeof release !== 'function') throw new TypeError('release required');
  try {
    const started = await progress.start(startArgs);
    if (started.outcome === 'controller-rejected') {
      release();
      return { ok: false, error: 'Another social import is already running.' };
    }
    if (!progress.beforeNext()) {
      await progress.finish('stopped');
      release();
      return { ok: false, error: 'Import was stopped before it began.' };
    }
    return { ok: true };
  } catch (error) {
    release();
    return { ok: false, error: error?.message || 'Could not start import.' };
  }
}
