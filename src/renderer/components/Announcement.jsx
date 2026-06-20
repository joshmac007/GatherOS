import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './Announcement.module.css';

// Remote in-app notice. Polls the Worker (via main) on mount, on a slow
// interval, and on window focus, and renders a dismissible popup keyed by
// id — dismissing remembers that id in localStorage, so a brand-new
// announcement (new id) re-surfaces even after a prior dismissal.
//
// The text lives server-side (see server/src/announcement.ts), so updates
// ship without an app release.

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const DISMISSED_KEY = 'gatherosAnnouncementDismissed';

function readDismissed() {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function rememberDismissed(id) {
  try {
    const next = readDismissed().filter((x) => x !== id);
    next.push(id);
    // Keep the list small — only the last handful matter.
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next.slice(-20)));
  } catch {
    /* ignore */
  }
}

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export default function Announcement() {
  const [current, setCurrent] = useState(null);
  const [dismissedId, setDismissedId] = useState(null);
  const timerRef = useRef(null);

  const poll = useCallback(async () => {
    if (!window.moodmark?.announcement?.get) return;
    try {
      const res = await window.moodmark.announcement.get();
      setCurrent(res && res.ok ? res.announcement : null);
    } catch {
      /* fail-silent */
    }
  }, []);

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    const onFocus = () => poll();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timerRef.current);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll]);

  if (!current || !current.id) return null;
  // Hide if dismissed this session or in a prior one.
  if (dismissedId === current.id) return null;
  if (readDismissed().includes(current.id)) return null;

  const level = ['info', 'warning', 'incident'].includes(current.level)
    ? current.level
    : 'info';

  const dismiss = () => {
    rememberDismissed(current.id);
    setDismissedId(current.id);
  };

  const openCta = () => {
    if (current.ctaUrl && window.moodmark?.shell?.openUrl) {
      window.moodmark.shell.openUrl(current.ctaUrl);
    }
  };

  return (
    <div className={`${styles.card} ${styles[level]}`} role="status" aria-live="polite">
      <button className={styles.close} onClick={dismiss} aria-label="Dismiss announcement">
        <CloseIcon />
      </button>
      <div className={styles.dot} aria-hidden="true" />
      <div className={styles.content}>
        {current.title ? <div className={styles.title}>{current.title}</div> : null}
        {current.body ? <div className={styles.body}>{current.body}</div> : null}
        {current.ctaUrl ? (
          <button className={styles.cta} onClick={openCta}>
            {current.ctaLabel || 'Learn more'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
