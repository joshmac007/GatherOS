import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function CaptureOverlay() {
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') window.captureOverlay.cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onMouseDown = useCallback((e) => {
    const pt = { x: e.clientX, y: e.clientY };
    setDrag({ start: pt, end: pt });
  }, []);

  const onMouseMove = useCallback((e) => {
    setDrag((d) => (d ? { ...d, end: { x: e.clientX, y: e.clientY } } : null));
  }, []);

  const onMouseUp = useCallback((e) => {
    if (!drag) return;
    const rect = normalizeRect(drag.start, { x: e.clientX, y: e.clientY });
    setDrag(null);
    if (rect.w < 10 || rect.h < 10) {
      window.captureOverlay.cancel();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    window.captureOverlay.complete({
      x: Math.round(rect.x * dpr),
      y: Math.round(rect.y * dpr),
      w: Math.round(rect.w * dpr),
      h: Math.round(rect.h * dpr),
    });
  }, [drag]);

  const sel = drag ? normalizeRect(drag.start, drag.end) : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        cursor: 'crosshair',
        background: 'transparent',
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {sel && (
        <div style={{
          position: 'absolute',
          left: sel.x, top: sel.y,
          width: sel.w, height: sel.h,
          border: '2px solid rgba(255, 255, 255, 0.95)',
          boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.6)',
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }} />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<CaptureOverlay />);
