const { shouldUseImageAi } = require('./video-semantic-workflows');

function createSaveBackgroundRouter({
  backgroundRuntime,
  getSave = null,
  enrichImageSave = async () => {},
  isImageSave = shouldUseImageAi,
  noteActivity = null,
  logger = console,
} = {}) {
  if (!backgroundRuntime || typeof backgroundRuntime.routeSave !== 'function') {
    throw new TypeError('Save background router requires backgroundRuntime.routeSave');
  }

  async function route(record, { duplicate = false } = {}) {
    if (!record?.id) return { ok: false, reason: 'save_not_found' };
    if (typeof noteActivity === 'function') {
      noteActivity({ kind: duplicate ? 'duplicate' : 'save', saveId: record.id });
    }
    const image = !duplicate && isImageSave(record);
    if (image) await enrichImageSave(record);
    const current = typeof getSave === 'function' ? getSave(record.id) || record : record;
    return backgroundRuntime.routeSave(current, { duplicate, changed: image });
  }

  function notify(record, { backgroundRouted = false, duplicate = false } = {}) {
    if (backgroundRouted) return null;
    const pending = route(record, { duplicate });
    pending.catch((error) => {
      if (error?.code !== 'library_epoch_stale') {
        try { logger?.error?.('[background] save routing failed:', error?.message || error); } catch {}
      }
    });
    return pending;
  }

  return { route, notify };
}

module.exports = { createSaveBackgroundRouter };
