import React, { useEffect, useState } from 'react';
import styles from './DbIntegrityBanner.module.css';

// Surfaces PRAGMA integrity_check failures from the SQLite library.
// Shown sticky (no dismiss) when corruption is detected, with an
// action that opens Settings → Data so the user can restore from a
// snapshot. Sits above AccountBanner so the data-loss warning takes
// precedence over billing/offline messaging.
export default function DbIntegrityBanner({ onOpenBackups }) {
  const [errors, setErrors] = useState(null);

  useEffect(() => {
    let cancelled = false;
    window.moodmark?.db?.integrity?.().then((result) => {
      if (cancelled) return;
      if (result && result.ok === false) {
        setErrors(result.errors || ['unknown']);
      }
    });
    return () => { cancelled = true; };
  }, []);

  if (!errors) return null;

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.text}>
        Library database has integrity issues. Restoring from a recent
        snapshot is recommended.
      </span>
      {onOpenBackups && (
        <button type="button" className={styles.action} onClick={onOpenBackups}>
          View backups
        </button>
      )}
    </div>
  );
}
