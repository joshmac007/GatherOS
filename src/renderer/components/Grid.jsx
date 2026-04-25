import React, { useMemo } from 'react';
import ImageCard from './ImageCard.jsx';
import styles from './Grid.module.css';

function HeartGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41 0.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

export default function Grid({ saves, selected, onSelect, onOpen, onContextMenu, columns, loading, view }) {
  const columnBuckets = useMemo(() => {
    const buckets = Array.from({ length: columns }, () => []);
    saves.forEach((save, i) => {
      buckets[i % columns].push(save);
    });
    return buckets;
  }, [saves, columns]);

  if (loading && saves.length === 0) {
    return <div className={styles.state} />;
  }

  if (saves.length === 0) {
    const isCollection = view?.type === 'collection';
    const isFavorites = view?.type === 'favorites';

    let title = 'Nothing saved yet';
    let hint = 'Press ⌘⇧S to screenshot, or drag images into this window';
    if (isCollection) {
      title = 'Collection is empty';
      hint = 'Right-click any image and choose "Add to Collection"';
    } else if (isFavorites) {
      title = 'No favorites yet';
      hint = 'Click the heart on any image to favorite it';
    }

    return (
      <div className={styles.state}>
        {isCollection && (
          <div className={styles.emptyGraphic} aria-hidden="true">
            <div className={styles.blobs}>
              <div className={styles.blobA} />
              <div className={styles.blobB} />
              <div className={styles.blobC} />
            </div>
            <div className={`${styles.glassCardWrap} ${styles.cardA}`}>
              <div className={styles.glassCard} />
            </div>
            <div className={`${styles.glassCardWrap} ${styles.cardB}`}>
              <div className={styles.glassCard} />
            </div>
            <div className={`${styles.glassCardWrap} ${styles.cardC}`}>
              <div className={styles.glassCard} />
            </div>
          </div>
        )}
        {isFavorites && (
          <div className={styles.heartScene} aria-hidden="true">
            <span className={`${styles.ripple} ${styles.rippleA}`} />
            <span className={`${styles.ripple} ${styles.rippleB}`} />
            <span className={`${styles.ripple} ${styles.rippleC}`} />
            <span className={styles.heartCore}>
              <HeartGlyph />
            </span>
          </div>
        )}
        <div className={styles.emptyTitle}>{title}</div>
        <div className={styles.emptyHint}>{hint}</div>
      </div>
    );
  }

  return (
    <div
      className={styles.grid}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {columnBuckets.map((bucket, colIdx) => (
        <div key={colIdx} className={styles.column}>
          {bucket.map((s) => (
            <ImageCard
              key={s.id}
              record={s}
              selected={selected.has(s.id)}
              selectionActive={selected.size > 0}
              onSelect={onSelect}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
