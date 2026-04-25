import React, { useCallback, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import Grid from './components/Grid.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import FocusedView from './components/FocusedView.jsx';
import { useLibrary } from './hooks/useLibrary.js';

function pickLargestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  let bestWidth = -1;
  for (const part of srcset.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [url, descriptor] = trimmed.split(/\s+/);
    const w = descriptor && descriptor.endsWith('w')
      ? parseFloat(descriptor)
      : descriptor && descriptor.endsWith('x')
        ? parseFloat(descriptor) * 1000 // arbitrary weight so 2x > 1x
        : 0;
    if (url && w > bestWidth) {
      best = url;
      bestWidth = w;
    }
  }
  return best;
}

function looksLikeImageUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(u.pathname)) return true;
    // Common image CDN hosts that aren't the user-facing page.
    const cdnHosts = [
      'pbs.twimg.com', 'i.pinimg.com', 'i.imgur.com', 'i.redd.it',
      'preview.redd.it', 'media.tumblr.com', 'cdninstagram.com',
      'cdn.dribbble.com', 'mir-s3-cdn-cf.behance.net', 'images.unsplash.com',
      'cdn-images-1.medium.com', 'substackcdn.com', 'fbcdn.net',
    ];
    return cdnHosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function extractDropImageUrls(dataTransfer) {
  const seen = new Set();
  const candidates = [];
  const add = (url) => {
    if (!url) return;
    let u = url.trim();
    if (!u || seen.has(u)) return;
    if (!/^(https?:|data:)/i.test(u)) return;
    seen.add(u);
    candidates.push(u);
  };

  let pageUrl = null;

  // 1. text/html — collect every <img> we can find AND look for an <a>
  //    that wraps the image; that link's href is almost always the page
  //    URL the user was on (Pinterest pin, Tumblr post, Reddit thread, etc.).
  const html = dataTransfer.getData('text/html');
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const anchor = doc.querySelector('a[href]');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href && /^https?:\/\//i.test(href) && !looksLikeImageUrl(href)) {
          pageUrl = href;
        }
      }
      for (const img of doc.querySelectorAll('img')) {
        add(pickLargestFromSrcset(img.getAttribute('srcset')));
        add(img.getAttribute('src'));
        add(img.getAttribute('data-src'));
        add(img.getAttribute('data-original'));
      }
    } catch {
      const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) add(m[1]);
    }
  }

  // 2. text/uri-list — first non-comment line is the dragged URL.
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) add(t);
    }
  }

  // 3. text/plain fallback.
  const text = dataTransfer.getData('text/plain');
  if (text) add(text);

  // 4. If the HTML fragment didn't give us a page URL, fall back to the
  //    uri-list — but only if it doesn't itself look like an image URL.
  if (!pageUrl && uriList) {
    const firstUri = uriList
      .split(/\r?\n/)
      .find((l) => l && !l.startsWith('#'))
      ?.trim();
    if (firstUri && !looksLikeImageUrl(firstUri) && firstUri !== candidates[0]) {
      pageUrl = firstUri;
    }
  }

  return { candidates, sourceUrl: pageUrl };
}

export default function App() {
  const {
    saves,
    loading,
    view,
    setView,
    search,
    setSearch,
    toggleFavorite,
    deleteSave,
  } = useLibrary();

  const [selected, setSelected] = useState(() => new Set());
  const [gridColumns, setGridColumns] = useState(3);
  const [focusedId, setFocusedId] = useState(null);
  const [dragging, setDragging] = useState(false);

  const focusedIndex = useMemo(
    () => (focusedId ? saves.findIndex((s) => s.id === focusedId) : -1),
    [saves, focusedId],
  );
  const focused = focusedIndex >= 0 ? saves[focusedIndex] : null;

  // If the focused record disappears (deleted, filtered out), drop focus.
  if (focusedId && !focused) {
    setFocusedId(null);
  }

  const handleSelect = useCallback((id, additive) => {
    if (additive) {
      // ⌘-click / checkbox toggle: pure multi-select, no focus change.
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    // Plain click on the card body: focus it, drop any prior selection so
    // the grid is "clean" when the user backs out.
    setSelected(new Set());
    setFocusedId(id);
  }, []);

  const handleOpenInPreview = useCallback((filePath) => {
    window.moodmark.image.openInPreview(filePath);
  }, []);

  const handleOpenFromCard = useCallback(
    (record) => {
      // Double-click bypasses the focused view and goes straight to Preview.app.
      handleOpenInPreview(record.file_path);
    },
    [handleOpenInPreview],
  );

  const handleDelete = useCallback(
    async (id) => {
      const ok = await window.moodmark.saves.confirmDelete(1);
      if (!ok) return;
      await deleteSave(id);
      if (focusedId === id) setFocusedId(null);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [deleteSave, focusedId],
  );

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await window.moodmark.saves.confirmDelete(ids.length);
    if (!ok) return;
    for (const id of ids) {
      await deleteSave(id);
    }
    setSelected(new Set());
    if (focusedId && ids.includes(focusedId)) setFocusedId(null);
  }, [selected, deleteSave, focusedId]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const goPrev = useCallback(() => {
    if (focusedIndex > 0) setFocusedId(saves[focusedIndex - 1].id);
  }, [focusedIndex, saves]);

  const goNext = useCallback(() => {
    if (focusedIndex >= 0 && focusedIndex < saves.length - 1) {
      setFocusedId(saves[focusedIndex + 1].id);
    }
  }, [focusedIndex, saves]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [...e.dataTransfer.items];
    const couldBeImage = items.some(
      (i) =>
        (i.kind === 'file' && i.type.startsWith('image/')) ||
        (i.kind === 'string' &&
          (i.type === 'text/uri-list' || i.type === 'text/html')),
    );
    if (couldBeImage) setDragging(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  }, []);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);

    // Files dragged from Finder, browser-downloaded images, etc.
    const files = [...e.dataTransfer.files].filter((f) =>
      f.type.startsWith('image/'),
    );
    if (files.length > 0) {
      for (const file of files) {
        try {
          await window.moodmark.saves.dropFile(file);
        } catch (err) {
          console.error('Drop failed:', err);
        }
      }
      return;
    }

    // Diagnostic dump: log every dataTransfer type and its raw value so we
    // can see whether the page URL is hiding behind a non-standard type.
    console.groupCollapsed('[drop] dataTransfer dump');
    console.log('types:', [...e.dataTransfer.types]);
    for (const t of e.dataTransfer.types) {
      try {
        console.log(`▸ ${t}:`, e.dataTransfer.getData(t));
      } catch (err) {
        console.log(`▸ ${t}: <error: ${err.message}>`);
      }
    }
    console.log(
      'files:',
      [...e.dataTransfer.files].map((f) => ({ name: f.name, type: f.type, size: f.size })),
    );
    console.groupEnd();

    const { candidates, sourceUrl } = extractDropImageUrls(e.dataTransfer);
    if (candidates.length === 0) return;

    console.log('[drop] candidates:', candidates, 'referer:', sourceUrl);
    try {
      await window.moodmark.saves.dropUrl(candidates, sourceUrl);
    } catch (err) {
      console.error('URL drop failed:', err);
    }
  }, []);

  return (
    <div
      className={`app-shell${dragging ? ' drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="layout">
        <Sidebar view={view} onViewChange={setView} />

        <div className="main-col">
          {focused ? (
            <FocusedView
              record={focused}
              index={focusedIndex}
              total={saves.length}
              onBack={() => setFocusedId(null)}
              onPrev={goPrev}
              onNext={goNext}
              hasPrev={focusedIndex > 0}
              hasNext={focusedIndex < saves.length - 1}
            />
          ) : (
            <>
              <Toolbar
                search={search}
                onSearchChange={setSearch}
                columns={gridColumns}
                onColumnsChange={setGridColumns}
                count={saves.length}
              />
              <div className="grid-scroll">
                <Grid
                  saves={saves}
                  selected={selected}
                  onSelect={handleSelect}
                  onOpen={handleOpenFromCard}
                  columns={gridColumns}
                  loading={loading}
                />
              </div>
            </>
          )}
        </div>

        {focused && (
          <DetailPanel
            record={focused}
            onClose={() => setFocusedId(null)}
            onToggleFavorite={toggleFavorite}
            onDelete={handleDelete}
            onOpenInPreview={handleOpenInPreview}
          />
        )}
      </div>

      {!focused && selected.size > 0 && (
        <div className="selection-bar">
          <span className="selection-count">
            {selected.size} selected
          </span>
          <button
            type="button"
            className="selection-btn"
            onClick={clearSelection}
          >
            Clear
          </button>
          <button
            type="button"
            className="selection-btn selection-btn-danger"
            onClick={handleDeleteSelected}
          >
            Delete
          </button>
        </div>
      )}

      {dragging && (
        <div className="drop-overlay">
          <span className="drop-message">Drop to save</span>
        </div>
      )}
    </div>
  );
}
