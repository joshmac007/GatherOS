import React, { useEffect, useRef, useState } from 'react';
import styles from './FeaturedBuckets.module.css';
import { CollectionIcon } from './Sidebar.jsx';
import { fileUrl } from '../lib/fileUrl.js';

const PREVIEW_COUNT = 4;

// Two-layer layout for the featured buckets:
//   1. .cardsRow flows with the masonry — when you scroll, the cards
//      go up and out of view naturally, no sticky positioning.
//   2. .pillBar is sticky at top: 0, invisible by default. Once the
//      sentinel at the bottom of .cardsRow leaves the viewport (i.e.
//      the cards have scrolled past), pillBar fades in. Scroll back
//      up and it fades out as the cards come back.
export default function FeaturedBuckets({ collections, onPickBucket }) {
  const [previews, setPreviews] = useState({}); // { bucketId: [save, ...] }
  const [pillsVisible, setPillsVisible] = useState(false);
  const sentinelRef = useRef(null);

  // Pre-fetch up to N preview images per bucket. One IPC per bucket;
  // fine for sidebars with a handful of buckets, would want a single
  // batch query at much larger scale.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const next = {};
      await Promise.all(
        collections.map(async (c) => {
          try {
            const data = await window.moodmark.saves.getAll({ collectionId: c.id });
            next[c.id] = (data || []).slice(0, PREVIEW_COUNT);
          } catch {
            next[c.id] = [];
          }
        }),
      );
      if (!cancelled) setPreviews(next);
    }
    load();
    return () => { cancelled = true; };
  }, [collections]);

  // Sentinel at the bottom of .cardsRow. While it's in the scroll
  // viewport, cards are still at least partially visible — keep
  // pills hidden. Once it scrolls out the top, cards have fully
  // gone behind the title bar — fade pills in.
  useEffect(() => {
    const sc = document.querySelector('.grid-scroll');
    const sentinel = sentinelRef.current;
    if (!sc || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(([entry]) => {
      setPillsVisible(!entry.isIntersecting);
    }, { root: sc, threshold: 0 });
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, []);

  if (!collections || collections.length === 0) return null;

  return (
    <>
      {/* Sticky pill bar — always rendered, opacity-controlled.
          pointer-events flips with visibility so clicks don't fall
          on invisible pills overlaying the masonry. */}
      <div
        className={[styles.pillBar, pillsVisible && styles.pillBarVisible]
          .filter(Boolean)
          .join(' ')}
        aria-hidden={!pillsVisible}
      >
        <div className={styles.scroller}>
          {collections.map((c) => {
            const items = previews[c.id] || [];
            return (
              <button
                key={`pill-${c.id}`}
                type="button"
                className={[styles.card, styles.pillCard].join(' ')}
                onClick={() => onPickBucket?.(c.id)}
                title={c.name}
                tabIndex={pillsVisible ? 0 : -1}
              >
                <div className={styles.stack}>
                  {items.length === 0 ? (
                    <div className={styles.stackEmpty}>
                      <span className={styles.stackEmptyIcon}>
                        <CollectionIcon />
                      </span>
                    </div>
                  ) : (
                    items.slice(0, 1).map((s) => (
                      <img
                        key={s.id}
                        src={fileUrl(s.thumb_path || s.file_path)}
                        alt=""
                        draggable={false}
                      />
                    ))
                  )}
                </div>
                <div className={styles.meta}>
                  <span className={styles.name}>{c.name}</span>
                  <span className={styles.count}>
                    <span className={styles.countNum}>{c.save_count}</span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Cards row — normal flow, scrolls with content. */}
      <div className={styles.cardsRow}>
        <div className={styles.scroller}>
          {collections.map((c) => {
            const items = previews[c.id] || [];
            return (
              <button
                key={c.id}
                type="button"
                className={styles.card}
                onClick={() => onPickBucket?.(c.id)}
                title={c.name}
              >
                <div className={styles.stack}>
                  {items.length === 0 ? (
                    <div className={styles.stackEmpty}>
                      <span className={styles.stackEmptyIcon}>
                        <CollectionIcon />
                      </span>
                    </div>
                  ) : (
                    items.slice(0, PREVIEW_COUNT).map((s) => (
                      <img
                        key={s.id}
                        src={fileUrl(s.thumb_path || s.file_path)}
                        alt=""
                        draggable={false}
                      />
                    ))
                  )}
                </div>
                <div className={styles.meta}>
                  <span className={styles.name}>{c.name}</span>
                  <span className={styles.count}>
                    <span className={styles.countNum}>{c.save_count}</span>
                    <span className={styles.countLabel}> {c.save_count === 1 ? 'save' : 'saves'}</span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Sentinel at bottom of cards row — drives pillBar visibility. */}
      <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
    </>
  );
}
