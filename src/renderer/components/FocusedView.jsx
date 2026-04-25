import React, { useEffect, useRef, useState } from 'react';
import styles from './FocusedView.module.css';
import { fileUrl } from '../lib/fileUrl.js';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.05;

function StarIcon({ filled }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="8,1.7 10,6 14.5,6.5 11,9.5 12,14 8,11.7 4,14 5,9.5 1.5,6.5 6,6" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.75 2.5h4v4" />
      <path d="M13.75 2.5L8 8.25" />
      <path d="M13 9.5v3.5a0.5 0.5 0 0 1 -0.5 0.5H3.5a0.5 0.5 0 0 1 -0.5 -0.5V4a0.5 0.5 0 0 1 0.5 -0.5H6.5" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5v8.5" />
      <path d="M4.5 5L8 1.5 11.5 5" />
      <path d="M2.75 10v3a0.5 0.5 0 0 0 0.5 0.5h9.5a0.5 0.5 0 0 0 0.5 -0.5v-3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h11" />
      <path d="M5.5 4V2.5a0.75 0.75 0 0 1 0.75 -0.75h3.5a0.75 0.75 0 0 1 0.75 0.75V4" />
      <path d="M3.75 4v9a0.75 0.75 0 0 0 0.75 0.75h7a0.75 0.75 0 0 0 0.75 -0.75V4" />
      <path d="M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

function defaultExportName(record) {
  const ext = (record.file_path.split('.').pop() || 'png').toLowerCase();
  if (record.title) return `${record.title}.${ext}`;
  return `moodmark-${record.id.slice(0, 8)}.${ext}`;
}

export default function FocusedView({
  record,
  index,
  total,
  onBack,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onToggleFavorite,
  onOpenInPreview,
  onDelete,
}) {
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef(null);
  const favorited = !!record.favorited;

  // Reset zoom whenever the user moves to a different image.
  useEffect(() => {
    setZoom(1);
  }, [record.id]);

  // Re-center the scroll position whenever the wrapper size changes,
  // so zooming feels like it pivots around the middle of the image.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
  }, [zoom, record.id]);

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      } else if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, onPrev, onNext, hasPrev, hasNext]);

  const src = fileUrl(record.file_path);
  const zoomFillPct = ((zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100;

  const handleExport = () => {
    window.moodmark.image.export(record.file_path, defaultExportName(record));
  };

  return (
    <div className={styles.focused}>
      <div className={styles.topBar}>
        <button
          className={styles.backBtn}
          onClick={onBack}
          aria-label="Back to grid"
          title="Back to grid (Esc)"
        >
          <span className={styles.chevron}>‹</span>
        </button>

        {total > 1 && (
          <div className={styles.counter}>
            {index + 1} / {total}
          </div>
        )}

        <div className={styles.actions}>
          <div className={styles.zoom} title="Zoom">
            <button
              type="button"
              className={styles.zoomLabel}
              onClick={() => setZoom(1)}
              title="Reset to 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={ZOOM_STEP}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className={styles.slider}
              style={{ '--zoom-fill': `${zoomFillPct}%` }}
              aria-label="Zoom"
            />
          </div>

          <span className={styles.divider} aria-hidden="true" />

          <button
            type="button"
            className={[styles.iconBtn, favorited && styles.iconBtnFavorited].filter(Boolean).join(' ')}
            title={favorited ? 'Favorited' : 'Favorite'}
            onClick={() => onToggleFavorite(record.id, !favorited)}
            aria-pressed={favorited}
          >
            <StarIcon filled={favorited} />
          </button>

          <button
            type="button"
            className={styles.iconBtn}
            title="Open in Preview"
            onClick={() => onOpenInPreview(record.file_path)}
          >
            <PreviewIcon />
          </button>

          <button
            type="button"
            className={styles.iconBtn}
            title="Export…"
            onClick={handleExport}
          >
            <ExportIcon />
          </button>

          <button
            type="button"
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            title="Delete"
            onClick={() => onDelete(record.id)}
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`${styles.stage} ${zoom > 1 ? styles.stageScroll : ''}`}
      >
        {src && (
          <div
            className={styles.imageWrap}
            style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
          >
            <img
              src={src}
              className={styles.image}
              alt={record.title || ''}
              draggable={false}
            />
          </div>
        )}

        {(hasPrev || hasNext) && zoom <= 1 && (
          <div className={styles.navHint}>
            <kbd className={styles.kbd}>←</kbd>
            <kbd className={styles.kbd}>→</kbd>
            <span>to navigate</span>
          </div>
        )}
      </div>
    </div>
  );
}
