import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import styles from './ShortcutsModal.module.css';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

// Electron accelerator string ("CommandOrControl+Shift+S") → display
// key chips (⌘ ⇧ S). Mirrors SettingsModal's formatter so the capture
// row shows the user's actual configured hotkey, not a hardcoded one.
function acceleratorToKeys(value) {
  if (!value) return [];
  return value.split('+').map((tok) => {
    const t = tok.trim();
    switch (t) {
      case 'CommandOrControl':
      case 'CmdOrCtrl': return IS_MAC ? '⌘' : 'Ctrl';
      case 'Command': case 'Cmd': case 'Meta': case 'Super': return '⌘';
      case 'Control': case 'Ctrl': return IS_MAC ? '⌃' : 'Ctrl';
      case 'Shift': return '⇧';
      case 'Alt': case 'Option': return IS_MAC ? '⌥' : 'Alt';
      case 'Space': return 'Space';
      default: return t.length === 1 ? t.toUpperCase() : t;
    }
  });
}

const BASE_SECTIONS = [
  {
    title: 'Search',
    items: [
      { keys: ['⌘', 'K'], label: 'Open command palette' },
      { keys: ['⌘', 'F'], label: 'Focus search field' },
    ],
  },
  {
    title: 'Navigate',
    items: [
      { keys: ['⌘', '1'], label: 'Library' },
      { keys: ['⌘', '2'], label: 'Collections' },
      { keys: ['⌘', '3'], label: 'Spaces' },
    ],
  },
  {
    title: 'Library',
    items: [
      { keys: ['⌘', 'N'], label: 'New collection' },
      { keys: ['⌘', 'V'], label: 'Paste image from clipboard' },
      { keys: ['⌘', 'C'], label: 'Copy image to clipboard' },
      { keys: ['⌘ +', 'click'], label: 'Multi-select an image' },
    ],
  },
  {
    title: 'Selection',
    items: [
      { keys: ['⌘', 'A'], label: 'Select all visible images' },
      { keys: ['⌘ ⇧', 'A'], label: 'Clear selection' },
      { keys: ['Delete'], label: 'Delete selected images' },
      { keys: ['Esc'], label: 'Clear selection' },
    ],
  },
  {
    title: 'Focused image',
    items: [
      { keys: ['J', 'or', '→'], label: 'Next image' },
      { keys: ['K', 'or', '←'], label: 'Previous image' },
      { keys: ['Esc'], label: 'Back to grid' },
    ],
  },
];

const DEFAULT_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+S';

// Build the section list, splicing in a Capture section whose keys
// reflect the user's configured global hotkey.
function buildSections(captureShortcut) {
  const captureKeys = acceleratorToKeys(captureShortcut || DEFAULT_CAPTURE_SHORTCUT);
  const capture = {
    title: 'Capture',
    items: [{ keys: captureKeys, label: 'Capture a screenshot' }],
  };
  // After Search + Navigate, before Library.
  return [BASE_SECTIONS[0], BASE_SECTIONS[1], capture, ...BASE_SECTIONS.slice(2)];
}

export default function ShortcutsModal({ open, onClose, captureShortcut }) {
  const sections = buildSections(captureShortcut);
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Keyboard Shortcuts</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={styles.body}>
          {sections.map((section) => (
            <section key={section.title} className={styles.section}>
              <div className={styles.sectionTitle}>{section.title}</div>
              <ul className={styles.list}>
                {section.items.map((item) => (
                  <li key={item.label} className={styles.row}>
                    <span className={styles.rowLabel}>{item.label}</span>
                    <span className={styles.rowKeys}>
                      {item.keys.map((k, i) =>
                        // Tiny join words like "or" render as plain text;
                        // everything else is a kbd chip.
                        /^(or|\+|·)$/.test(k.trim()) ? (
                          <span key={i} className={styles.kbdSep}>{k}</span>
                        ) : (
                          <kbd key={i} className={styles.kbd}>{k}</kbd>
                        ),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
