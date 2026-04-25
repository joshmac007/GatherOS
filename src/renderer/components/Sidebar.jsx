import React from 'react';
import styles from './Sidebar.module.css';

const SMART_VIEWS = [
  { id: 'all', label: 'All Saves' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'recent', label: 'Recent' },
];

function SmartIcon({ id }) {
  if (id === 'favorites') return <span className={styles.icon}>★</span>;
  if (id === 'recent') return <span className={styles.icon}>◴</span>;
  return <span className={styles.icon}>▤</span>;
}

export default function Sidebar({ view, onViewChange, collections = [], counts = {} }) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>Moodmark</div>

      <nav className={styles.section}>
        {SMART_VIEWS.map((v) => {
          const active = view.type === v.id;
          return (
            <button
              key={v.id}
              className={`${styles.item} ${active ? styles.active : ''}`}
              onClick={() => onViewChange({ type: v.id })}
            >
              <SmartIcon id={v.id} />
              <span className={styles.label}>{v.label}</span>
              {counts[v.id] != null && (
                <span className={styles.count}>{counts[v.id]}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className={styles.sectionHeader}>Collections</div>
      <nav className={styles.section}>
        {collections.length === 0 ? (
          <div className={styles.empty}>No collections yet</div>
        ) : (
          collections.map((c) => {
            const active = view.type === 'collection' && view.id === c.id;
            return (
              <button
                key={c.id}
                className={`${styles.item} ${active ? styles.active : ''}`}
                onClick={() => onViewChange({ type: 'collection', id: c.id })}
              >
                <span className={styles.dot} style={{ background: c.color }} />
                <span className={styles.label}>{c.name}</span>
                {counts[c.id] != null && (
                  <span className={styles.count}>{counts[c.id]}</span>
                )}
              </button>
            );
          })
        )}
      </nav>
    </aside>
  );
}
