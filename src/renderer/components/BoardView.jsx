import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MousePointer2,
  ImagePlus,
  StickyNote,
  Type,
  Shapes,
  PenTool,
  Frame,
  Undo2,
  Redo2,
} from 'lucide-react';
import styles from './BoardView.module.css';
import BoardCanvas from './BoardCanvas.jsx';
import { fileUrl } from '../lib/fileUrl.js';

const TOOL_ICON = { strokeWidth: 1.6, 'aria-hidden': true, size: 18 };

const TOOLS = [
  { id: 'select', label: 'Select (V)',         Icon: (p) => <MousePointer2 {...TOOL_ICON} {...p} /> },
  { id: 'image',  label: 'Image library (I)',  Icon: (p) => <ImagePlus {...TOOL_ICON} {...p} /> },
  { id: 'sticky', label: 'Sticky note (S)',    Icon: (p) => <StickyNote {...TOOL_ICON} {...p} /> },
  { id: 'text',   label: 'Text (T)',           Icon: (p) => <Type {...TOOL_ICON} {...p} /> },
  // Phase 2: shapes / pen / frame are placeholders for now. The
  // buttons render so the layout matches the final tool set; each
  // is disabled until its implementation lands.
  { id: 'shape',  label: 'Shapes — coming soon', Icon: (p) => <Shapes {...TOOL_ICON} {...p} />, disabled: true },
  { id: 'pen',    label: 'Pen — coming soon',    Icon: (p) => <PenTool {...TOOL_ICON} {...p} />, disabled: true },
  { id: 'frame',  label: 'Frame — coming soon',  Icon: (p) => <Frame {...TOOL_ICON} {...p} />, disabled: true },
];

const INITIAL_PAN = { x: 0, y: 0 };
const INITIAL_ZOOM = 1;

// Default sizes per item type (world-space pixels). Image items are
// resized to match their dropped save's intrinsic dimensions when
// available, capped to keep them readable on the canvas.
const DEFAULT_IMAGE_MAX = 360;
const DEFAULT_STICKY = { width: 180, height: 180 };
const DEFAULT_TEXT = { width: 240, height: 56 };

function nextZ(items) {
  if (items.length === 0) return 1;
  return Math.max(...items.map((i) => i.z_index ?? 0)) + 1;
}

function uuid() {
  // crypto.randomUUID is available in Electron's renderer.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback unlikely to ever fire here but keeps the function pure.
  return `b_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export default function BoardView({ boardId, saves, onRenameBoard }) {
  const [board, setBoard] = useState(null);
  const [items, setItems] = useState([]);
  const [tool, setTool] = useState('select');
  const [pan, setPan] = useState(INITIAL_PAN);
  const [zoom, setZoom] = useState(INITIAL_ZOOM);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [editingItemId, setEditingItemId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Load the board metadata + items when the board changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [b, its] = await Promise.all([
        window.moodmark.boards.get(boardId),
        window.moodmark.boards.getItems(boardId),
      ]);
      if (cancelled) return;
      setBoard(b);
      setItems(Array.isArray(its) ? its : []);
      setTitleDraft(b?.name || '');
      // Reset view per board so each opens at its origin.
      setPan(INITIAL_PAN);
      setZoom(INITIAL_ZOOM);
      setSelectedIds(new Set());
      setEditingItemId(null);
    })();
    return () => { cancelled = true; };
  }, [boardId]);

  // Single-item upsert helper used by add/move/edit paths. Persists
  // immediately; for batch drag-moves the canvas calls onItemsChange
  // with persist: true on mouseup so we don't hit IPC every frame.
  const persistItem = useCallback((item) => {
    return window.moodmark.boards.upsertItem({ boardId, item });
  }, [boardId]);

  const persistMany = useCallback((batch) => {
    if (!batch.length) return Promise.resolve();
    return window.moodmark.boards.bulkUpdateItems({ boardId, items: batch });
  }, [boardId]);

  const handleItemsChange = useCallback((next, { movingIds, persist } = {}) => {
    setItems(next);
    if (persist && Array.isArray(movingIds) && movingIds.length > 0) {
      const moved = next.filter((it) => movingIds.includes(it.id));
      persistMany(moved);
    }
  }, [persistMany]);

  // Drop an image from the library drawer: resolve the save record
  // for its natural dimensions, scale down to a sensible default,
  // and add a new image item centered on the drop point.
  const handleDropImage = useCallback(({ saveId, world }) => {
    const save = saves.find((s) => s.id === saveId);
    if (!save) return;
    const aspect = save.width && save.height ? save.width / save.height : 1;
    let w = save.width || DEFAULT_IMAGE_MAX;
    let h = save.height || DEFAULT_IMAGE_MAX;
    if (w > DEFAULT_IMAGE_MAX || h > DEFAULT_IMAGE_MAX) {
      if (aspect >= 1) { w = DEFAULT_IMAGE_MAX; h = w / aspect; }
      else { h = DEFAULT_IMAGE_MAX; w = h * aspect; }
    }
    const item = {
      id: uuid(),
      board_id: boardId,
      type: 'image',
      x: world.x - w / 2,
      y: world.y - h / 2,
      width: w,
      height: h,
      rotation: 0,
      z_index: nextZ(items),
      data: { saveId, fileUrl: fileUrl(save.file_path) },
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    setItems((prev) => [...prev, item]);
    setSelectedIds(new Set([item.id]));
    persistItem(item);
  }, [saves, items, boardId, persistItem]);

  // Click on the canvas with a non-select tool: spawn the tool's
  // item type at that world position. Using the current zoom keeps
  // newly-added items legible without the user manually resizing.
  const handleCanvasClick = useCallback((world, activeTool) => {
    if (activeTool !== 'sticky' && activeTool !== 'text') return;
    const size = activeTool === 'sticky' ? DEFAULT_STICKY : DEFAULT_TEXT;
    const item = {
      id: uuid(),
      board_id: boardId,
      type: activeTool,
      x: world.x - size.width / 2,
      y: world.y - size.height / 2,
      width: size.width,
      height: size.height,
      rotation: 0,
      z_index: nextZ(items),
      data: { text: '' },
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    setItems((prev) => [...prev, item]);
    setSelectedIds(new Set([item.id]));
    setEditingItemId(item.id);
    persistItem(item);
    // Fall back to select after placing — single-click-to-add feels
    // more natural than staying armed and accidentally laying down
    // a chain of stickies.
    setTool('select');
  }, [boardId, items, persistItem]);

  const handleCommitEdit = useCallback((itemId, text) => {
    setItems((prev) => prev.map((it) => {
      if (it.id !== itemId) return it;
      const next = { ...it, data: { ...(it.data || {}), text }, updated_at: Date.now() };
      persistItem(next);
      return next;
    }));
    setEditingItemId(null);
  }, [persistItem]);

  // Delete selected items via Delete / Backspace. Skipped while a
  // text/sticky is being edited so the editor handles the keystroke.
  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (editingItemId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const ids = Array.from(selectedIds);
        setItems((prev) => prev.filter((it) => !selectedIds.has(it.id)));
        setSelectedIds(new Set());
        window.moodmark.boards.deleteItems({ boardId, itemIds: ids });
      } else if (e.key === 'Escape') {
        setSelectedIds(new Set());
        setTool('select');
      } else if (e.key === 'v' || e.key === 'V') {
        setTool('select');
      } else if (e.key === 't' || e.key === 'T') {
        setTool('text');
      } else if (e.key === 's' || e.key === 'S') {
        setTool('sticky');
      } else if (e.key === 'i' || e.key === 'I') {
        setTool('image');
        setDrawerOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, boardId, editingItemId]);

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === board?.name) {
      setTitleDraft(board?.name || '');
      return;
    }
    onRenameBoard?.({ id: boardId, name: trimmed });
    setBoard((b) => (b ? { ...b, name: trimmed } : b));
  };

  const zoomReadout = useMemo(() => `${Math.round(zoom * 100)}%`, [zoom]);

  return (
    <div className={styles.root}>
      <div className={styles.titleBar}>
        <input
          className={styles.titleInput}
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setTitleDraft(board?.name || '');
              e.currentTarget.blur();
            }
          }}
          placeholder="Untitled board"
        />
      </div>

      <div className={styles.toolbar}>
        {TOOLS.map(({ id, label, Icon, disabled }) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            className={[
              styles.toolBtn,
              tool === id && !disabled && styles.toolBtnActive,
            ].filter(Boolean).join(' ')}
            title={label}
            onClick={() => {
              if (disabled) return;
              setTool(id);
              if (id === 'image') setDrawerOpen(true);
            }}
          >
            <Icon />
          </button>
        ))}
        <div className={styles.toolDivider} />
        <button type="button" className={styles.toolBtn} title="Undo (coming soon)" disabled>
          <Undo2 {...TOOL_ICON} />
        </button>
        <button type="button" className={styles.toolBtn} title="Redo (coming soon)" disabled>
          <Redo2 {...TOOL_ICON} />
        </button>
      </div>

      <BoardCanvas
        items={items}
        saves={saves}
        pan={pan}
        zoom={zoom}
        onPanZoomChange={({ pan: p, zoom: z }) => { setPan(p); setZoom(z); }}
        selectedIds={selectedIds}
        onSelectIds={setSelectedIds}
        editingItemId={editingItemId}
        onBeginEdit={setEditingItemId}
        onCommitEdit={handleCommitEdit}
        onItemsChange={handleItemsChange}
        onCanvasClick={handleCanvasClick}
        onDropImage={handleDropImage}
        tool={tool}
      />

      {drawerOpen && (
        <div className={styles.drawer}>
          <div className={styles.drawerHeader}>
            <span className={styles.drawerTitle}>Library</span>
            <button
              type="button"
              className={styles.drawerClose}
              onClick={() => setDrawerOpen(false)}
              title="Close library"
            >
              ×
            </button>
          </div>
          <div className={styles.drawerGrid}>
            {saves.length === 0 ? (
              <div className={styles.drawerEmpty}>No saves yet</div>
            ) : (
              saves.map((s) => (
                <div
                  key={s.id}
                  className={styles.drawerThumb}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData(
                      'application/x-moodmark-board-save',
                      JSON.stringify({ saveId: s.id }),
                    );
                  }}
                  title={s.title || ''}
                >
                  <img
                    src={fileUrl(s.thumb_path || s.file_path)}
                    alt=""
                    draggable={false}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className={styles.zoomReadout}>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))}
          title="Zoom out"
        >−</button>
        <span>{zoomReadout}</span>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => setZoom((z) => Math.min(4, z + 0.1))}
          title="Zoom in"
        >+</button>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => { setPan(INITIAL_PAN); setZoom(INITIAL_ZOOM); }}
          title="Reset view"
        >⤒</button>
      </div>
    </div>
  );
}
