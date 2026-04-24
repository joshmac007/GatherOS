import React, { useEffect, useRef, useState, useCallback } from 'react';
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
  const [screenshot, setScreenshot] = useState(null);
  const [drag, setDrag] = useState(null);   // { start, end }
  const imgRef = useRef(null);

  useEffect(() => {
    captureScreen();
    const onKey = (e) => { if (e.key === 'Escape') window.captureOverlay.cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function captureScreen() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      await new Promise((res) => { video.onloadedmetadata = res; });
      await video.play();

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());

      setScreenshot(canvas.toDataURL('image/png'));
    } catch {
      window.captureOverlay.cancel();
    }
  }

  const onMouseDown = useCallback((e) => {
    const pt = { x: e.clientX, y: e.clientY };
    setDrag({ start: pt, end: pt });
  }, []);

  const onMouseMove = useCallback((e) => {
    setDrag((d) => d ? { ...d, end: { x: e.clientX, y: e.clientY } } : null);
  }, []);

  const onMouseUp = useCallback((e) => {
    if (!drag || !screenshot) return;
    const rect = normalizeRect(drag.start, { x: e.clientX, y: e.clientY });
    setDrag(null);
    if (rect.w < 10 || rect.h < 10) return;

    const dpr = window.devicePixelRatio || 1;
    const img = imgRef.current;
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;

    const crop = document.createElement('canvas');
    crop.width = rect.w * dpr;
    crop.height = rect.h * dpr;
    const ctx = crop.getContext('2d');
    const src = new Image();
    src.onload = () => {
      ctx.drawImage(
        src,
        rect.x * scaleX, rect.y * scaleY,
        rect.w * scaleX, rect.h * scaleY,
        0, 0, crop.width, crop.height,
      );
      window.captureOverlay.complete(crop.toDataURL('image/png'));
    };
    src.src = screenshot;
  }, [drag, screenshot]);

  const sel = drag ? normalizeRect(drag.start, drag.end) : null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, cursor: 'crosshair' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {screenshot ? (
        <>
          <img
            ref={imgRef}
            src={screenshot}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', display: 'block' }}
            alt=""
          />
          {sel ? (
            // Dim everything EXCEPT the selection via a big box-shadow.
            <div style={{
              position: 'absolute',
              left: sel.x, top: sel.y,
              width: sel.w, height: sel.h,
              background: 'transparent',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
              border: '2px solid rgba(255,255,255,0.85)',
              pointerEvents: 'none',
            }} />
          ) : (
            // No selection yet — dim the whole screen.
            <div style={{
              position: 'absolute', inset: 0,
              background: 'rgba(0,0,0,0.45)',
              pointerEvents: 'none',
            }} />
          )}
        </>
      ) : (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.6)', fontSize: 14,
          background: 'rgba(0,0,0,0.6)',
        }}>
          Preparing capture…
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<CaptureOverlay />);
