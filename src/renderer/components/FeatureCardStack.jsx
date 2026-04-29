import React, { useEffect, useState } from 'react';
import styles from './FeatureCardStack.module.css';

const POSITION_CLASSES = ['pos0', 'pos1', 'pos2', 'pos3', 'pos4'];

// Auto-rotating stack of feature cards. Each card gets its turn at
// the front for `intervalMs`; cards behind fan out at gentle tilts
// to suggest "there's more". The user can also click a back card
// or a dot to jump to that one — auto-rotation pauses while hovered
// so they have time to read.
export default function FeatureCardStack({
  features,
  intervalMs = 3800,
  variant = 'default',
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || features.length <= 1) return undefined;
    const id = setInterval(() => {
      setActiveIndex((i) => (i + 1) % features.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [features.length, intervalMs, paused]);

  return (
    <div
      className={[styles.wrap, variant === 'accent' && styles.wrapAccent]
        .filter(Boolean)
        .join(' ')}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className={styles.stack} role="list" aria-live="polite">
        {features.map((f, i) => {
          // Position 0 = front card. Cards further back have higher pos.
          const pos = (i - activeIndex + features.length) % features.length;
          const posClass = POSITION_CLASSES[Math.min(pos, POSITION_CLASSES.length - 1)];
          const Icon = f.Icon;
          return (
            <button
              type="button"
              key={f.title}
              className={[styles.card, styles[posClass]].join(' ')}
              onClick={() => setActiveIndex(i)}
              aria-current={pos === 0}
              aria-label={f.title}
              tabIndex={pos === 0 ? 0 : -1}
            >
              <span className={styles.iconChip}>
                <Icon />
              </span>
              <span className={styles.cardTitle}>{f.title}</span>
              <span className={styles.cardDesc}>{f.description}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.dots} role="tablist" aria-label="Features">
        {features.map((f, i) => (
          <button
            type="button"
            key={f.title}
            role="tab"
            aria-selected={i === activeIndex}
            aria-label={f.title}
            className={[styles.dot, i === activeIndex && styles.dotActive]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setActiveIndex(i)}
          />
        ))}
      </div>
    </div>
  );
}
