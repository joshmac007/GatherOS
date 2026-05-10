import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fileUrl } from '../lib/fileUrl.js';
import styles from './ConstellationView.module.css';

// A 2D map of the user's library. Each save is a point positioned
// by UMAP over its CLIP embedding (computed in the main process and
// cached). Renderer draws to a single canvas — pan/zoom via mouse +
// wheel, hover surfaces a tethered preview, double-click opens the
// save in the focused view.
//
// Coordinates: main process returns each point normalized to [-1, 1]
// in both axes (longest-axis fit). The renderer maps that to viewport
// space via a uniform scale + per-axis offset which the user can
// pan / zoom on top of.
export default function ConstellationView({ onPickSave, onLoaded }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const pointsRef = useRef([]);             // [{ id, x, y, color, thumb_path, ... }]
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  // Hovered point index — refs so the rAF render loop can read without
  // re-rendering React. The DOM preview reads from hoverState.
  const hoverIndexRef = useRef(-1);
  const draggingRef = useRef(false);
  const lastPointerRef = useRef({ x: 0, y: 0 });

  const [hoverState, setHoverState] = useState(null);  // { id, thumb, title, screenX, screenY }
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);

  // One-time fetch on mount. The main process caches the UMAP layout
  // against the embedding signature so a re-open of the view is
  // essentially free.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.moodmark.constellation.getPoints().then((result) => {
      if (cancelled) return;
      const pts = Array.isArray(result) ? result : (result?.points || []);
      pointsRef.current = pts;
      setEmpty(pts.length === 0);
      setLoading(false);
      onLoaded?.(pts.length);
    }).catch(() => {
      if (cancelled) return;
      pointsRef.current = [];
      setEmpty(true);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [onLoaded]);

  // Project a point's normalized coords [-1, 1] to canvas pixel
  // coords given the current pan/zoom transform.
  const project = useCallback((px, py, canvasW, canvasH) => {
    const t = transformRef.current;
    // Base scale fits the longest [-1, 1] range to 80% of the smaller
    // viewport axis, so the map breathes inside the viewport rather
    // than going edge-to-edge.
    const base = Math.min(canvasW, canvasH) * 0.4;
    const x = canvasW / 2 + (px * base + t.x) * t.k;
    const y = canvasH / 2 + (py * base + t.y) * t.k;
    return [x, y];
  }, []);

  // Inverse of project — for hover hit-test, walk the points list
  // and find the nearest within a small radius in screen pixels.
  const pickAt = useCallback((mx, my, canvasW, canvasH) => {
    const pts = pointsRef.current;
    let bestI = -1;
    let bestDist2 = 14 * 14;  // 14px hit radius
    for (let i = 0; i < pts.length; i += 1) {
      const [sx, sy] = project(pts[i].x, pts[i].y, canvasW, canvasH);
      const dx = sx - mx;
      const dy = sy - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestI = i;
      }
    }
    return bestI;
  }, [project]);

  // Render loop. Continuous rAF so pan/zoom feel buttery, but it's a
  // single canvas draw per frame so cost is bounded by point count.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');

    function resize() {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.floor(r.width * dpr);
      canvas.height = Math.floor(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    function frame() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      const pts = pointsRef.current;
      const hoverI = hoverIndexRef.current;
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i];
        const [x, y] = project(p.x, p.y, w, h);
        const r = i === hoverI ? 7 : 3.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = i === hoverI ? 1 : 0.85;
        ctx.fill();
        if (i === hoverI) {
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 12, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [project]);

  // Pointer interactions — pan with drag, hover-test on idle move,
  // open save on double-click, zoom on wheel.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    function onMouseDown(e) {
      draggingRef.current = true;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    }
    function onMouseMove(e) {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;

      if (draggingRef.current) {
        const dx = e.clientX - lastPointerRef.current.x;
        const dy = e.clientY - lastPointerRef.current.y;
        lastPointerRef.current = { x: e.clientX, y: e.clientY };
        const t = transformRef.current;
        t.x += dx / t.k;
        t.y += dy / t.k;
        // Drop hover while panning so the preview doesn't lag the cursor.
        if (hoverIndexRef.current !== -1) {
          hoverIndexRef.current = -1;
          setHoverState(null);
        }
        return;
      }

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const i = pickAt(mx, my, w, h);
      if (i !== hoverIndexRef.current) {
        hoverIndexRef.current = i;
        if (i === -1) {
          setHoverState(null);
        } else {
          const p = pointsRef.current[i];
          const [sx, sy] = project(p.x, p.y, w, h);
          setHoverState({
            id: p.id,
            thumb: fileUrl(p.thumb_path),
            title: p.title,
            screenX: r.left + sx,
            screenY: r.top + sy,
          });
        }
      }
      canvas.style.cursor = i === -1 ? 'grab' : 'pointer';
    }
    function onMouseUp() {
      draggingRef.current = false;
      canvas.style.cursor = 'grab';
    }
    function onDblClick() {
      const i = hoverIndexRef.current;
      if (i === -1) return;
      const p = pointsRef.current[i];
      if (p?.id) onPickSave?.(p.id);
    }
    function onWheel(e) {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const t = transformRef.current;
      // Zoom around the cursor: translate so the point under the
      // cursor stays put after scaling.
      const delta = -e.deltaY * 0.0015;
      const next = Math.max(0.3, Math.min(8, t.k * Math.exp(delta)));
      const ratio = next / t.k;
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      // Cursor in pre-scale "world" coords:
      const wx = (mx - cx) / t.k - t.x;
      const wy = (my - cy) / t.k - t.y;
      t.k = next;
      // Adjust pan so (wx, wy) reprojects to the same (mx, my):
      t.x = (mx - cx) / t.k - wx;
      t.y = (my - cy) / t.k - wy;
    }

    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [pickAt, project, onPickSave]);

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <canvas ref={canvasRef} className={styles.canvas} />
      {hoverState && (
        <div
          className={styles.preview}
          style={{ left: hoverState.screenX, top: hoverState.screenY }}
        >
          <img src={hoverState.thumb} alt="" draggable={false} />
          {hoverState.title && <span className={styles.previewTitle}>{hoverState.title}</span>}
        </div>
      )}
      {loading && (
        <div className={styles.statusOverlay} aria-live="polite">
          <span className={styles.statusDot} />
          <span>Composing your sky…</span>
        </div>
      )}
      {!loading && empty && (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No constellation yet</div>
          <div className={styles.emptyHint}>
            Save a few images and the AI-indexer will place them in 2D space — one star per save.
          </div>
        </div>
      )}
    </div>
  );
}
