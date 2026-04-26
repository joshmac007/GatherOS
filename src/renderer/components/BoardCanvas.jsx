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
const DEFAULT_TEXT_WIDTH = 200;
const DEFAULT_TEXT_HEIGHT = 40;

const MIME_BOARD_DRAG = 'application/x-moodmark-save';

export default function BoardCanvas({ board, allSaves, collections = [] }) {
  const [items, setItems] = useState([]);
  const [viewport, setViewport] = useState({
    x: board.viewport_x ?? 0,
    y: board.viewport_y ?? 0,
    z: board.viewport_z ?? 1,
  });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [dropOver, setDropOver] = useState(false);
  const [tool, setTool] = useState('select'); // 'select' | 'text'
  const [editingTextId, setEditingTextId] = useState(null);

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
    setEditingTextId(null);
    setTool('select');
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

  // ── Pan / click-to-place text ──────────────────────────────────────────
  const panState = useRef(null);
  const handleViewportPointerDown = useCallback(async (e) => {
    if (e.button !== 0) return;
    if (e.target !== viewportRef.current && !e.target.classList?.contains(styles.world)) {
      // Click landed on an item — let the item's own handler take over.
      return;
    }
    e.preventDefault();

    if (tool === 'text') {
      // Drop a fresh text label at the click point and immediately
      // enter edit mode so the user can start typing.
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      const created = await window.moodmark.boards.createItem({
        boardId: board.id,
        type: 'text',
        x: x - 10,
        y: y - 10,
        width: DEFAULT_TEXT_WIDTH,
        height: DEFAULT_TEXT_HEIGHT,
        text: '',
      });
      if (created) {
        setItems((prev) => [...prev, created]);
        setSelectedIds(new Set([created.id]));
        setEditingTextId(created.id);
      }
      setTool('select');
      return;
    }

    setSelectedIds(new Set());
    setEditingTextId(null);
    panState.current = {
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startVx: viewport.x,
      startVy: viewport.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [tool, viewport, board.id, screenToWorld]);

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
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = viewportRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setViewport((v) => {
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newZ = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z + delta));
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
    if (editingTextId === item.id) return; // don't drag the item being edited
    e.stopPropagation();
    setSelectedIds(new Set([item.id]));
    setEditingTextId(null);
    itemDragState.current = {
      itemId: item.id,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startX: item.x,
      startY: item.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setItems((prev) => {
      const max = prev.reduce((m, it) => Math.max(m, it.z_index || 0), 0);
      return prev.map((it) =>
        it.id === item.id ? { ...it, z_index: max + 1 } : it,
      );
    });
  }, [editingTextId]);

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

  // ── Text edit ──────────────────────────────────────────────────────────
  const handleItemDoubleClick = useCallback((item) => {
    if (item.type !== 'text') return;
    setEditingTextId(item.id);
    setSelectedIds(new Set([item.id]));
  }, []);

  const handleTextChange = useCallback((id, value) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, text: value } : it)));
  }, []);

  const handleTextCommit = useCallback(async (id) => {
    setEditingTextId((curr) => (curr === id ? null : curr));
    const item = items.find((it) => it.id === id);
    if (!item) return;
    const trimmed = (item.text || '').trim();
    if (!trimmed) {
      // Empty text labels would just be dead placeholders; delete instead.
      await window.moodmark.boards.deleteItem(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    await window.moodmark.boards.updateItem({ id, text: item.text });
  }, [items]);

  // ── Drop from library drawer ───────────────────────────────────────────
  const handleDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes(MIME_BOARD_DRAG)) {
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
    const saveId = e.dataTransfer.getData(MIME_BOARD_DRAG);
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
      setItems((prev) => [
        ...prev,
        { ...created, save_file_path: save.file_path, save_thumb_path: save.thumb_path },
      ]);
    }
  }, [allSaves, board.id, screenToWorld]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.key === 'Escape') {
        // Escape exits the text tool and ends any in-progress text edit.
        if (editingTextId) {
          // Let the textarea's own onBlur fire so we hit the commit path.
          e.target?.blur?.();
          return;
        }
        setTool('select');
        return;
      }

      if (inField) return;

      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        setTool((t) => (t === 'text' ? 'select' : 'text'));
        return;
      }

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
  }, [selectedIds, editingTextId]);

  const sortedItems = [...items].sort(
    (a, b) => (a.z_index || 0) - (b.z_index || 0),
  );

  const viewportClass = [
    styles.viewport,
    dropOver && styles.viewportDropOver,
    tool === 'text' && styles.viewportText,
  ].filter(Boolean).join(' ');

  return (
    <div className={styles.canvas}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarTitle}>{board.name}</div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={[styles.toolbarBtn, tool === 'text' && styles.toolbarBtnActive]
              .filter(Boolean).join(' ')}
            onClick={() => setTool((t) => (t === 'text' ? 'select' : 'text'))}
            title="Add text (T)"
          >
            T
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
        <LibraryDrawer allSaves={allSaves} collections={collections} />

        <div
          ref={viewportRef}
          className={viewportClass}
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
                editing={editingTextId === item.id}
                onPointerDown={handleItemPointerDown}
                onPointerMove={handleItemPointerMove}
                onPointerUp={handleItemPointerUp}
                onDoubleClick={handleItemDoubleClick}
                onTextChange={handleTextChange}
                onTextCommit={handleTextCommit}
              />
            ))}
            {items.length === 0 && (
              <div className={styles.emptyHint}>
                Drag images from the library on the left, or press T to add text.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BoardItem({
  item, selected, editing,
  onPointerDown, onPointerMove, onPointerUp,
  onDoubleClick, onTextChange, onTextCommit,
}) {
  if (item.type === 'image') {
    const style = {
      transform: `translate(${item.x}px, ${item.y}px)`,
      width: `${item.width}px`,
      height: `${item.height}px`,
      zIndex: item.z_index || 0,
    };
    const cls = [styles.item, selected && styles.itemSelected].filter(Boolean).join(' ');
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

  if (item.type === 'text') {
    return (
      <TextItem
        item={item}
        selected={selected}
        editing={editing}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onTextChange={onTextChange}
        onTextCommit={onTextCommit}
      />
    );
  }

  return null;
}

function TextItem({
  item, selected, editing,
  onPointerDown, onPointerMove, onPointerUp,
  onDoubleClick, onTextChange, onTextCommit,
}) {
  const textareaRef = useRef(null);

  // Autofocus + select all when entering edit mode.
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
      // Fit height to content.
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [editing]);

  const style = {
    transform: `translate(${item.x}px, ${item.y}px)`,
    width: `${item.width}px`,
    minHeight: `${item.height}px`,
    zIndex: item.z_index || 0,
  };
  const cls = [
    styles.textItem,
    selected && styles.textItemSelected,
    editing && styles.textItemEditing,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={cls}
      style={style}
      onPointerDown={(e) => { if (!editing) onPointerDown(e, item); }}
      onPointerMove={(e) => { if (!editing) onPointerMove(e); }}
      onPointerUp={(e) => { if (!editing) onPointerUp(e); }}
      onPointerCancel={(e) => { if (!editing) onPointerUp(e); }}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(item); }}
    >
      {editing ? (
        <textarea
          ref={textareaRef}
          className={styles.textInput}
          value={item.text || ''}
          placeholder="Add Text"
          onChange={(e) => {
            onTextChange(item.id, e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onBlur={() => onTextCommit(item.id)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              e.target.blur();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className={styles.textDisplay}>
          {item.text
            ? item.text
            : <span className={styles.textPlaceholder}>Add Text</span>}
        </div>
      )}
    </div>
  );
}

// Slim drawer of library thumbnails the user can drag onto the canvas.
// Top-of-drawer dropdown filters which saves are shown (All / Favorites
// / Recent / each Collection). HTML5 drag with a custom MIME so the
// canvas's drop handler distinguishes Moodmark drops from Finder drops.
function LibraryDrawer({ allSaves, collections }) {
  const [filterValue, setFilterValue] = useState('all');
  const [filteredSaves, setFilteredSaves] = useState(allSaves);

  // Re-derive the visible list whenever the filter or the source list
  // changes. For non-"all" filters we hit the backend so collection
  // membership / favorites / recent semantics match the rest of the
  // app exactly, with no client-side reimplementation.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (filterValue === 'all') {
        if (!cancelled) setFilteredSaves(allSaves);
        return;
      }
      const opts = {};
      if (filterValue === 'favorites' || filterValue === 'recent') {
        opts.filter = filterValue;
      } else {
        opts.collectionId = filterValue;
      }
      const data = await window.moodmark.saves.getAll(opts);
      if (!cancelled) setFilteredSaves(data || []);
    }
    run();
    return () => { cancelled = true; };
  }, [filterValue, allSaves]);

  return (
    <aside className={styles.drawer}>
      <div className={styles.drawerHeader}>
        <select
          className={styles.drawerSelect}
          value={filterValue}
          onChange={(e) => setFilterValue(e.target.value)}
        >
          <option value="all">All</option>
          <option value="favorites">Favorites</option>
          <option value="recent">Recent</option>
          {collections.length > 0 && (
            <optgroup label="Collections">
              {collections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <div className={styles.drawerList}>
        {filteredSaves.map((save) => (
          <div
            key={save.id}
            className={styles.drawerItem}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData(MIME_BOARD_DRAG, save.id);
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
        {filteredSaves.length === 0 && (
          <div className={styles.drawerEmpty}>Nothing here.</div>
        )}
      </div>
    </aside>
  );
}
