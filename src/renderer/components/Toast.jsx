import React from 'react';
import { X as XIcon } from 'lucide-react';
import styles from './Toast.module.css';
import { fileUrl } from '../lib/fileUrl.js';

// When `record` is null, the pill renders as an empty dark shell.
// The toast window stays mounted at opacity 0 between toasts; the
// shell makes sure the moment opacity flips to 1, we see the dark
// glass material — not raw light-mode vibrancy peeking through
// the window-show → React-render gap.
export default function Toast({ record, count = 1, onDismiss }) {
  if (!record) {
    return <div className={styles.toast} aria-hidden="true" />;
  }
  const src = fileUrl(record.thumb_path);
  const label = count > 1 ? `Saved ${count} to library` : 'Saved to library';
  return (
    <div className={styles.toast} role="status">
      {src && (
        <div className={styles.thumbWrap}>
          <img
            key={record.id}
            src={src}
            className={styles.thumb}
            alt=""
          />
          {count > 1 && (
            <span className={styles.badge} aria-label={`${count} saves`}>
              +{count - 1}
            </span>
          )}
        </div>
      )}
      <span className={styles.label}>{label}</span>
      <button
        type="button"
        className={styles.dismissBtn}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <XIcon size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
