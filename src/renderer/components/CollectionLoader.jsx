import React, { useMemo } from 'react';
import styles from './CollectionLoader.module.css';
import { fileUrl } from '../lib/fileUrl.js';

// Brief opening flourish when you enter a collection: its covers wrap into
// a 3D ring that slowly rotates, then the overlay fades to reveal the grid.
// Purely decorative — the grid is ready underneath the whole time.
const MIN_CARDS = 9;
const MAX_CARDS = 14;

export default function CollectionLoader({ thumbs = [], name, fading = false }) {
  const cards = useMemo(() => {
    const src = (thumbs || []).filter(Boolean);
    if (src.length === 0) return [];
    // Pad the ring by repeating so a small collection still reads as a
    // full band, capped so a huge one doesn't over-populate it.
    const target = Math.min(MAX_CARDS, Math.max(MIN_CARDS, src.length));
    return Array.from({ length: target }, (_, i) => src[i % src.length]);
  }, [thumbs]);

  if (cards.length === 0) return null;

  const n = cards.length;
  const cardW = 78;
  // Radius that seats N cards of width cardW evenly around the ring with a
  // little breathing room.
  const radius = Math.round((cardW * 1.18) / (2 * Math.tan(Math.PI / n)));

  return (
    <div className={`${styles.overlay}${fading ? ` ${styles.out}` : ''}`} aria-hidden="true">
      <div className={styles.scene}>
        {/* Tilt + push-back live on the wrapper (dynamic radius); the ring
            child just spins, so the animation never fights the transform. */}
        <div
          className={styles.tilt}
          style={{ transform: `rotateX(-14deg) translateZ(${-radius}px)` }}
        >
          <div className={styles.ring}>
            {cards.map((t, i) => (
              <div
                key={i}
                className={styles.card}
                style={{ transform: `rotateY(${(360 / n) * i}deg) translateZ(${radius}px)` }}
              >
                <img src={fileUrl(t)} alt="" draggable={false} />
              </div>
            ))}
          </div>
        </div>
      </div>
      {name && <div className={styles.label}>{name}</div>}
    </div>
  );
}
