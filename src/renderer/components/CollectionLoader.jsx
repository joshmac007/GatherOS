import React, { useMemo } from 'react';
import styles from './CollectionLoader.module.css';
import { fileUrl } from '../lib/fileUrl.js';

// Brief opening flourish when you enter a collection: its images wrap into
// a 3D ring that slowly rotates, then the overlay fades to reveal the grid.
// Purely decorative — the grid is ready underneath the whole time.
const MAX_CARDS = 16;

export default function CollectionLoader({ thumbs = [], name, fading = false }) {
  const cards = useMemo(() => {
    // Distinct images only — never pad/repeat, so no image shows twice in
    // the ring. A small collection just makes a smaller ring.
    const seen = new Set();
    const src = [];
    for (const t of thumbs || []) {
      if (t && !seen.has(t)) { seen.add(t); src.push(t); }
    }
    return src.slice(0, MAX_CARDS);
  }, [thumbs]);

  if (cards.length === 0) return null;

  const n = cards.length;
  const cardW = 78;
  // Radius that seats N cards of width cardW evenly around the ring with a
  // little breathing room. Guard the trig for tiny rings (n < 3).
  const radius = n >= 3
    ? Math.round((cardW * 1.18) / (2 * Math.tan(Math.PI / n)))
    : 130;

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
