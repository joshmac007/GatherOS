import React, { useEffect, useRef, useState } from 'react';
import styles from './FeaturedBuckets.module.css';
import { CollectionIcon } from './Sidebar.jsx';
import { fileUrl } from '../lib/fileUrl.js';

const PREVIEW_COUNT = 4;

export default function FeaturedBuckets({ collections, onPickBucket }) {
  const [previews, setPreviews] = useState({}); // { bucketId: [save, ...] }

  // Two-phase compact state for a clean cross-fade between expanded
  // cards and compact pills:
  //
  //   compact         — what the IntersectionObserver wants
  //   compactApplied  — what's currently rendered to the DOM
  //   fading          — true while the row is mid-transition
  //
  // When compact ≠ compactApplied, we fade the row to opacity 0,
  // swap the layout under cover, then fade back in. The tween
  // through ugly intermediate frames (rotated thumbs straightening
  // while their wrapper shrinks 110px → 22px) happens behind the
  // opacity:0 curtain, so the user only sees the two clean states
  // and a soft cross-fade between them.
  const [compact, setCompact] = useState(false);
  const [compactApplied, setCompactApplied] = useState(false);
  const [fading, setFading] = useState(false);
  const isInitial = useRef(true);
  const containerRef = useRef(null);
  const sentinelRef = useRef(null);

  // Tuning. 100/100ms total ≈ 200ms — quick enough to feel snappy,
  // slow enough to read as a deliberate transition rather than a
  // jump. Adjust both halves equally if you want it softer/snappier.
  const FADE_OUT_MS = 100;
  const FADE_IN_MS = 100;

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      setCompactApplied(compact);
      return;
    }
    if (compact === compactApplied) return;
    setFading(true);
    const t1 = setTimeout(() => setCompactApplied(compact), FADE_OUT_MS);
    const t2 = setTimeout(() => setFading(false), FADE_OUT_MS + FADE_IN_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [compact, compactApplied]);

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

  // Toggle compact based on whether a 1px sentinel sitting above the
  // row is visible inside the scroll container. The collapse → pill
  // direction is debounced ~180ms so a quick scroll-and-back near
  // the threshold doesn't flicker; expand is immediate so the cards
  // come back the instant you scroll up to the top.
  useEffect(() => {
    const sc = document.querySelector('.grid-scroll');
    const sentinel = sentinelRef.current;
    if (!sc || !sentinel || typeof IntersectionObserver === 'undefined') return;
    let collapseTimer = null;
    const obs = new IntersectionObserver(([entry]) => {
      if (collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }
      if (entry.isIntersecting) {
        setCompact(false);
      } else {
        collapseTimer = setTimeout(() => setCompact(true), 180);
      }
    }, {
      root: sc,
      threshold: 0,
      // No rootMargin — the sentinel sits at the very top of the
      // scroll content, so at scrollTop=0 it's intersecting and we
      // start in expanded-cards mode. (A negative top margin here
      // would shrink the root from the top and make the sentinel
      // "out" on initial load — kept the cards from ever rendering
      // their stacked thumbnails.) The 180ms debounce below is
      // enough buffer for slow-scroll near the edge.
    });
    obs.observe(sentinel);
    return () => {
      obs.disconnect();
      if (collapseTimer) clearTimeout(collapseTimer);
    };
  }, []);

  if (!collections || collections.length === 0) return null;

  return (
    <>
      {/* IntersectionObserver target — when this 1px line above the
          row scrolls out of view, the row collapses. */}
      <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
    <div
      ref={containerRef}
      className={[styles.row, compactApplied && styles.compact, fading && styles.fading].filter(Boolean).join(' ')}
    >
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
                    <span className={styles.stackEmptyIcon} style={{ color: 'var(--icon-blue)' }}>
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
    </>
  );
}
