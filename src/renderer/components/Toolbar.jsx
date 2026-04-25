import React from 'react';
import styles from './Toolbar.module.css';

export default function Toolbar({ search, onSearchChange, density, onDensityChange, count }) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.searchWrap}>
        <span className={styles.searchIcon}>⌕</span>
        <input
          className={styles.search}
          type="search"
          placeholder="Search by title or tag"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {count != null && (
        <span className={styles.count}>
          {count} {count === 1 ? 'save' : 'saves'}
        </span>
      )}

      <button
        className={styles.densityBtn}
        onClick={() => onDensityChange(density === 4 ? 2 : 4)}
        title={density === 4 ? 'Switch to larger previews' : 'Switch to denser grid'}
      >
        {density === 4 ? '▦' : '▤'}
      </button>
    </div>
  );
}
