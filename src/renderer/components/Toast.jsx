import React from 'react';
import styles from './Toast.module.css';

export default function Toast({ record, onDismiss }) {
  return (
    <div className={styles.toast} onClick={onDismiss} role="status">
      {record.thumb_path && (
        <img
          src={`file://${record.thumb_path}`}
          className={styles.thumb}
          alt=""
        />
      )}
      <span className={styles.label}>Saved to library</span>
    </div>
  );
}
