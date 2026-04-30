import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import styles from './LibrarySwitcher.module.css';
import ContextMenu from './ContextMenu.jsx';

function ChevronIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path
        d="M2 3.5l3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <path
        d="M2.5 6L5 8.5L9.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <path
        d="M6 2v8M2 6h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Top-of-sidebar dropdown that shows the active library and lets
// the user switch between, create, rename, or delete libraries.
// Right-click on a library row opens a context menu with rename /
// delete (delete is gated for the active and last-remaining lib).
export default function LibrarySwitcher({
  libraries,
  activeId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState('');
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, library }
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);
  const renameInputRef = useRef(null);
  const createInputRef = useRef(null);

  const active = libraries.find((l) => l.id === activeId) || libraries[0];

  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e) {
      // Stay open if click landed on the trigger, dropdown, or our
      // context menu portal.
      const inTrigger = triggerRef.current && triggerRef.current.contains(e.target);
      const inDropdown = dropdownRef.current && dropdownRef.current.contains(e.target);
      if (inTrigger || inDropdown) return;
      // Context menu lives at document.body via its own portal — let
      // its own outside-click handler manage closing.
      const inCtx = e.target.closest('[role="menu"]');
      if (inCtx) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        if (renamingId) {
          setRenamingId(null);
          setRenameDraft('');
        } else if (creating) {
          setCreating(false);
          setCreateDraft('');
        } else {
          setOpen(false);
        }
      }
    }
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, renamingId, creating]);

  function startRename(library) {
    setRenamingId(library.id);
    setRenameDraft(library.name);
    setCtxMenu(null);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }

  async function commitRename() {
    const id = renamingId;
    const next = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft('');
    if (!id || !next) return;
    const original = libraries.find((l) => l.id === id);
    if (!original || next === original.name) return;
    await onRename?.(id, next);
  }

  function startCreating() {
    setCreating(true);
    setCreateDraft('');
    requestAnimationFrame(() => createInputRef.current?.focus());
  }

  async function commitCreate() {
    const name = createDraft.trim();
    setCreating(false);
    setCreateDraft('');
    if (!name) return;
    await onCreate?.(name);
  }

  function handleLibraryContextMenu(e, library) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, library });
  }

  async function handleDelete(library) {
    setCtxMenu(null);
    const confirmed = window.confirm(
      `Delete the library "${library.name}"? Every save, bucket, and image inside it will be permanently removed.`,
    );
    if (!confirmed) return;
    await onDelete?.(library.id);
  }

  if (!active) return null;

  const ctxItems = ctxMenu
    ? [
        {
          label: 'Rename',
          onClick: () => startRename(ctxMenu.library),
        },
        {
          label: 'Delete library',
          danger: true,
          onClick: () => handleDelete(ctxMenu.library),
        },
      ]
    : [];

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={[styles.trigger, open && styles.triggerOpen]
          .filter(Boolean)
          .join(' ')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active.name}
      >
        <span className={styles.triggerLabel}>{active.name}</span>
        <span className={styles.triggerChevron}>
          <ChevronIcon />
        </span>
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className={styles.dropdown}
          role="listbox"
          aria-label="Libraries"
        >
          {libraries.map((lib) => {
            const isActive = lib.id === active.id;
            const isRenaming = renamingId === lib.id;
            return (
              <div
                key={lib.id}
                className={[styles.row, isActive && styles.rowActive]
                  .filter(Boolean)
                  .join(' ')}
                onContextMenu={(e) => handleLibraryContextMenu(e, lib)}
                role="option"
                aria-selected={isActive}
              >
                <span className={styles.rowCheck}>
                  {isActive ? <CheckIcon /> : null}
                </span>
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    autoFocus
                    className={styles.rowRenameInput}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setRenamingId(null);
                        setRenameDraft('');
                      }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.rowLabel}
                    onClick={() => {
                      if (!isActive) onSwitch?.(lib.id);
                      setOpen(false);
                    }}
                  >
                    {lib.name}
                  </button>
                )}
              </div>
            );
          })}

          <div className={styles.divider} />

          {creating ? (
            <div className={`${styles.row} ${styles.rowCreating}`}>
              <span className={styles.rowCheck}>
                <PlusIcon />
              </span>
              <input
                ref={createInputRef}
                autoFocus
                className={styles.rowRenameInput}
                placeholder="New library"
                value={createDraft}
                onChange={(e) => setCreateDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCreate();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setCreating(false);
                    setCreateDraft('');
                  }
                }}
                onBlur={commitCreate}
              />
            </div>
          ) : (
            <button
              type="button"
              className={`${styles.row} ${styles.rowAction}`}
              onClick={startCreating}
            >
              <span className={styles.rowCheck}>
                <PlusIcon />
              </span>
              <span className={styles.rowLabel}>New library</span>
            </button>
          )}
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
