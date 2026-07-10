const { ipcMain, shell, dialog, BrowserWindow, nativeImage, clipboard, app, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  getAllSaves, getSave, deleteSave, restoreSave, permanentlyDeleteSave,
  emptyTrash, wipeLibrary, updateSave, insertSave,
  getSmartViewCounts,
  filterByColor,
  getAllCollections, getAllCollectionsWithThumbs, getCollectionsForSave, getCollectionsContainingAll, createCollection, renameCollection, setCollectionParent,
  deleteCollection, reorderCollections, addSaveToCollection, removeSaveFromCollection,
  getAllTags, getTagsForSave, getSaveIdsForTag,
  addTagToSave, removeTagFromSave, renameTag, deleteTag,
  listBoards, listBoardsWithThumbs, getBoard, createBoard, renameBoard, deleteBoard, reorderBoards,
  getBoardItems, getBoardPreviewSaves, getBoardSaveIds, getBoardsForSave,
  upsertBoardItem, bulkUpdateBoardItems, deleteBoardItem, deleteBoardItems,
  listNavigableSmartCategories,
  hideSmartCategory, pinSmartCategory,
  getSmartCategorySaves,
  getVideoAnalysis, listVideoTagSuggestions,
  acceptVideoTagSuggestion, dismissVideoTagSuggestion,
} = require('./db');
const {
  deleteImageFiles,
  saveImageFromFile,
  saveImageFromUrl,
  saveImageFromBuffer,
  composeMoodBoard,
  composeMoodBoardGif,
  getStorageUsage,
  reclaimLibraryStorage,
} = require('./storage');
const {
  startScreenshotCapture,
  captureFullscreen,
  captureWindow,
} = require('./capture');
const { notifySaved, notifyDuplicate, refreshTray } = require('./notify');
const { setToastInteractive, onToastsEmpty } = require('./toast-window');
const settings = require('./settings');
const { quitAndInstall } = require('./updater');
const { ingestZip } = require('./zipImport');
const { installStarterPack, removeStarterPack, restoreSnapshot } = require('./starterPack');
const { captureUrl } = require('./urlCapture');
const { unwrapSearchEngineUrl } = require('../shared/unwrapSearchUrl');
const {
  hasSession: hasAiSession,
  autoTagImage,
  generateImagePrompt,
  generateImage,
  getUsage: getAiUsage,
} = require('./openai');
const { detectColorName } = require('./colorNames');
const { canCreateSave } = require('./entitlement');
const { notifyNeedsUpgrade } = require('./notify');

// Free-tier save guard for IPC handlers. Returns true (and surfaces the
// upgrade prompt in the renderer) when a new save must be blocked. The
// caller returns its own needsUpgrade-shaped result so the renderer's
// call site stays happy. Fails OPEN via canCreateSave().
function blockNewSave(source) {
  if (canCreateSave()) return false;
  try { notifyNeedsUpgrade({ source: source || 'save' }); } catch { /* ignore */ }
  return true;
}

let aiVariantBusy = false;

function isVideoSave(save) {
  return save?.kind === 'video' || /\.mp4$/i.test(save?.file_path || '');
}

function registerIpcHandlers({
  smartCategoryRefresh = null,
  semanticIndex = null,
  semanticSearch = null,
  backgroundRuntime = null,
  cleanupDerivedCache = null,
} = {}) {
  async function cleanupSaveDerived(saveId) {
    if (!saveId) return;
    if (typeof backgroundRuntime?.cleanupSaveDerived === 'function') {
      await backgroundRuntime.cleanupSaveDerived(saveId);
      return;
    }
    if (typeof cleanupDerivedCache === 'function') {
      await cleanupDerivedCache({ saveId });
    }
  }

  async function cleanupAllDerived() {
    if (typeof backgroundRuntime?.cleanupAllDerived === 'function') {
      await backgroundRuntime.cleanupAllDerived();
      return;
    }
    if (typeof cleanupDerivedCache === 'function') {
      await cleanupDerivedCache({ all: true });
    }
  }

  async function cleanupSaveDerivedBestEffort(saveId) {
    try {
      await cleanupSaveDerived(saveId);
      return null;
    } catch (error) {
      return {
        reason: 'derived-cleanup-failed',
        detail: error?.message || String(error),
      };
    }
  }

  async function cleanupAllDerivedBestEffort() {
    try {
      await cleanupAllDerived();
      return null;
    } catch (error) {
      return {
        reason: 'derived-cleanup-failed',
        detail: error?.message || String(error),
      };
    }
  }

  async function enqueueSemanticBestEffort(saveIds) {
    if (typeof semanticIndex?.enqueue !== 'function') return null;
    const ids = [...new Set(
      (Array.isArray(saveIds) ? saveIds : [saveIds]).filter(Boolean),
    )];
    const failures = [];
    for (const saveId of ids) {
      try {
        const result = await semanticIndex.enqueue(saveId);
        if (result?.ok === false) {
          failures.push({
            saveId,
            detail: result.detail || result.reason || 'Semantic indexing could not be queued',
          });
        }
      } catch (error) {
        failures.push({ saveId, detail: error?.message || String(error) });
      }
    }
    if (failures.length === 0) return null;
    return {
      reason: 'semantic-enqueue-failed',
      count: failures.length,
      detail: failures[0].detail,
    };
  }

  async function enqueueAfterCanonicalMutation(result, saveIds) {
    if (!result?.ok) return result;
    const semanticWarning = await enqueueSemanticBestEffort(saveIds);
    return semanticWarning ? { ...result, semanticWarning } : result;
  }
  // Merges saves whose extracted palette is perceptually similar to a
  // named color in the query (e.g. "orange", "navy") into the existing
  // result set. Same view filters (collection/explicit colorHex) get
  // applied so semantic + LIKE + name-color-match all honor the active
  // context.
  function mergeColorNameMatches(results, opts, queryText) {
    const detectedHex = detectColorName(queryText);
    if (!detectedHex) return results;
    // Get every save that already passes the user's other filters
    // (view, collection, plus any tag:/bucket:/before:/etc. tokens
    // sitting in opts.search). Pass only the structural tokens —
    // free text would re-restrict the set we're trying to broaden
    // via implicit color-name detection.
    const structuralTokens = (opts.search || '')
      .match(/(\w+:"[^"]*"|\w+:\S+|\S+)/g) || [];
    const filterOnly = structuralTokens.filter((t) => /^\w+:/.test(t)).join(' ');
    const filteredSet = getAllSaves({
      filter: opts.filter,
      collectionId: opts.collectionId,
      colorHex: opts.colorHex || undefined,
      search: filterOnly,
    });
    // Strict: ΔE 16 ("clearly the same color") + only the top 3 most
    // vibrant swatches per save (Vibrant / LightVibrant / DarkVibrant
    // from node-vibrant) so a stray dark-blue shadow on a red image
    // doesn't surface as a "blue" match.
    const colorMatches = filterByColor(filteredSet, detectedHex, 16, 3);
    if (colorMatches.length === 0) return results;
    const seen = new Set(results.map((s) => s.id));
    const merged = [...results];
    for (const m of colorMatches) {
      if (!seen.has(m.id)) {
        merged.push(m);
        seen.add(m.id);
      }
    }
    return merged;
  }

  ipcMain.handle('saves:get-all', async (_e, opts = {}) => {
    const semanticEnabled = settings.getPref('semanticSearch', true);
    const rawSearch = (opts.search || '').trim();

    // Pull out any tag:/bucket:/color:/before: etc. filters so the
    // embedding query runs only against the user's free text, and so
    // semantic candidates can be intersected with the structurally-
    // filtered set below. parseSearchQuery is also called inside
    // getAllSaves; doing it here too is cheap (regex tokenisation).
    const { parseSearchQuery } = require('./searchQuery');
    const parsed = parseSearchQuery(rawSearch);
    const queryText = parsed.text;

    if (!semanticEnabled || !queryText || typeof semanticSearch?.search !== 'function') {
      return mergeColorNameMatches(getAllSaves(opts), opts, queryText);
    }

    try {
      const result = await semanticSearch.search(rawSearch, opts);
      return mergeColorNameMatches(result?.results || [], opts, queryText);
    } catch (err) {
      console.error('Semantic search failed, falling back to LIKE:', err.message);
      return mergeColorNameMatches(getAllSaves(opts), opts, queryText);
    }
  });

  // Broadcast helper for save lifecycle events the renderer cares
  // about. Boards listen so they can drop any items referencing a
  // trashed/deleted save without the user having to reload the
  // board view.
  function broadcastSavesDeleted(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('save:deleted', { ids }); }
      catch { /* renderer may be tearing down */ }
    }
  }

  // Soft delete — sends the save to Trash. Files stay on disk until the
  // user permanently deletes or empties Trash.
  ipcMain.handle('saves:delete', (_e, id) => {
    const r = deleteSave(id);
    if (r?.ok) broadcastSavesDeleted([id]);
    refreshTray();
    return r;
  });

  ipcMain.handle('saves:restore', (_e, id) => {
    const r = restoreSave(id);
    refreshTray();
    return r;
  });

  // View bump for the "Most viewed" sort. Fire-and-forget; no event
  // emitted (see db.markSaveViewed).
  ipcMain.handle('saves:mark-viewed', (_e, id) => {
    const { markSaveViewed } = require('./db');
    markSaveViewed(id);
    return { ok: true };
  });
  ipcMain.handle('saves:recently-viewed', (_e, limit) => {
    const { getRecentlyViewed } = require('./db');
    return getRecentlyViewed(limit);
  });

  // Hard delete from Trash: also removes the underlying image + thumb.
  ipcMain.handle('saves:permanent-delete', async (_e, id) => {
    const result = permanentlyDeleteSave(id);
    let cleanupWarning = null;
    if (result.ok) {
      deleteImageFiles(result.filePath, result.thumbPath);
      cleanupWarning = await cleanupSaveDerivedBestEffort(id);
      broadcastSavesDeleted([id]);
    }
    refreshTray();
    return cleanupWarning ? { ...result, cleanupWarning } : result;
  });

  ipcMain.handle('saves:empty-trash', async () => {
    const result = emptyTrash();
    let cleanupFailures = [];
    if (result.ok) {
      for (const f of result.files) deleteImageFiles(f.filePath, f.thumbPath);
      const cleanupResults = await Promise.all(
        (result.ids || []).map((id) => cleanupSaveDerivedBestEffort(id)),
      );
      cleanupFailures = cleanupResults.filter(Boolean);
      if (result.ids?.length) broadcastSavesDeleted(result.ids);
    }
    refreshTray();
    const response = { ok: true, count: result.files.length };
    if (cleanupFailures.length > 0) {
      response.cleanupWarning = {
        reason: 'derived-cleanup-failed',
        count: cleanupFailures.length,
      };
    }
    return response;
  });

  ipcMain.handle('saves:counts', () => getSmartViewCounts());

  ipcMain.handle('smart-categories:list-nav', () => listNavigableSmartCategories());

  ipcMain.handle('smart-categories:hide', (_e, id) => hideSmartCategory(id));

  ipcMain.handle('smart-categories:pin', (_e, payload = {}) => {
    const id = typeof payload?.id === 'string' ? payload.id : null;
    return pinSmartCategory(id, payload?.pinned !== false);
  });

  ipcMain.handle('smart-categories:refresh', () => (
    smartCategoryRefresh?.requestRefresh?.() || { ok: false, reason: 'refresh-unavailable' }
  ));

  ipcMain.on('smart-categories:activity', (_event, payload = {}) => {
    if (!payload || typeof payload.kind !== 'string') return;
    smartCategoryRefresh?.noteActivity?.({
      kind: payload.kind,
      active: payload.active,
    });
  });

  ipcMain.handle('smart-categories:get-saves', async (_e, opts = {}) => {
    const categoryId = typeof opts?.categoryId === 'string' ? opts.categoryId : null;
    if (!categoryId) return [];
    const rows = getSmartCategorySaves(categoryId);
    const rawSearch = (opts.search || '').trim();
    const colorHex = opts.colorHex || null;
    if (!rawSearch && !colorHex) return rows;
    const allowed = new Set(
      getAllSaves({ search: rawSearch, colorHex, view: 'all' }).map((save) => save.id),
    );
    return rows.filter((save) => allowed.has(save.id));
  });

  // Open the OS file manager with the save's file selected. Returns
  // { ok: false } when the path is missing or can't be resolved so the
  // renderer can show a generic "couldn't reveal" toast.
  ipcMain.handle('saves:reveal-in-finder', (_e, filePath) => {
    if (!filePath || typeof filePath !== 'string') return { ok: false };
    try {
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (err) {
      console.error('reveal-in-finder failed:', err);
      return { ok: false };
    }
  });

  ipcMain.handle('saves:confirm-delete', async (e, count) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    const n = Math.max(1, Number(count) || 1);
    const result = await dialog.showMessageBox(owner ?? undefined, {
      type: 'warning',
      buttons: ['Cancel', n === 1 ? 'Delete' : `Delete ${n} Saves`],
      defaultId: 1,
      cancelId: 0,
      title: n === 1 ? 'Delete save?' : `Delete ${n} saves?`,
      message:
        n === 1
          ? 'Are you sure you want to delete this save?'
          : `Are you sure you want to delete these ${n} saves?`,
      detail: 'The image files will be permanently removed from your library.',
    });
    return result.response === 1;
  });

  ipcMain.handle('saves:update', async (_e, payload) => (
    enqueueAfterCanonicalMutation(updateSave(payload), payload?.id)
  ));

  ipcMain.handle('saves:drop-file', async (_e, filePath) => {
    if (blockNewSave('save')) return { needsUpgrade: true };
    const imgData = await saveImageFromFile(filePath);
    if (imgData.duplicateOf) {
      notifyDuplicate(imgData.existing);
      return imgData.existing;
    }
    const record = insertSave(imgData);
    notifySaved(record);
    return record;
  });

  // Import an image from raw clipboard bytes. A pasted image has no
  // filesystem path, so it can't go through saves:drop-file — the
  // renderer hands us the bytes and we run them through the same
  // saveImageFromBuffer → insertSave pipeline (dedup, palette, etc.).
  ipcMain.handle('saves:paste-image', async (_e, payload) => {
    if (blockNewSave('save')) return { needsUpgrade: true };
    const { bytes, ext } = payload || {};
    if (!bytes || !bytes.length) throw new Error('paste-image called without image bytes');
    const buffer = Buffer.from(bytes);
    const safeExt = typeof ext === 'string' && /^[a-z0-9]+$/i.test(ext)
      ? ext.toLowerCase()
      : 'png';
    const imgData = await saveImageFromBuffer(buffer, safeExt);
    if (imgData.duplicateOf) {
      notifyDuplicate(imgData.existing);
      return imgData.existing;
    }
    const record = insertSave(imgData);
    notifySaved(record);
    return record;
  });

  ipcMain.handle('saves:drop-zip', async (_e, zipPath) => {
    if (blockNewSave('save')) return { ok: false, needsUpgrade: true };
    if (!zipPath) throw new Error('drop-zip called without a path');
    try {
      const counts = await ingestZip(zipPath);
      return { ok: true, ...counts };
    } catch (err) {
      console.error('[saves:drop-zip] failed:', err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Onboarding starter-pack: install bundled images on walkthrough
  // start, remove them if the user picks "start fresh" at the end.
  ipcMain.handle('onboarding:install-starter-pack', () => installStarterPack());
  ipcMain.handle('onboarding:remove-starter-pack', () => removeStarterPack());
  ipcMain.handle('onboarding:restore-snapshot', () => restoreSnapshot());

  // URL-kind saves: take a page URL, screenshot it via a hidden
  // BrowserWindow, insert a save row with kind='url' so the
  // FocusedView knows to swap the image for a live webview at
  // view time. Distinct from saves:drop-url, which treats the URL
  // as a direct image-file URL and downloads it.
  // Live preview for the Save-a-URL panel — fetch title/favicon/cover
  // without screenshotting. No entitlement gate (it's just a preview,
  // not a save).
  ipcMain.handle('saves:preview-url', async (_e, url) => {
    if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'missing_url' };
    try {
      const { fetchUrlPreview } = require('./urlPreview');
      return { ok: true, preview: await fetchUrlPreview(url.trim()) };
    } catch (err) {
      return { ok: false, error: err?.message || 'preview failed' };
    }
  });

  // Current in-app announcement (remote, no entitlement gate). Returns
  // the announcement object or null. Fail-silent — see announcement.js.
  ipcMain.handle('announcement:get', async () => {
    try {
      const { fetchAnnouncement } = require('./announcement');
      return { ok: true, announcement: await fetchAnnouncement() };
    } catch {
      return { ok: true, announcement: null };
    }
  });

  ipcMain.handle('saves:capture-url', async (_e, url) => {
    if (blockNewSave('save')) return { ok: false, needsUpgrade: true };
    if (typeof url !== 'string' || !url.trim()) {
      return { ok: false, error: 'missing_url' };
    }
    try {
      const captured = await captureUrl(url.trim());
      if (captured.duplicateOf) {
        notifyDuplicate(captured.existing);
        return { ok: true, record: captured.existing, duplicate: true };
      }
      const record = insertSave({
        ...captured,
        sourceUrl: url.trim(),
        kind: 'url',
      });
      notifySaved(record);
      return { ok: true, record };
    } catch (err) {
      console.error('[saves:capture-url] failed:', err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('saves:drop-url', async (_e, payload) => {
    if (blockNewSave('save')) return { needsUpgrade: true };
    const candidates = Array.isArray(payload?.urls)
      ? payload.urls
      : Array.isArray(payload)
        ? payload
        : [typeof payload === 'string' ? payload : payload?.url].filter(Boolean);
    if (candidates.length === 0) throw new Error('drop-url called without any URLs');

    // Expand search-engine wrapper URLs (Google /imgres?imgurl=…)
    // ahead of their wrapper so we try the real image URL first.
    // Already done by the renderer's extractDropImageUrls for drops
    // that go through it, but Dock-drop and direct callers don't,
    // and double-unwrapping is harmless because seen prevents dups.
    const expanded = [];
    const seen = new Set();
    for (const c of candidates) {
      const unwrapped = unwrapSearchEngineUrl(c);
      if (unwrapped && !seen.has(unwrapped)) {
        expanded.push(unwrapped);
        seen.add(unwrapped);
      }
      if (!seen.has(c)) {
        expanded.push(c);
        seen.add(c);
      }
    }

    const errors = [];
    let sawHtmlResponse = false;
    for (const url of expanded) {
      try {
        const imgData = await saveImageFromUrl(url);
        if (imgData.duplicateOf) {
          notifyDuplicate(imgData.existing);
          return imgData.existing;
        }
        const record = insertSave(imgData);
        notifySaved(record);
        return record;
      } catch (err) {
        if (/not an image/i.test(String(err?.message || err))) {
          sawHtmlResponse = true;
        }
        errors.push(`${url}: ${err.message}`);
      }
    }

    // Safari drops the surrounding page URL (HTML) rather than the
    // image URL like Chrome does. If every candidate fetched as
    // HTML, fall back to a URL-kind save: screenshot the first
    // candidate page and store it the same way the toolbar
    // "Save URL…" flow does. The result is a save the user can open
    // in the live webview, which is at least as useful as the image
    // they'd have expected.
    if (sawHtmlResponse) {
      const url = candidates[0];
      try {
        console.log('[saves:drop-url] all URLs returned HTML — falling back to URL-kind capture:', url);
        const captured = await captureUrl(url);
        if (captured.duplicateOf) {
          notifyDuplicate(captured.existing);
          return captured.existing;
        }
        const record = insertSave({ ...captured, sourceUrl: url, kind: 'url' });
        notifySaved(record);
        return record;
      } catch (err) {
        errors.push(`${url} (URL-kind fallback): ${err.message}`);
      }
    }

    throw new Error(`All ${candidates.length} URL(s) failed:\n${errors.join('\n')}`);
  });

  ipcMain.handle('collections:get-all', () => getAllCollections());
  ipcMain.handle('collections:get-all-with-thumbs', () => getAllCollectionsWithThumbs());
  ipcMain.handle('collections:get-for-save', (_e, saveId) => getCollectionsForSave(saveId));
  ipcMain.handle('collections:containing-all', (_e, saveIds) => getCollectionsContainingAll(saveIds));
  ipcMain.handle('collections:create', (_e, payload) => createCollection(payload));
  ipcMain.handle('collections:rename', (_e, payload) => renameCollection(payload));
  ipcMain.handle('collections:set-parent', (_e, payload) => setCollectionParent(payload));
  ipcMain.handle('collections:delete', (_e, id) => deleteCollection(id));
  ipcMain.handle('collections:reorder', (_e, ids) => reorderCollections(ids));
  ipcMain.handle('collections:add-save', (_e, payload) => addSaveToCollection(payload));
  ipcMain.handle('collections:remove-save', (_e, payload) => removeSaveFromCollection(payload));

  ipcMain.handle('boards:list', () => listBoards());
  ipcMain.handle('boards:list-with-thumbs', () => listBoardsWithThumbs());
  ipcMain.handle('boards:get', (_e, id) => getBoard(id));
  ipcMain.handle('boards:create', (_e, payload) => createBoard(payload));
  ipcMain.handle('boards:rename', (_e, payload) => renameBoard(payload));
  ipcMain.handle('boards:delete', (_e, id) => deleteBoard(id));
  ipcMain.handle('boards:reorder', (_e, ids) => reorderBoards(ids));
  ipcMain.handle('boards:get-items', (_e, boardId) => getBoardItems(boardId));
  ipcMain.handle('boards:get-preview-saves', (_e, boardId, limit) =>
    getBoardPreviewSaves(boardId, typeof limit === 'number' ? limit : 4),
  );
  ipcMain.handle('boards:get-save-ids', (_e, boardId) => getBoardSaveIds(boardId));
  ipcMain.handle('boards:get-for-save', (_e, saveId) => getBoardsForSave(saveId));
  ipcMain.handle('boards:upsert-item', (_e, payload) => upsertBoardItem(payload));
  ipcMain.handle('boards:bulk-update-items', (_e, payload) => bulkUpdateBoardItems(payload));
  ipcMain.handle('boards:delete-item', (_e, payload) => deleteBoardItem(payload));
  ipcMain.handle('boards:delete-items', (_e, payload) => deleteBoardItems(payload));

  ipcMain.handle('tags:get-all', () => getAllTags());
  ipcMain.handle('tags:get-for-save', (_e, saveId) => getTagsForSave(saveId));
  ipcMain.handle('tags:add-to-save', async (_e, payload) => (
    enqueueAfterCanonicalMutation(addTagToSave(payload), payload?.saveId)
  ));
  ipcMain.handle('tags:remove-from-save', async (_e, payload) => (
    enqueueAfterCanonicalMutation(removeTagFromSave(payload), payload?.saveId)
  ));
  ipcMain.handle('tags:rename', async (_e, payload) => {
    const saveIds = getSaveIdsForTag(payload?.id);
    return enqueueAfterCanonicalMutation(renameTag(payload), saveIds);
  });
  ipcMain.handle('tags:delete', async (_e, id) => {
    const saveIds = getSaveIdsForTag(id);
    return enqueueAfterCanonicalMutation(deleteTag(id), saveIds);
  });
  ipcMain.handle('tags:delete-unused', () => {
    const { deleteUnusedTags } = require('./db');
    return deleteUnusedTags();
  });

  ipcMain.handle('capture:screenshot', () => {
    startScreenshotCapture();
    return { ok: true };
  });

  // Dialog-free Screen Recording status for the onboarding capture
  // step — lets the renderer frame the macOS permission ask up front.
  ipcMain.handle('capture:permission-status', () => {
    const { getScreenPermissionStatus } = require('./capture');
    return getScreenPermissionStatus();
  });

  ipcMain.handle('capture:fullscreen', () => {
    captureFullscreen();
    return { ok: true };
  });

  // Window full-screen toggle, used by the Present button on Spaces.
  // Operates on the focused window (which in normal use is the only
  // BrowserWindow — toast / overlay windows can't take focus).
  ipcMain.handle('window:set-fullscreen', (e, on) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return { ok: false };
    win.setFullScreen(!!on);
    return { ok: true, fullscreen: win.isFullScreen() };
  });
  ipcMain.handle('window:toggle-fullscreen', (e) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return { ok: false };
    win.setFullScreen(!win.isFullScreen());
    return { ok: true, fullscreen: win.isFullScreen() };
  });
  ipcMain.handle('window:is-fullscreen', (e) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return false;
    return win.isFullScreen();
  });
  ipcMain.handle('capture:window', () => {
    captureWindow();
    return { ok: true };
  });

  ipcMain.handle('image:open-in-preview', (_e, filePath) => {
    shell.openPath(filePath);
    return { ok: true };
  });

  // Native macOS Share sheet for a single save. Builds an Electron
  // native menu containing the system share submenu (role:'shareMenu'
  // with sharingItem) and pops it at the cursor. The user gets the
  // standard AirDrop / Messages / Mail / Notes / Photos / Reminders
  // / Add to Reading List etc. options the OS provides for whatever
  // types we hand it.
  ipcMain.handle('share:save', (event, payload = {}) => {
    if (process.platform !== 'darwin') return { ok: false, reason: 'macos_only' };
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : null;
    const sourceUrl = typeof payload.sourceUrl === 'string' ? payload.sourceUrl : null;
    if (!filePath && !sourceUrl) return { ok: false, reason: 'nothing_to_share' };
    const sharingItem = {};
    if (filePath) sharingItem.filePaths = [filePath];
    if (sourceUrl) sharingItem.urls = [sourceUrl];
    const menu = Menu.buildFromTemplate([
      { role: 'shareMenu', label: 'Share', sharingItem },
    ]);
    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    menu.popup({
      window: win,
      x: typeof payload.x === 'number' ? Math.round(payload.x) : undefined,
      y: typeof payload.y === 'number' ? Math.round(payload.y) : undefined,
    });
    return { ok: true };
  });

  // Write the actual image bytes to the system clipboard so the user
  // can paste into Figma, Slack, Mail, etc. Uses nativeImage rather
  // than a file URL — most apps treat that as a real image paste,
  // not a link. Returns { ok: false } silently on missing files so
  // a stale UI doesn't crash the renderer.
  ipcMain.handle('image:copy-to-clipboard', (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, reason: 'file-missing' };
      }
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) {
        return { ok: false, reason: 'unreadable' };
      }
      clipboard.writeImage(img);
      return { ok: true };
    } catch (err) {
      console.error('[gatheros] copy-to-clipboard failed:', err);
      return { ok: false, reason: err?.message || String(err) };
    }
  });

  ipcMain.handle('shell:open-url', (_e, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, reason: 'invalid-url' };
    }
    shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('image:export', async (e, { filePath, defaultName } = {}) => {
    if (!filePath) return { ok: false, reason: 'no-path' };
    const owner = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showSaveDialog(owner ?? undefined, {
      defaultPath: defaultName || path.basename(filePath),
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      await fs.promises.copyFile(filePath, result.filePath);
      return { ok: true, savedPath: result.filePath };
    } catch (err) {
      console.error('export failed:', err);
      return { ok: false, error: err.message };
    }
  });

  // Bulk file export: pick a folder, copy each selected save's
  // underlying image into it. Names collide with `name (1).png`,
  // `name (2).png`, ... so nothing in the destination gets overwritten.
  ipcMain.handle('saves:export-bulk', async (e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, reason: 'no-ids' };
    const records = ids.map(getSave).filter(Boolean);
    if (records.length === 0) return { ok: false, reason: 'no-saves' };

    const owner = BrowserWindow.fromWebContents(e.sender);
    const dlg = await dialog.showOpenDialog(owner ?? undefined, {
      title: 'Export images to…',
      buttonLabel: 'Export',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (dlg.canceled || !dlg.filePaths?.[0]) return { ok: false, canceled: true };
    const targetDir = dlg.filePaths[0];

    const fileExists = async (p) => {
      try { await fs.promises.access(p); return true; } catch { return false; }
    };
    const safeName = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'image';

    let count = 0;
    for (const r of records) {
      if (!r.file_path) continue;
      const ext = (path.extname(r.file_path) || '.png');
      const stem = safeName(r.title) || safeName(path.basename(r.file_path, path.extname(r.file_path)));
      let candidate = path.join(targetDir, `${stem}${ext}`);
      let n = 1;
      while (await fileExists(candidate)) {
        candidate = path.join(targetDir, `${stem} (${n})${ext}`);
        n++;
      }
      try {
        await fs.promises.copyFile(r.file_path, candidate);
        count++;
      } catch (err) {
        console.error('Bulk export failed for', r.id, err);
      }
    }
    return { ok: true, count, targetDir };
  });

  // Same as saves:export-bulk but bundles into a single zip instead of
  // copying loose files. Uses macOS's `zip` CLI with -j so the archive
  // is flat (no source paths) and -X to drop extra macOS attrs.
  ipcMain.handle('saves:export-bulk-zip', async (e, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, reason: 'no-ids' };
    const records = ids.map(getSave).filter(Boolean);
    if (records.length === 0) return { ok: false, reason: 'no-saves' };

    const owner = BrowserWindow.fromWebContents(e.sender);
    const stamp = new Date().toISOString().slice(0, 10);
    const dlg = await dialog.showSaveDialog(owner ?? undefined, {
      title: 'Export selection as zip',
      buttonLabel: 'Export',
      defaultPath: `moodmark-export-${stamp}.zip`,
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (dlg.canceled || !dlg.filePath) return { ok: false, canceled: true };

    // Stage in a temp dir so we control filenames and dedupe
    // collisions before handing them to `zip`.
    const tmpDir = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'moodmark-export-'));
    const safeName = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'image';

    let count = 0;
    try {
      for (const r of records) {
        if (!r.file_path) continue;
        const ext = (path.extname(r.file_path) || '.png');
        const stem = safeName(r.title) || safeName(path.basename(r.file_path, path.extname(r.file_path)));
        let candidate = path.join(tmpDir, `${stem}${ext}`);
        let n = 1;
        while (fs.existsSync(candidate)) {
          candidate = path.join(tmpDir, `${stem} (${n})${ext}`);
          n++;
        }
        await fs.promises.copyFile(r.file_path, candidate);
        count++;
      }
      const result = await new Promise((resolve) => {
        const args = ['-jXq', dlg.filePath, ...fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f))];
        const proc = spawn('zip', args);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve({ ok: true, savedPath: dlg.filePath, count });
          else resolve({ ok: false, error: `zip exited with code ${code}: ${stderr.trim()}` });
        });
        proc.on('error', (err) => resolve({ ok: false, error: err.message }));
      });
      return result;
    } finally {
      // Best-effort cleanup of the staging dir.
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  // Local DB-only backup snapshots. Powers Settings → Data → Backups.
  ipcMain.handle('backup:list', () => {
    const { listSnapshots } = require('./backup');
    return listSnapshots();
  });
  ipcMain.handle('backup:snapshot', () => {
    const { snapshotLibraryDb } = require('./backup');
    return snapshotLibraryDb();
  });
  ipcMain.handle('backup:restore', async (_e, snapshotPath) => {
    if (typeof backgroundRuntime?.restoreBackup !== 'function') {
      return { ok: false, reason: 'runtime-unavailable' };
    }
    return backgroundRuntime.restoreBackup(snapshotPath);
  });

  // Full library backup as a single .zip — includes the SQLite DB,
  // images/, and thumbs/. Uses the macOS `zip` CLI (built in) so no
  // new node deps. Returns { ok, savedPath, count? } or { canceled }.
  ipcMain.handle('library:export-zip', async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    const stamp = new Date().toISOString().slice(0, 10);
    const dlg = await dialog.showSaveDialog(owner ?? undefined, {
      title: 'Export GatherOS library',
      buttonLabel: 'Export',
      defaultPath: `moodmark-backup-${stamp}.zip`,
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (dlg.canceled || !dlg.filePath) return { ok: false, canceled: true };

    // Flush the WAL into the main db file so the zipped moodmark.db is a
    // complete, self-consistent snapshot (writes can live in -wal until a
    // checkpoint). Best-effort — we still include the sidecars below.
    try {
      const { getDatabase } = require('./db');
      getDatabase().pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.warn('[export-zip] wal checkpoint failed (continuing):', err?.message || err);
    }

    // The library lives under its own root now —
    // userData/libraries/library_<id>/{moodmark.db,images,thumbs} — not
    // the userData root (that's why this used to find nothing and bail).
    const { getActiveLibraryRoot } = require('./library-registry');
    const libRoot = getActiveLibraryRoot();
    if (!libRoot) return { ok: false, reason: 'no-active-library' };
    // Whitelist what we ship; include the db sidecars so the restore is
    // consistent even if the checkpoint above couldn't run.
    const includes = ['moodmark.db', 'moodmark.db-wal', 'moodmark.db-shm', 'images', 'thumbs'];
    const present = includes.filter((p) => fs.existsSync(path.join(libRoot, p)));
    if (!present.includes('moodmark.db')) return { ok: false, reason: 'nothing-to-export' };

    return new Promise((resolve) => {
      // -r recursive, -X drop extra macOS attrs, -q quiet.
      const args = ['-rXq', dlg.filePath, ...present, '-x', '*.DS_Store'];
      const proc = spawn('zip', args, { cwd: libRoot });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true, savedPath: dlg.filePath });
        else resolve({ ok: false, error: `zip exited with code ${code}: ${stderr.trim()}` });
      });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  });

  // Triggered by the in-app "Restart to update" pill. Closes the
  // window cleanly and relaunches into the freshly-installed version.
  ipcMain.handle('updater:install', () => {
    quitAndInstall();
    return { ok: true };
  });

  // Nuclear "Erase Library" — guarded by a native confirm dialog
  // because there's no undo. Wipes every save / bucket / tag, then
  // unlinks the underlying image and thumbnail files off disk.
  ipcMain.handle('library:wipe-all', async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    const dlg = await dialog.showMessageBox(owner ?? undefined, {
      type: 'warning',
      buttons: ['Cancel', 'Erase Library'],
      defaultId: 0,
      cancelId: 0,
      title: 'Erase Library',
      message: 'Erase your entire library?',
      detail: 'Every save, bucket, and tag will be permanently deleted. This cannot be undone.',
    });
    if (dlg.response !== 1) return { ok: false, canceled: true };
    const result = wipeLibrary();
    for (const f of result.files) deleteImageFiles(f.filePath, f.thumbPath);
    const cleanupWarning = await cleanupAllDerivedBestEffort();
    const response = { ok: true, removed: result.files.length };
    return cleanupWarning ? { ...response, cleanupWarning } : response;
  });

  // PNG snapshot of the current board view. Renderer measures the
  // canvas DOM rect (with the user's current pan/zoom + items in
  // view) and hands us those coords; we pass them to capturePage so
  // chrome (toolbar / sidebar / detail panel) is excluded.
  ipcMain.handle('boards:export-png', async (event, payload = {}) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return { ok: false, reason: 'no_window' };
    const { rect, defaultName } = payload;
    if (!rect || typeof rect.width !== 'number' || typeof rect.height !== 'number') {
      return { ok: false, reason: 'no_rect' };
    }

    const dlg = await dialog.showSaveDialog(owner, {
      title: 'Export board as PNG',
      buttonLabel: 'Export',
      defaultPath: defaultName || 'board.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (dlg.canceled || !dlg.filePath) return { ok: false, canceled: true };

    try {
      const image = await event.sender.capturePage({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      await fs.promises.writeFile(dlg.filePath, image.toPNG());
      return { ok: true, savedPath: dlg.filePath };
    } catch (err) {
      console.error('[boards:export-png] failed:', err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('boards:export', async (e, saveIds) => {
    if (!Array.isArray(saveIds) || saveIds.length === 0) {
      return { ok: false, reason: 'no-ids' };
    }
    const saves = saveIds.map(getSave).filter(Boolean);
    if (saves.length === 0) return { ok: false, reason: 'no-saves' };

    const owner = BrowserWindow.fromWebContents(e.sender);
    const stamp = new Date().toISOString().slice(0, 10);
    const dialogResult = await dialog.showSaveDialog(owner ?? undefined, {
      defaultPath: `moodmark-board-${stamp}.gif`,
      filters: [{ name: 'Animated GIF', extensions: ['gif'] }],
    });
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      const meta = await composeMoodBoardGif(saves, dialogResult.filePath);
      // Pop the file in Finder so the user can immediately see / drag it.
      shell.showItemInFolder(dialogResult.filePath);
      return { ok: true, savedPath: dialogResult.filePath, ...meta };
    } catch (err) {
      console.error('Board export failed:', err);
      return { ok: false, error: err.message };
    }
  });

  // ── AI provider status ────────────────────────────────────────────────
  // GatherLocal runs AI through Codex subscription auth or local model
  // servers. The renderer only needs a coarse configured/unconfigured
  // answer so it can show AI actions without a Platform API key flow.
  ipcMain.handle('ai:has-session', () => hasAiSession());

  ipcMain.handle('ai:usage', async () => {
    const usage = await getAiUsage();
    return usage || { ok: false };
  });

  ipcMain.handle('settings:get-prefs', () => settings.getPrefs());

  ipcMain.handle('settings:set-pref', (_e, payload = {}) => {
    if (!payload.name) return { ok: false, reason: 'no-name' };
    const result = settings.setPref(payload.name, payload.value);
    // Side-effects: a couple of prefs need to push their new value to
    // wherever it's consumed in the main process (the renderer's
    // pref read happens on next mount, which is fine for everything
    // else).
    try {
      if (payload.name === 'captureShortcut') {
        const capture = require('./capture');
        capture.applyShortcut?.(payload.value);
      } else if (payload.name === 'updatesAuto' || payload.name === 'updatesChannel') {
        const updater = require('./updater');
        updater.applyPrefs?.();
      }
    } catch (err) {
      console.warn('[settings] pref side-effect failed:', err.message);
    }
    return result;
  });

  // Native folder picker — used by the Capture settings page to set
  // the drop-folder where screenshots also land as files.
  ipcMain.handle('settings:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose folder',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { path: result.filePaths[0] };
  });

  // Manual "Check for updates" trigger from the Updates settings page.
  // Returns a coarse status so the UI can show feedback immediately
  // (background download events come through the existing update-ready
  // / update-error channels).
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { unsupported: true };
    try {
      const updater = require('./updater');
      return await updater.checkNow();
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  // ── Semantic index and search ────────────────────────────────────────────
  function semanticStatusSnapshot() {
    const snapshot = typeof semanticIndex?.status === 'function' ? semanticIndex.status() : {};
    let health = {};
    try {
      const cached = backgroundRuntime?.getSemanticHealth?.();
      if (cached && typeof cached === 'object' && typeof cached.then !== 'function') health = cached;
    } catch {}
    const healthStatus = health.status || null;
    const connected = typeof health.connected === 'boolean'
      ? health.connected
      : health.ok === true || healthStatus === 'connected' || healthStatus === 'model-missing';
    const modelInstalled = typeof health.modelInstalled === 'boolean'
      ? health.modelInstalled
      : healthStatus === 'connected'
        ? true
        : healthStatus === 'model-missing'
          ? false
          : null;
    return { ...snapshot, ...health, connected, modelInstalled };
  }

  ipcMain.handle('semantic-index:status', () => semanticStatusSnapshot());
  ipcMain.handle('semantic-index:queue', () => {
    if (typeof semanticIndex?.queue !== 'function') return [];
    const status = semanticStatusSnapshot();
    const generationIds = new Set([
      status.active_generation_id,
      status.building_generation_id,
    ].filter(Boolean));
    return semanticIndex.queue()
      .filter((job) => generationIds.has(job.generation_id))
      .map((job) => ({
        ...job,
        domain: 'semantic-index',
        title: getSave(job.save_id)?.title || 'Untitled save',
      }));
  });
  ipcMain.handle('semantic-index:pause', () => (
    semanticIndex?.pause?.() || { ok: false, reason: 'semantic-index-unavailable' }
  ));
  ipcMain.handle('semantic-index:resume', () => (
    semanticIndex?.resume?.() || { ok: false, reason: 'semantic-index-unavailable' }
  ));
  ipcMain.handle('semantic-index:retry-failed', (_event, ids) => (
    semanticIndex?.retryFailed?.(Array.isArray(ids) ? ids : [])
      || { ok: false, reason: 'semantic-index-unavailable' }
  ));
  ipcMain.handle('semantic-index:dismiss-failed', (_event, ids) => (
    semanticIndex?.dismissFailed?.(Array.isArray(ids) ? ids : [])
      || { ok: false, reason: 'semantic-index-unavailable' }
  ));
  ipcMain.handle('semantic-index:start-rebuild', () => (
    semanticIndex?.startRebuild?.() || { ok: false, reason: 'semantic-index-unavailable' }
  ));
  ipcMain.handle('semantic-index:cancel-rebuild', () => (
    semanticIndex?.cancelRebuild?.() || { ok: false, reason: 'semantic-index-unavailable' }
  ));

  ipcMain.handle('saves:find-similar', async (_event, saveId, limit = 24) => {
    if (!saveId || typeof semanticSearch?.findSimilar !== 'function') return [];
    const result = await semanticSearch.findSimilar(saveId, { limit });
    return result?.results || [];
  });
  ipcMain.handle('ai:similar-saves', async (_event, saveId, limit = 5) => {
    if (!saveId || typeof semanticSearch?.findSimilar !== 'function') return [];
    const result = await semanticSearch.findSimilar(saveId, { limit });
    return result?.results || [];
  });
  ipcMain.handle('ai:unindexed-count', () => {
    const status = semanticStatusSnapshot();
    return Math.max(0, (Number(status.total) || 0) - (Number(status.indexed) || 0));
  });
  ipcMain.handle('ai:reindex-library', () => (
    semanticIndex?.startRebuild?.() || { ok: false, reason: 'semantic-index-unavailable' }
  ));

  // ── Video analysis suggestions ──────────────────────────────────────────
  function videoSnapshot(saveId) {
    if (!saveId) return { analysis: null, suggestions: [] };
    return {
      analysis: getVideoAnalysis(saveId) || null,
      suggestions: listVideoTagSuggestions(saveId) || [],
    };
  }

  function broadcastVideoUpdated(event, saveId) {
    if (!saveId) return;
    try { event?.sender?.send('video-analysis:updated', { saveId }); } catch {}
    for (const win of BrowserWindow.getAllWindows()) {
      if (win?.webContents === event?.sender || win?.isDestroyed?.()) continue;
      try { win.webContents.send('video-analysis:updated', { saveId }); } catch {}
    }
  }

  ipcMain.handle('video-analysis:get-for-save', (_event, saveId) => videoSnapshot(saveId));
  ipcMain.handle('video-analysis:accept', async (event, input) => {
    const suggestionId = typeof input === 'string' ? input : input?.suggestionId;
    const result = acceptVideoTagSuggestion({ suggestionId });
    if (result?.ok) {
      const semanticWarning = await enqueueSemanticBestEffort(result.saveId);
      broadcastVideoUpdated(event, result.saveId);
      return semanticWarning ? { ...result, semanticWarning } : result;
    }
    return result;
  });
  ipcMain.handle('video-analysis:dismiss', async (event, input) => {
    const suggestionId = typeof input === 'string' ? input : input?.suggestionId;
    const result = dismissVideoTagSuggestion({ suggestionId });
    if (result?.ok) broadcastVideoUpdated(event, result.saveId);
    return result;
  });
  ipcMain.handle('video-analysis:accept-all', async (event, saveId) => {
    const unresolved = (listVideoTagSuggestions(saveId) || [])
      .filter((suggestion) => suggestion.state === 'suggested');
    let accepted = 0;
    for (const suggestion of unresolved) {
      const result = acceptVideoTagSuggestion({ suggestionId: suggestion.id });
      if (result?.ok) accepted += 1;
    }
    if (accepted > 0) {
      const semanticWarning = await enqueueSemanticBestEffort(saveId);
      broadcastVideoUpdated(event, saveId);
      return semanticWarning
        ? { ok: true, accepted, semanticWarning }
        : { ok: true, accepted };
    }
    return { ok: true, accepted };
  });
  ipcMain.handle('video-analysis:dismiss-all', async (event, saveId) => {
    const unresolved = (listVideoTagSuggestions(saveId) || [])
      .filter((suggestion) => suggestion.state === 'suggested');
    let dismissed = 0;
    for (const suggestion of unresolved) {
      const result = dismissVideoTagSuggestion({ suggestionId: suggestion.id });
      if (result?.ok) dismissed += 1;
    }
    if (dismissed > 0) broadcastVideoUpdated(event, saveId);
    return { ok: true, dismissed };
  });

  // Settings → Storage. Usage readout + the opt-in reclaim sweep.
  ipcMain.handle('storage:get-usage', () => getStorageUsage());
  ipcMain.handle('storage:reclaim', async (event) =>
    reclaimLibraryStorage({
      onProgress: (p) => event.sender.send('storage:reclaim-progress', p),
      // Patch each repointed save into the live grid so a reclaimed
      // image opens from its new path without a full reload.
      onUpdated: (rec) => { if (rec) event.sender.send('save:updated', rec); },
    }),
  );

  // Generate an image-generation prompt (Midjourney / DALL-E / SD)
  // that recreates the focused save. Persists onto saves.ai_prompt and
  // emits save:updated so the renderer's local copy patches in place.
  ipcMain.handle('ai:generate-prompt', async (event, saveId) => {
    if (!saveId) return { ok: false, reason: 'no-save-id' };
    if (!hasAiSession()) return { ok: false, reason: 'no-session' };
    const save = getSave(saveId);
    if (!save) return { ok: false, reason: 'save-not-found' };
    if (isVideoSave(save)) return { ok: false, reason: 'image-ai-unavailable-for-video' };

    event.sender.send('save:indexing-start', saveId);
    try {
      const prompt = await generateImagePrompt(save.file_path);
      if (!prompt) return { ok: false, reason: 'empty-response' };
      updateSave({ id: saveId, aiPrompt: prompt });
      const updated = getSave(saveId);
      event.sender.send('save:updated', updated);
      return { ok: true, prompt };
    } catch (err) {
      console.error('Generate prompt failed:', err.message);
      return { ok: false, reason: err.code || "api-error", detail: err.message };
    } finally {
      event.sender.send('save:indexing-end', saveId);
    }
  });

  // Generate a fresh variation of an existing save when the configured
  // local provider exposes image bytes. Codex subscription auth does not
  // expose a generic image-generation byte API, so that provider returns
  // image_generation_unavailable here.
  ipcMain.handle('ai:generate-variant', async (event, saveId, options = {}) => {
    // AI generation is a pro feature and also creates a new save — both
    // gated in the free tier.
    if (blockNewSave('ai')) return { ok: false, needsUpgrade: true };
    if (!saveId) return { ok: false, reason: 'no-save-id' };
    if (!hasAiSession()) return { ok: false, reason: 'no-session' };
    if (aiVariantBusy) {
      return {
        ok: false,
        reason: 'ai-busy',
        detail: 'AI is already working. Try again in a moment.',
      };
    }
    const save = getSave(saveId);
    if (!save) return { ok: false, reason: 'save-not-found' };
    if (isVideoSave(save)) return { ok: false, reason: 'image-ai-unavailable-for-video' };

    aiVariantBusy = true;
    event.sender.send('save:indexing-start', saveId);
    try {
      // Prompt + aspect come from the modal. Local image providers may
      // only support a subset of sizes; unsupported providers fail with
      // a clear image_generation_unavailable reason.
      const ASPECT_MAP = {
        auto:  { size: 'auto',       crop: null },
        '1:1':   { size: '1024x1024',  crop: null },
        '3:4':   { size: '1024x1536',  crop: 3 / 4 },
        '9:16':  { size: '1024x1536',  crop: 9 / 16 },
        '4:3':   { size: '1536x1024',  crop: 4 / 3 },
        '16:9':  { size: '1536x1024',  crop: 16 / 9 },
      };
      const aspect = ASPECT_MAP[options.aspect] || ASPECT_MAP.auto;
      const prompt = (options.prompt || '').trim() ||
        'Create a fresh variation of this image. Keep the composition and palette.';
      const { bytes: rawBytes, quota } = await generateImage(prompt, {
        sourceFilePath: save.file_path,
        size: aspect.size,
      });

      // Center-crop the generated PNG to the exact requested aspect
      // when it differs from the native generation size. Skipped for
      // 'auto' and 1:1 native matches.
      let bytes = rawBytes;
      if (aspect.crop) {
        const sharp = require('sharp');
        const meta = await sharp(rawBytes).metadata();
        const gw = meta.width || 0;
        const gh = meta.height || 0;
        if (gw && gh) {
          const generated = gw / gh;
          let cw = gw;
          let ch = gh;
          if (aspect.crop > generated) {
            ch = Math.round(gw / aspect.crop);
          } else if (aspect.crop < generated) {
            cw = Math.round(gh * aspect.crop);
          }
          if (cw !== gw || ch !== gh) {
            const left = Math.round((gw - cw) / 2);
            const top = Math.round((gh - ch) / 2);
            bytes = await sharp(rawBytes)
              .extract({ left, top, width: cw, height: ch })
              .png()
              .toBuffer();
          }
        }
      }

      const imgData = await saveImageFromBuffer(bytes, 'png');
      if (imgData.duplicateOf) {
        // Identical pixels to an existing save (very unlikely for a
        // generation but cheap to handle). Surface the existing one
        // and don't re-insert.
        return { ok: true, save: imgData.existing, quota, duplicate: true };
      }
      const record = insertSave({
        ...imgData,
        // Carry the source's title onto the variant so the new save
        // reads as related, not blank. The renderer can rename it
        // freely afterwards.
        title: save.title ? `${save.title} (variant)` : null,
      });
      // Notify the renderer so the masonry refreshes with the new
      // save in place. Reuses the same save:created channel that
      // drag-and-drop uses.
      try {
        notifySaved(record);
      } catch {
        /* best-effort */
      }
      return { ok: true, save: record, quota };
    } catch (err) {
      console.error('Generate variant failed:', err.message);
      return { ok: false, reason: err.code || "api-error", detail: err.message };
    } finally {
      aiVariantBusy = false;
      event.sender.send('save:indexing-end', saveId);
    }
  });


  ipcMain.handle('ai:auto-tag', async (_e, saveId) => {
    if (!saveId) return { ok: false, reason: 'no-save-id' };
    if (!hasAiSession()) return { ok: false, reason: 'no-session' };
    const save = getSave(saveId);
    if (!save) return { ok: false, reason: 'save-not-found' };
    if (isVideoSave(save)) return { ok: false, reason: 'image-ai-unavailable-for-video' };
    try {
      const tags = await autoTagImage(save.file_path);
      // Persist via the existing tag pipeline so dedupe + creation
      // semantics match the manual flow.
      const added = [];
      for (const name of tags) {
        const result = addTagToSave({ saveId, name });
        if (result.ok && result.tag) added.push(result.tag);
      }
      return enqueueAfterCanonicalMutation(
        { ok: true, tags: added },
        added.length > 0 ? saveId : null,
      );
    } catch (err) {
      console.error('Auto-tag failed:', err.message);
      return { ok: false, reason: err.code || "api-error", detail: err.message };
    }
  });

  // Drag-out: forwards from a renderer dragstart into the OS drag layer
  // via webContents.startDrag. macOS requires a non-empty icon, so we
  // build one from the thumb (or fall back to the source file) and
  // resize it to a reasonable drag-icon size.
  ipcMain.on('drag:start', (event, payload = {}) => {
    const files = Array.isArray(payload.files) ? payload.files.filter(Boolean) : [];
    if (files.length === 0) return;

    let icon = null;
    try {
      const iconSource = payload.thumbPath || files[0];
      const img = nativeImage.createFromPath(iconSource);
      if (!img.isEmpty()) {
        icon = img.resize({ width: 80, quality: 'best' });
      } else {
        // Thumb missing/unreadable — fall back to the original file.
        const fallback = nativeImage.createFromPath(files[0]);
        if (!fallback.isEmpty()) icon = fallback.resize({ width: 80, quality: 'best' });
      }
    } catch (err) {
      console.error('Drag icon load failed:', err);
    }
    if (!icon) icon = nativeImage.createEmpty();

    try {
      if (files.length === 1) {
        event.sender.startDrag({ file: files[0], icon });
      } else {
        event.sender.startDrag({ files, icon });
      }
    } catch (err) {
      console.error('startDrag failed:', err);
    }
  });

  ipcMain.on('toast:set-interactive', (_e, interactive) => {
    setToastInteractive(!!interactive);
  });

  ipcMain.on('toast:empty', () => {
    onToastsEmpty();
  });

  // Undo from the save toast — soft-delete the records that were just
  // saved in this toast session. Mirrors saves:delete (Trash, not a
  // hard delete; files stay on disk) and broadcasts so the open grid
  // drops the cards immediately.
  ipcMain.handle('toast:undo-saves', (_e, ids) => {
    const list = Array.isArray(ids) ? ids.filter((id) => id != null) : [];
    const removed = [];
    for (const id of list) {
      try {
        if (deleteSave(id)?.ok) removed.push(id);
      } catch (err) {
        console.error('[gatheros] toast undo failed for', id, err);
      }
    }
    if (removed.length) broadcastSavesDeleted(removed);
    refreshTray();
    return { ok: true, count: removed.length };
  });

  // ─── Licensing ──────────────────────────────────────────────
  // Renderer asks for the entitlement state on launch + on every
  // window focus; main process owns the session token + cache.
  const licensing = require('./licensing');
  ipcMain.handle('licensing:request-magic-link', (_e, email) =>
    licensing.requestMagicLink(email),
  );
  ipcMain.handle('licensing:verify', (_e, opts) =>
    licensing.verifyLicense(opts || {}),
  );
  ipcMain.handle('licensing:has-session', () => licensing.hasSession());
  ipcMain.handle('licensing:sign-out', () => licensing.signOut());

  // Exchange a magic-link token directly for a session. The gatheros://
  // deep link only resolves in the packaged app (its Info.plist registers
  // the scheme), so under `npm run dev` the email link goes nowhere —
  // paste the token here from DevTools instead:
  //   await window.moodmark.licensing.exchange("<token-from-the-email-link>")
  // Persists the session and fires the same auth-result the deep-link
  // handler does, so the UI signs in. Harmless in production: it still
  // requires a valid, single-use token only the user's email provides.
  ipcMain.handle('licensing:exchange', async (e, token) => {
    const result = await licensing.exchangeMagicToken(token);
    try { e.sender.send('licensing:auth-result', result); } catch { /* ignore */ }
    return result;
  });

  // Combined entitlement (local trial + server subscription) the renderer
  // uses to show the trial countdown / free-tier meter and to know when to
  // surface upgrade prompts.
  ipcMain.handle('entitlement:get', () => require('./entitlement').getEntitlement());
  // Mints a customer-portal URL and opens it in the user's default
  // browser. Renderer doesn't need to handle the URL itself — we open
  // it in main so the user lands on the secure session without us
  // ever exposing the URL to the page context.
  ipcMain.handle('licensing:open-customer-portal', async () => {
    const result = await licensing.customerPortal();
    if (result?.ok && result.url) {
      try { await shell.openExternal(result.url); } catch (err) {
        return { ok: false, error: 'open_failed' };
      }
      return { ok: true };
    }
    return { ok: false, error: result?.error || 'unknown' };
  });
  // Mints a Lemon Squeezy checkout URL for the chosen plan and opens
  // it externally. The same shell.openExternal pattern works on both
  // localhost dev (renderer talks to our worker) and the packaged
  // file:// app (no domain-whitelist gymnastics).
  ipcMain.handle('licensing:open-checkout', async (_e, plan) => {
    const result = await licensing.createCheckout(plan);
    if (result?.ok && result.url) {
      try { await shell.openExternal(result.url); } catch (err) {
        return { ok: false, error: 'open_failed' };
      }
      return { ok: true };
    }
    return { ok: false, error: result?.error || 'unknown' };
  });
}

module.exports = { registerIpcHandlers };
