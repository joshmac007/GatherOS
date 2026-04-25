import React, { useMemo } from 'react';
import ImageCard from './ImageCard.jsx';
import styles from './Grid.module.css';

export default function Grid({ saves, selected, onSelect, onOpen, columns, loading }) {
  // Distribute saves across columns by index. Each column stacks its own
  // items, so a tall card only pushes items inside its own column down —
  // no whitespace gaps between rows. Modulo distribution preserves the
  // newest-first ordering across the visual top row.
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
    return (
      <div className={styles.state}>
        <div className={styles.emptyTitle}>Nothing saved yet</div>
        <div className={styles.emptyHint}>
          Press ⌘⇧S to screenshot, or drag images into this window
        </div>
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
            />
          ))}
        </div>
      ))}
    </div>
  );
}
