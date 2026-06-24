import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './SunBlinds.module.css';

const SLATS = 14;

// Easter egg: a warm "late-afternoon sun through window blinds" wash
// across the whole app. The slats drop in, then stay up so you can peek —
// hovering an individual slat tilts it open to reveal the app behind it,
// like looking through real blinds. Click anywhere (or press any key) to
// draw them back up and dismiss.
export default function SunBlinds({ open, onClose }) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    // Let the fade-out play before unmounting.
    setTimeout(() => onClose?.(), 460);
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      closingRef.current = false;
      setClosing(false);
      return undefined;
    }
    window.addEventListener('keydown', requestClose);
    return () => window.removeEventListener('keydown', requestClose);
  }, [open, requestClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={`${styles.overlay} ${closing ? styles.closing : ''}`}
      onClick={requestClose}
      aria-hidden="true"
    >
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
