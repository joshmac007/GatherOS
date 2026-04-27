import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import styles from './ContextMenu.module.css';

function ChevronRightIcon() {
  return (
    <svg width="6" height="10" viewBox="0 0 6 10" aria-hidden="true">
      <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y, ready: false });
  // Index of the item whose submenu is currently open. Set when the
  // user hovers a parent item with a submenu; cleared when they hover
  // a different parent item.
  const [openSubmenuIdx, setOpenSubmenuIdx] = useState(null);

  useEffect(() => {
    function onMouseDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  // Clamp into the viewport; flip up if the menu would overflow the bottom.
  // When flipping, leave a small gap above the cursor so the bottom item
  // doesn't sit directly over the row that opened the menu — clicks
  // there can land on the underlying button instead of our item.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    const flipGap = 6;
    let nx = x;
    let ny = y;
    if (nx + rect.width > window.innerWidth - margin) {
      nx = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (ny + rect.height > window.innerHeight - margin) {
      ny = Math.max(margin, y - rect.height - flipGap);
    }
    setPos({ x: nx, y: ny, ready: true });
  }, [x, y, items]);

  const hasIcons = items.some((it) => it && it.icon);

  return ReactDOM.createPortal(
    <div
      ref={ref}
      className={[styles.menu, hasIcons && styles.menuWithIcons].filter(Boolean).join(' ')}
      style={{
        position: 'fixed',
        top: pos.y,
        left: pos.x,
        visibility: pos.ready ? 'visible' : 'hidden',
      }}
    >
      {items.map((item, i) => {
        if (item.type === 'separator') {
          return <div key={i} className={styles.separator} />;
        }
        if (item.type === 'header') {
          return <div key={i} className={styles.header}>{item.label}</div>;
        }
        const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
        const isOpen = hasSubmenu && openSubmenuIdx === i;
        const subHasIcons = hasSubmenu && item.submenu.some((s) => s && s.icon);
        return (
          <div
            key={i}
            className={styles.itemContainer}
            onMouseEnter={() => setOpenSubmenuIdx(hasSubmenu ? i : null)}
          >
            <button
              className={[
                styles.item,
                item.danger && styles.danger,
                isOpen && styles.itemActive,
              ].filter(Boolean).join(' ')}
              onClick={() => {
                if (hasSubmenu) return; // submenu items handle their own clicks
                item.onClick();
                onClose();
              }}
            >
              {hasIcons && (
                <span className={styles.itemIcon}>{item.icon || null}</span>
              )}
              <span className={styles.itemLabel}>{item.label}</span>
              {hasSubmenu && (
                <span className={styles.itemChevron}><ChevronRightIcon /></span>
              )}
            </button>
            {isOpen && (
              <div className={[styles.submenu, subHasIcons && styles.menuWithIcons].filter(Boolean).join(' ')}>
                {item.submenu.map((sub, j) => {
                  if (sub.type === 'separator') {
                    return <div key={j} className={styles.separator} />;
                  }
                  if (sub.type === 'header') {
                    return <div key={j} className={styles.header}>{sub.label}</div>;
                  }
                  return (
                    <button
                      key={j}
                      className={[styles.item, sub.danger && styles.danger].filter(Boolean).join(' ')}
                      onClick={() => { sub.onClick(); onClose(); }}
                    >
                      {subHasIcons && (
                        <span className={styles.itemIcon}>{sub.icon || null}</span>
                      )}
                      <span className={styles.itemLabel}>{sub.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
