import React, { useCallback, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import Grid from './components/Grid.jsx';
import DetailPanel from './components/DetailPanel.jsx';
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
  const [density, setDensity] = useState(4);
  const [detailId, setDetailId] = useState(null);
  const [dragging, setDragging] = useState(false);

  const detail = useMemo(
    () => saves.find((s) => s.id === detailId) || null,
    [saves, detailId],
  );

  const handleSelect = useCallback((id, additive) => {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (additive && next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!additive) setDetailId(id);
  }, []);

  const handleOpen = useCallback((record) => {
    window.moodmark.image.openInPreview(record.file_path);
  }, []);

  const handleDelete = useCallback(
    async (id) => {
      await deleteSave(id);
      if (detailId === id) setDetailId(null);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [deleteSave, detailId],
  );

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const hasImage = [...e.dataTransfer.items].some(
      (i) => i.kind === 'file' && i.type.startsWith('image/'),
    );
    if (hasImage) setDragging(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  }, []);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) =>
      f.type.startsWith('image/'),
    );
    for (const file of files) {
      try {
        await window.moodmark.saves.dropFile(file);
      } catch (err) {
        console.error('Drop failed:', err);
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
          <Toolbar
            search={search}
            onSearchChange={setSearch}
            density={density}
            onDensityChange={setDensity}
            count={saves.length}
          />
          <div className="grid-scroll">
            <Grid
              saves={saves}
              selected={selected}
              onSelect={handleSelect}
              onOpen={handleOpen}
              density={density}
              loading={loading}
            />
          </div>
        </div>

        {detail && (
          <DetailPanel
            record={detail}
            onClose={() => setDetailId(null)}
            onToggleFavorite={toggleFavorite}
            onDelete={handleDelete}
            onOpenInPreview={(p) => window.moodmark.image.openInPreview(p)}
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
