import React from 'react';
import styles from './Toast.module.css';
import { fileUrl } from '../lib/fileUrl.js';

export default function Toast({ record, onDismiss }) {
  const src = fileUrl(record.thumb_path);
  return (
    <div className={styles.toast} onClick={onDismiss} role="status">
      {src && <img src={src} className={styles.thumb} alt="" />}
      <span className={styles.label}>Saved to library</span>
    </div>
  );
}
