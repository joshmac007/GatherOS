import React, { useRef, useState } from 'react';
import { Frame, Pencil, Trash2, Plus } from 'lucide-react';
import styles from './BoardGrid.module.css';
import { fileUrl } from '../lib/fileUrl.js';
import ContextMenu from './ContextMenu.jsx';

function PencilIcon() { return <Pencil size={14} strokeWidth={1.6} aria-hidden="true" />; }
function TrashIcon()  { return <Trash2 size={14} strokeWidth={1.6} aria-hidden="true" />; }

// Boards are *scenes* — multiple images composed on a canvas — so
// the tile artwork is a 2x2 mosaic of the first image items, not the
// stacked fan we use for folders. Different visual idiom for a
// different conceptual object.
function BoardTile({
  board,
  isRenaming,
  renameDraft,
  renameInputRef,
  onClick,
  onContextMenu,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  reorderHint,
  isReorderDragging,
}) {
  const thumbs = Array.isArray(board.thumbs) ? board.thumbs.slice(0, 4) : [];
  const count = thumbs.length;
  return (
    <div
      className={[
        styles.tile,
        isReorderDragging && styles.tileDragging,
        reorderHint === 'before' && styles.tileReorderBefore,
        reorderHint === 'after' && styles.tileReorderAfter,
      ].filter(Boolean).join(' ')}
      role="button"
      draggable={!isRenaming}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      tabIndex={isRenaming ? -1 : 0}
      onClick={(e) => {
        if (isRenaming) return;
        if (e.target.closest(`.${styles.tileRenameInput}`)) return;
        onClick?.();
      }}
      onKeyDown={(e) => {
        if (isRenaming) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      onContextMenu={onContextMenu}
    >
      <div className={styles.tileArt}>
        {count > 0 ? (
          <div className={styles.tileStack} aria-hidden="true">
            {thumbs.map((thumb, i) => (
              <img
                key={`${i}-${thumb}`}
                src={fileUrl(thumb)}
                className={styles.tileStackImg}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            ))}
          </div>
        ) : (
          <span className={styles.tileEmpty} aria-hidden="true">
            <Frame size={32} strokeWidth={1.4} />
          </span>
        )}
      </div>
      <div className={styles.tileMeta}>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            autoFocus
            className={styles.tileRenameInput}
            value={renameDraft}
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onRenameCommit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onRenameCancel();
              }
            }}
            onBlur={onRenameCommit}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className={styles.tileName}>{board.name}</span>
        )}
      </div>
    </div>
  );
}

function NewBoardTile({ onActivate }) {
  return (
    <button
      type="button"
      className={`${styles.tile} ${styles.tileNew}`}
      onClick={onActivate}
      title="New space"
    >
      <div className={`${styles.tileArt} ${styles.tileArtNew}`}>
        <Plus size={28} strokeWidth={1.4} aria-hidden="true" />
      </div>
      <div className={styles.tileMeta}>
        <span className={`${styles.tileName} ${styles.tileNameMuted}`}>
          New space
        </span>
      </div>
    </button>
  );
}

const BOARD_REORDER_MIME = 'application/x-moodmark-board-reorder';

export default function BoardGrid({
  boards,
  onPickBoard,
  onCreateBoard,
  onRenameBoard,
  onDeleteBoard,
  onReorderBoards,
}) {
  const [ctxMenu, setCtxMenu] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef(null);
  const [reorderState, setReorderState] = useState({ draggingId: null, overId: null, side: null });

  function handleTileReorderDragStart(e, id) {
    if (!onReorderBoards) return;
    e.dataTransfer.setData(BOARD_REORDER_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setReorderState({ draggingId: id, overId: null, side: null });
  }
  function handleTileDragOver(e, id) {
    if (!e.dataTransfer.types.includes(BOARD_REORDER_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'before' : 'after';
    if (reorderState.overId !== id || reorderState.side !== side) {
      setReorderState((prev) => ({ ...prev, overId: id, side }));
    }
  }
  function handleTileDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setReorderState((prev) => (prev.overId ? { ...prev, overId: null, side: null } : prev));
    }
  }
  function handleTileDrop(e, id) {
    if (!e.dataTransfer.types.includes(BOARD_REORDER_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData(BOARD_REORDER_MIME);
    const rect = e.currentTarget.getBoundingClientRect();
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'before' : 'after';
    setReorderState({ draggingId: null, overId: null, side: null });
    if (!draggedId || draggedId === id) return;
    const ordered = boards.map((b) => b.id).filter((x) => x !== draggedId);
    const targetIdx = ordered.indexOf(id);
    if (targetIdx < 0) return;
    const insertAt = side === 'before' ? targetIdx : targetIdx + 1;
    ordered.splice(insertAt, 0, draggedId);
    onReorderBoards?.(ordered);
  }
  function handleTileDragEnd() {
    setReorderState({ draggingId: null, overId: null, side: null });
  }

  function startRename(board) {
    setRenamingId(board.id);
    setRenameDraft(board.name);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }

  async function commitRename() {
    const next = renameDraft.trim();
    const id = renamingId;
    setRenamingId(null);
    setRenameDraft('');
    if (!id || !next) return;
    const original = boards.find((b) => b.id === id);
    if (!original || next === original.name) return;
    await onRenameBoard?.({ id, name: next });
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }

  if (!boards || boards.length === 0) {
    return (
      <div className={styles.empty}>
        <Frame size={36} strokeWidth={1.3} className={styles.emptyIcon} />
        <div className={styles.emptyTitle}>No spaces yet</div>
        <div className={styles.emptyHint}>
          Spaces are infinite canvases — drop images, sticky notes, and
          shapes anywhere you want.
        </div>
        {onCreateBoard && (
          <button
            type="button"
            className={styles.emptyAction}
            onClick={onCreateBoard}
          >
            Create your first space
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.scroll}>
      <div className={styles.grid}>
        {onCreateBoard && (
          <NewBoardTile onActivate={onCreateBoard} />
        )}
        {boards.map((board) => (
          <BoardTile
            key={board.id}
            board={board}
            isRenaming={renamingId === board.id}
            renameDraft={renameDraft}
            renameInputRef={renameInputRef}
            onClick={() => onPickBoard(board.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, board });
            }}
            onRenameDraftChange={setRenameDraft}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            isReorderDragging={reorderState.draggingId === board.id}
            reorderHint={reorderState.overId === board.id ? reorderState.side : null}
            onDragStart={(e) => handleTileReorderDragStart(e, board.id)}
            onDragOver={(e) => handleTileDragOver(e, board.id)}
            onDragLeave={handleTileDragLeave}
            onDrop={(e) => handleTileDrop(e, board.id)}
            onDragEnd={handleTileDragEnd}
          />
        ))}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: 'Rename',
              icon: <PencilIcon />,
              onClick: () => startRename(ctxMenu.board),
            },
            {
              label: 'Delete Space',
              icon: <TrashIcon />,
              danger: true,
              onClick: () => onDeleteBoard?.(ctxMenu.board.id),
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
