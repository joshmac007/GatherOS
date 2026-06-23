import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './SunBlinds.module.css';

const SLATS = 14;

// Easter egg: a warm "late-afternoon sun through window blinds" wash
// across the whole app. Purely decorative — it auto-dismisses, and any
// click or keypress clears it early.
export default function SunBlinds({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const close = () => onClose?.();
    const timer = setTimeout(close, 4200);
    window.addEventListener('keydown', close);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', close);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className={styles.overlay} onClick={() => onClose?.()} aria-hidden="true">
      <div className={styles.warmth} />
      <div className={styles.beam} />
      <div className={styles.blinds}>
        {Array.from({ length: SLATS }).map((_, i) => (
          <span key={i} className={styles.slat} style={{ '--i': i }} />
        ))}
      </div>
    </div>,
    document.body,
  );
}
