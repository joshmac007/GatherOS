import React, { useCallback, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import Grid from './components/Grid.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import FocusedView from './components/FocusedView.jsx';
import { useLibrary } from './hooks/useLibrary.js';

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
  const [cardMinWidth, setCardMinWidth] = useState(220);
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
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (additive && next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!additive) setFocusedId(id);
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

    // No files — likely a drag from a webpage. Try to recover an image URL.
    const html = e.dataTransfer.getData('text/html');
    const uriList = e.dataTransfer.getData('text/uri-list');
    const text = e.dataTransfer.getData('text/plain');

    let imageUrl = null;
    let sourceUrl = null;

    if (html) {
      const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) imageUrl = m[1];
    }
    if (!imageUrl && uriList) {
      imageUrl = uriList
        .split(/\r?\n/)
        .find((l) => l && !l.startsWith('#'))
        ?.trim() || null;
    }
    if (!imageUrl && text && /^https?:\/\//i.test(text.trim())) {
      imageUrl = text.trim();
    }
    if (uriList && uriList !== imageUrl) {
      const candidate = uriList
        .split(/\r?\n/)
        .find((l) => l && !l.startsWith('#'))
        ?.trim();
      if (candidate && candidate !== imageUrl) sourceUrl = candidate;
    }

    if (imageUrl) {
      try {
        await window.moodmark.saves.dropUrl(imageUrl, sourceUrl);
      } catch (err) {
        console.error('URL drop failed:', err);
      }
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
                cardMinWidth={cardMinWidth}
                onCardMinWidthChange={setCardMinWidth}
                count={saves.length}
              />
              <div className="grid-scroll">
                <Grid
                  saves={saves}
                  selected={selected}
                  onSelect={handleSelect}
                  onOpen={handleOpenFromCard}
                  cardMinWidth={cardMinWidth}
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

      {dragging && (
        <div className="drop-overlay">
          <span className="drop-message">Drop to save</span>
        </div>
      )}
    </div>
  );
}
