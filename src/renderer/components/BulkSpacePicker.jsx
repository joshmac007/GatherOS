import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Frame } from 'lucide-react';
import styles from './BulkSpacePicker.module.css';
import { fuzzyMatch } from '../lib/fuzzy.js';

// Compact popover for adding the multi-selected saves to a board in
// one shot. Mirrors BulkTagPicker's behaviour and visuals:
//   - empty input: shows the most recently-updated boards
//   - typed: fuzzy-matched against board names
//   - Enter applies the active row; Escape closes
//   - "Create <name>" appears when the typed value doesn't match an
//     existing board exactly — picking it creates the board first
//     then drops the saves on it.
//
// onPick(boardId) handles existing boards; onCreate(name) returns the
// new board so the parent can route the saves onto it.
export default function BulkSpacePicker({
  anchor,
  boards = [],
  count,
  onPick,
  onCreate,
  onClose,
}) {
  const [draft, setDraft] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onMouseDown(e) {
      if (!e.target.closest('[data-bulk-space-picker]')) onClose();
    }
    const t = setTimeout(() => window.addEventListener('mousedown', onMouseDown), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose]);

  const cleanedDraft = draft.trim();

  const suggestions = useMemo(() => {
    if (!cleanedDraft) {
      return [...boards]
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
        .slice(0, 8);
    }
    const lower = cleanedDraft.toLowerCase();
    return boards
      .map((b) => ({ board: b, match: fuzzyMatch(lower, (b.name || '').toLowerCase()) }))
      .filter((x) => x.match)
      .sort((a, b) => {
        if (a.match.score !== b.match.score) return a.match.score - b.match.score;
        return (a.board.name || '').localeCompare(b.board.name || '');
      })
      .slice(0, 8)
      .map((x) => x.board);
  }, [cleanedDraft, boards]);

  const showCreate = !!cleanedDraft
    && !boards.some((b) => (b.name || '').toLowerCase() === cleanedDraft.toLowerCase());
  const totalRows = suggestions.length + (showCreate ? 1 : 0);

  function commit(board) {
    if (board) onPick?.(board.id);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(totalRows - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex < suggestions.length && suggestions[activeIndex]) {
        commit(suggestions[activeIndex]);
      } else if (showCreate) {
        onCreate?.(cleanedDraft);
      }
    }
  }

  return (
    <div
      data-bulk-space-picker
      className={styles.popover}
      style={{ left: anchor.x, top: anchor.y }}
      role="dialog"
      aria-label="Add to space"
    >
      <input
        ref={inputRef}
        className={styles.input}
        placeholder={`Add ${count} ${count === 1 ? 'save' : 'saves'} to a space…`}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setActiveIndex(0); }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      <div className={styles.list} role="listbox">
        {suggestions.map((board, i) => (
          <button
            key={board.id}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            className={`${styles.item} ${i === activeIndex ? styles.itemActive : ''}`}
            onMouseDown={(e) => { e.preventDefault(); commit(board); }}
            onMouseEnter={() => setActiveIndex(i)}
          >
            <span className={styles.icon}>
              <Frame size={14} strokeWidth={1.7} aria-hidden="true" />
            </span>
            <span className={styles.name}>{board.name || 'Untitled space'}</span>
          </button>
        ))}
        {showCreate && (
          <button
            type="button"
            role="option"
            aria-selected={activeIndex === suggestions.length}
            className={`${styles.item} ${styles.createItem} ${activeIndex === suggestions.length ? styles.itemActive : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onCreate?.(cleanedDraft); }}
            onMouseEnter={() => setActiveIndex(suggestions.length)}
          >
            <span className={styles.createLabel}>Create</span>
            <span className={styles.icon}>
              <Frame size={14} strokeWidth={1.7} aria-hidden="true" />
            </span>
            <span className={styles.name}>{cleanedDraft}</span>
          </button>
        )}
        {suggestions.length === 0 && !showCreate && (
          <div className={styles.empty}>Type to create a space</div>
        )}
      </div>
    </div>
  );
}
