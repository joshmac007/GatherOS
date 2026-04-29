import React from 'react';
import styles from './Toast.module.css';
import { fileUrl } from '../lib/fileUrl.js';

export default function Toast({ record, count = 1, onDismiss }) {
  const src = fileUrl(record.thumb_path);
  const label = count > 1 ? `Saved ${count} to library` : 'Saved to library';
  return (
    <div className={styles.toast} onClick={onDismiss} role="status">
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
    </div>
  );
}
