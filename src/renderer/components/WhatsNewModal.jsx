import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import styles from './WhatsNewModal.module.css';
import FeatureCardStack from './FeatureCardStack.jsx';

function SparkleIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.4l1.5 3.7 3.7 1.5-3.7 1.5L8 11.8 6.5 8.1 2.8 6.6l3.7-1.5z" />
      <path d="M13 9.5l0.6 1.5 1.5 0.6-1.5 0.6L13 13.6l-0.6-1.4-1.5-0.6 1.5-0.6z" opacity="0.55" />
    </svg>
  );
}

export default function WhatsNewModal({ open, onClose, notes }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Enter') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !notes) return null;

  return ReactDOM.createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label={`What's new in ${notes.version}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.hero}>
          <div className={styles.heroIcon}>
            <SparkleIcon />
          </div>
          <h2 className={styles.title}>What’s new in {notes.version}</h2>
          <p className={styles.subtitle}>
            A few things have shifted since you were last here.
          </p>
        </div>

        <FeatureCardStack features={notes.items} />

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.gotItBtn}
            onClick={onClose}
            autoFocus
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
