import React, { useEffect, useState } from 'react';
import styles from './FocusedView.module.css';
import { fileUrl } from '../lib/fileUrl.js';

function FitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 5.5V2h3.5" />
      <path d="M12 8.5V12h-3.5" />
      <path d="M8.5 2H12v3.5" />
      <path d="M5.5 12H2V8.5" />
    </svg>
  );
}

export default function FocusedView({
  record,
  index,
  total,
  onBack,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}) {
  const [fitToWindow, setFitToWindow] = useState(false);

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      } else if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, onPrev, onNext, hasPrev, hasNext]);

  const src = fileUrl(record.file_path);

  return (
    <div className={styles.focused}>
      <div className={styles.topBar}>
        <button className={styles.backBtn} onClick={onBack} title="Back to grid (Esc)">
          <span className={styles.chevron}>‹</span>
          <span>Back</span>
        </button>

        {total > 1 && (
          <div className={styles.counter}>
            {index + 1} / {total}
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.iconBtn} ${fitToWindow ? styles.iconBtnActive : ''}`}
            onClick={() => setFitToWindow((v) => !v)}
            title={fitToWindow ? 'Show at original size' : 'Fit to window'}
            aria-pressed={fitToWindow}
          >
            <FitIcon />
          </button>
        </div>
      </div>

      <div className={styles.stage}>
        {src && (
          <img
            src={src}
            className={`${styles.image} ${fitToWindow ? styles.imageFit : ''}`}
            alt={record.title || ''}
            draggable={false}
          />
        )}

        {hasPrev && (
          <button
            type="button"
            className={`${styles.navBtn} ${styles.navPrev}`}
            onClick={onPrev}
            title="Previous (←)"
          >
            ‹
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            className={`${styles.navBtn} ${styles.navNext}`}
            onClick={onNext}
            title="Next (→)"
          >
            ›
          </button>
        )}
      </div>
    </div>
  );
}
