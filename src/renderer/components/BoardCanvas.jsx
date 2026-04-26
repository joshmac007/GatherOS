import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './BoardCanvas.module.css';
import { fileUrl } from '../lib/fileUrl.js';

// World-space units. Items position themselves with absolute pixel
// coordinates inside a transformed parent, so pan/zoom is just a CSS
// transform on the world container — no per-item math.

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const DEFAULT_IMG_WIDTH = 220;
const STICKY_DEFAULT = { width: 200, height: 140 };

function MIME_BOARD_DRAG() { return 'application/x-moodmark-save'; }

export default function BoardCanvas({ board, allSaves }) {
  const [items, setItems] = useState([]);
  const [viewport, setViewport] = useState({
    x: board.viewport_x ?? 0,
    y: board.viewport_y ?? 0,
    z: board.viewport_z ?? 1,
  });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [dropOver, setDropOver] = useState(false);

  const viewportRef = useRef(null);
  // Throttle viewport persistence — many micro-updates while panning.
  const viewportSaveTimer = useRef(null);

  // Reload items when board changes.
  useEffect(() => {
    let cancelled = false;
    window.moodmark.boards.getItems(board.id).then((rows) => {
      if (!cancelled) setItems(rows || []);
    });
    setSelectedIds(new Set());
    setViewport({
      x: board.viewport_x ?? 0,
      y: board.viewport_y ?? 0,
      z: board.viewport_z ?? 1,
    });
    return () => { cancelled = true; };
  }, [board.id]);

  // Persist viewport with a debounce so we don't write on every pixel.
  useEffect(() => {
    if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
    viewportSaveTimer.current = setTimeout(() => {
      window.moodmark.boards.updateViewport({
        id: board.id, x: viewport.x, y: viewport.y, z: viewport.z,
      });
    }, 400);
    return () => {
      if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
    };
  }, [viewport, board.id]);

  // ── Coordinate conversion ──────────────────────────────────────────────
  // Screen point → world point (the inverse of the world's CSS transform).
  const screenToWorld = useCallback((sx, sy) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (sx - rect.left - viewport.x) / viewport.z,
      y: (sy - rect.top - viewport.y) / viewport.z,
    };
  }, [viewport]);

  // ── Pan ────────────────────────────────────────────────────────────────
  const panState = useRef(null);
  const handleViewportPointerDown = useCallback((e) => {
    // Only pan on plain left-click on the empty viewport (not on items).
    if (e.button !== 0) return;
    if (e.target !== viewportRef.current && !e.target.classList?.contains(styles.world)) {
      // Click landed on an item — let the item's own handler take over.
      return;
    }
    e.preventDefault();
    setSelectedIds(new Set());
    panState.current = {
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startVx: viewport.x,
      startVy: viewport.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [viewport]);

  const handleViewportPointerMove = useCallback((e) => {
    if (!panState.current) return;
    const { startScreenX, startScreenY, startVx, startVy } = panState.current;
    setViewport((v) => ({
      ...v,
      x: startVx + (e.clientX - startScreenX),
      y: startVy + (e.clientY - startScreenY),
    }));
  }, []);

  const handleViewportPointerUp = useCallback((e) => {
    if (!panState.current) return;
    panState.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  }, []);

  // ── Zoom ───────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    if (!e.ctrlKey && !e.metaKey) return; // require modifier so trackpad scrolls don't fight pan
    e.preventDefault();
    const rect = viewportRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setViewport((v) => {
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newZ = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z + delta));
      // Anchor zoom around the cursor so the world point under the
      // cursor stays under the cursor.
      const wx = (cx - v.x) / v.z;
      const wy = (cy - v.y) / v.z;
      return {
        z: newZ,
        x: cx - wx * newZ,
        y: cy - wy * newZ,
      };
    });
  }, []);

  // ── Item drag ──────────────────────────────────────────────────────────
  const itemDragState = useRef(null);

  const handleItemPointerDown = useCallback((e, item) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedIds(new Set([item.id]));
    itemDragState.current = {
      itemId: item.id,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startX: item.x,
      startY: item.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    // Bring to front by bumping z_index locally; persist on drag end.
    setItems((prev) => {
      const max = prev.reduce((m, it) => Math.max(m, it.z_index || 0), 0);
      return prev.map((it) =>
        it.id === item.id ? { ...it, z_index: max + 1 } : it,
      );
    });
  }, []);

  const handleItemPointerMove = useCallback((e) => {
    const s = itemDragState.current;
    if (!s) return;
    const dx = (e.clientX - s.startScreenX) / viewport.z;
    const dy = (e.clientY - s.startScreenY) / viewport.z;
    if (Math.abs(dx) + Math.abs(dy) > 1) s.moved = true;
    setItems((prev) =>
      prev.map((it) =>
        it.id === s.itemId ? { ...it, x: s.startX + dx, y: s.startY + dy } : it,
      ),
    );
  }, [viewport.z]);

  const handleItemPointerUp = useCallback(async (e) => {
    const s = itemDragState.current;
    if (!s) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    itemDragState.current = null;
    if (!s.moved) return;
    const moved = items.find((it) => it.id === s.itemId);
    if (moved) {
      window.moodmark.boards.updateItem({
        id: moved.id, x: moved.x, y: moved.y, zIndex: moved.z_index,
      });
    }
  }, [items]);

  // ── Drop from library drawer ───────────────────────────────────────────
  const handleDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes(MIME_BOARD_DRAG())) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDropOver(false);
  }, []);

  const handleDrop = useCallback(async (e) => {
    setDropOver(false);
    const saveId = e.dataTransfer.getData(MIME_BOARD_DRAG());
    if (!saveId) return;
    e.preventDefault();
    const save = allSaves.find((s) => s.id === saveId);
    if (!save) return;
    const aspect = save.width && save.height ? save.width / save.height : 4 / 3;
    const width = DEFAULT_IMG_WIDTH;
    const height = width / aspect;
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    const created = await window.moodmark.boards.createItem({
      boardId: board.id,
      type: 'image',
      saveId,
      x: x - width / 2,
      y: y - height / 2,
      width,
      height,
    });
    if (created) {
      // Server returns the row without join fields — patch in the save's
      // file_path so the renderer can show it immediately.
      setItems((prev) => [
        ...prev,
        { ...created, save_file_path: save.file_path, save_thumb_path: save.thumb_path },
      ]);
    }
  }, [allSaves, board.id, screenToWorld]);

  // ── Sticky note creation ───────────────────────────────────────────────
  const addSticky = useCallback(async () => {
    const rect = viewportRef.current.getBoundingClientRect();
    const center = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const created = await window.moodmark.boards.createItem({
      boardId: board.id,
      type: 'sticky',
      x: center.x - STICKY_DEFAULT.width / 2,
      y: center.y - STICKY_DEFAULT.height / 2,
      width: STICKY_DEFAULT.width,
      height: STICKY_DEFAULT.height,
      text: '',
      color: '#fff5b1',
    });
    if (created) setItems((prev) => [...prev, created]);
  }, [board.id, screenToWorld]);

  // ── Delete ─────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        e.preventDefault();
        const ids = [...selectedIds];
        Promise.all(ids.map((id) => window.moodmark.boards.deleteItem(id))).then(() => {
          setItems((prev) => prev.filter((it) => !selectedIds.has(it.id)));
          setSelectedIds(new Set());
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds]);

  const handleStickyTextChange = useCallback((id, text) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, text } : it)));
  }, []);

  const handleStickyTextCommit = useCallback((id, text) => {
    window.moodmark.boards.updateItem({ id, text });
  }, []);

  const sortedItems = [...items].sort(
    (a, b) => (a.z_index || 0) - (b.z_index || 0),
  );

  return (
    <div className={styles.canvas}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarTitle}>{board.name}</div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={addSticky}
            title="Add sticky note"
          >
            + Sticky
          </button>
          <span className={styles.zoomLabel}>{Math.round(viewport.z * 100)}%</span>
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => setViewport({ x: 0, y: 0, z: 1 })}
            title="Reset view"
          >
            Reset
          </button>
        </div>
      </div>

      <div className={styles.body}>
        <LibraryDrawer saves={allSaves} />

        <div
          ref={viewportRef}
          className={[styles.viewport, dropOver && styles.viewportDropOver]
            .filter(Boolean).join(' ')}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          onPointerCancel={handleViewportPointerUp}
          onWheel={handleWheel}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div
            className={styles.world}
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.z})`,
            }}
          >
            {sortedItems.map((item) => (
              <BoardItem
                key={item.id}
                item={item}
                selected={selectedIds.has(item.id)}
                onPointerDown={handleItemPointerDown}
                onPointerMove={handleItemPointerMove}
                onPointerUp={handleItemPointerUp}
                onTextChange={handleStickyTextChange}
                onTextCommit={handleStickyTextCommit}
              />
            ))}
            {items.length === 0 && (
              <div className={styles.emptyHint}>
                Drag images from the library on the left, or click + Sticky.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BoardItem({ item, selected, onPointerDown, onPointerMove, onPointerUp, onTextChange, onTextCommit }) {
  const style = {
    transform: `translate(${item.x}px, ${item.y}px)`,
    width: `${item.width}px`,
    height: `${item.height}px`,
    zIndex: item.z_index || 0,
  };
  const cls = [styles.item, selected && styles.itemSelected].filter(Boolean).join(' ');

  if (item.type === 'image') {
    const src = item.save_file_path ? fileUrl(item.save_file_path) : null;
    return (
      <div
        className={cls}
        style={style}
        onPointerDown={(e) => onPointerDown(e, item)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {src ? (
          <img src={src} alt={item.save_title || ''} draggable={false} />
        ) : (
          <div className={styles.itemPlaceholder}>image deleted</div>
        )}
      </div>
    );
  }

  if (item.type === 'sticky') {
    return (
      <div
        className={cls}
        style={{ ...style, background: item.color || '#fff5b1' }}
        onPointerDown={(e) => onPointerDown(e, item)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <textarea
          className={styles.stickyText}
          value={item.text || ''}
          onChange={(e) => onTextChange(item.id, e.target.value)}
          onBlur={(e) => onTextCommit(item.id, e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="Type a note…"
        />
      </div>
    );
  }

  return null;
}

// Slim fixed-width drawer of library thumbnails the user can drag onto
// the canvas. HTML5 drag — sets a custom MIME so the canvas's drop
// handler can recognize Moodmark saves vs Finder file drops.
function LibraryDrawer({ saves }) {
  return (
    <aside className={styles.drawer}>
      <div className={styles.drawerHeader}>Library</div>
      <div className={styles.drawerList}>
        {saves.map((save) => (
          <div
            key={save.id}
            className={styles.drawerItem}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData(MIME_BOARD_DRAG(), save.id);
            }}
            title={save.title || 'Drag onto board'}
          >
            <img
              src={fileUrl(save.thumb_path || save.file_path)}
              alt={save.title || ''}
              draggable={false}
            />
          </div>
        ))}
        {saves.length === 0 && (
          <div className={styles.drawerEmpty}>No saves yet.</div>
        )}
      </div>
    </aside>
  );
}
