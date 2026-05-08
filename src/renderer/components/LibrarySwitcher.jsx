import React, { useEffect, useRef, useState } from 'react';
import { ChevronsUpDown, Check, Plus, Settings as SettingsIcon } from 'lucide-react';
import styles from './LibrarySwitcher.module.css';
import { CollectionIcon } from './Sidebar.jsx';
import { fileUrl } from '../lib/fileUrl.js';

const SwitcherIcon = () => <ChevronsUpDown size={15} strokeWidth={2} aria-hidden="true" />;
const CheckIcon = () => <Check size={11} strokeWidth={1.8} aria-hidden="true" />;
const PlusIcon = () => <Plus size={11} strokeWidth={1.8} aria-hidden="true" />;
const ManageIcon = () => <SettingsIcon size={12} strokeWidth={1.8} aria-hidden="true" />;

// Mini fanned thumbnail stack for each library row in the dropdown.
// Up to three images peek out at gentle tilts; on hover they fan out
// a little so the row feels alive. Empty libraries get a neutral
// outlined card with the bucket icon centered, sized identically so
// the layout doesn't shift between empty and populated rows.
function ThumbStack({ items }) {
  const populated = Array.isArray(items) && items.length > 0;
  return (
    <div className={styles.thumbStack} aria-hidden="true">
      {populated ? (
        items.slice(0, 3).map((s, i) => (
          <img
            key={s.id || i}
            className={styles.thumbStackImg}
            src={fileUrl(s.thumb_path || s.file_path)}
            alt=""
            draggable={false}
            style={{ '--idx': i }}
          />
        ))
      ) : (
        <div className={styles.thumbEmpty}>
          <CollectionIcon />
        </div>
      )}
    </div>
  );
}

// Top-of-toolbar dropdown that shows the active library and lets the
// user switch between libraries. The "···" actions button beside the
// trigger was retired in nav stage 9 — rename / delete moved to a
// dedicated Libraries settings page, reachable via the "Manage
// libraries" link at the bottom of the dropdown.
export default function LibrarySwitcher({
  libraries,
  activeId,
  onSwitch,
  onCreate,
  onOpenManage,
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState('');
  const [previews, setPreviews] = useState({});
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);
  const createInputRef = useRef(null);

  const active = libraries.find((l) => l.id === activeId) || libraries[0];

  // Fetch thumbnail previews for every library when the dropdown
  // opens. Cheap — read-only DB peek per library, returns at most
  // 4 rows.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      const next = {};
      await Promise.all(
        libraries.map(async (lib) => {
          try {
            const items = await window.moodmark.libraries.previews(lib.id, 4);
            next[lib.id] = Array.isArray(items) ? items : [];
          } catch {
            next[lib.id] = [];
          }
        }),
      );
      if (!cancelled) setPreviews(next);
    })();
    return () => { cancelled = true; };
  }, [open, libraries]);

  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e) {
      const inTrigger = triggerRef.current && triggerRef.current.contains(e.target);
      const inDropdown = dropdownRef.current && dropdownRef.current.contains(e.target);
      if (inTrigger || inDropdown) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        if (creating) {
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
  }, [open, creating]);

  function startCreating() {
    setCreating(true);
    setCreateDraft('');
    requestAnimationFrame(() => createInputRef.current?.focus());
  }

  async function commitCreate() {
    const next = createDraft.trim();
    setCreating(false);
    setCreateDraft('');
    if (!next) return;
    await onCreate?.(next);
  }

  if (!active) return null;

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
        <span className={styles.triggerSwitcher}>
          <SwitcherIcon />
        </span>
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className={styles.dropdown}
          role="listbox"
          aria-label="Libraries"
        >
          <div className={styles.dropdownGroup}>
            {libraries.map((lib, idx) => {
              const isActive = lib.id === active.id;
              return (
                <button
                  key={lib.id}
                  type="button"
                  className={[styles.row, isActive && styles.rowActive]
                    .filter(Boolean)
                    .join(' ')}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    if (!isActive) onSwitch?.(lib.id);
                    setOpen(false);
                  }}
                  style={{ '--idx': idx }}
                >
                  <ThumbStack items={previews[lib.id]} />
                  <span className={styles.rowLabel}>{lib.name}</span>
                  <span className={styles.rowCheck}>
                    {isActive ? <CheckIcon /> : null}
                  </span>
                </button>
              );
            })}
          </div>

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

          {onOpenManage && (
            <button
              type="button"
              className={`${styles.row} ${styles.rowAction}`}
              onClick={() => {
                setOpen(false);
                onOpenManage();
              }}
            >
              <span className={styles.rowCheck}>
                <ManageIcon />
              </span>
              <span className={styles.rowLabel}>Manage libraries</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
