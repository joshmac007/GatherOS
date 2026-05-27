import { useEffect, useRef, useState } from 'react';

// Shared eyedropper logic for any component that has an <img> ref.
// Caller is responsible for:
//   • Wiring `handleImageMouseMove` + `handleImageClick` onto the
//     image, plus a crosshair cursor while picking is true.
//   • Rendering a button (or any UI) that calls `togglePicking`.
//   • Rendering a cursor-following tooltip (with hoverHex/hoverPos)
//     using whatever style module they prefer.
//
// What the hook owns:
//   • Building a sampling canvas once when picking starts.
//   • Per-mousemove pixel reads via getImageData(1,1).
//   • Click → write hex to clipboard + flash justCopied for 900ms,
//     then auto-deactivate.
//   • Escape cancels without sampling.
//   • Resets on recordId change so a stuck-on crosshair doesn't
//     follow the user across saves.
export function useEyedropper(imageRef, recordId) {
  const [picking, setPicking] = useState(false);
  const [hoverHex, setHoverHex] = useState(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [justCopied, setJustCopied] = useState(false);
  const canvasDataRef = useRef(null);

  useEffect(() => {
    setPicking(false);
    setHoverHex(null);
    setJustCopied(false);
  }, [recordId]);

  useEffect(() => {
    if (!picking) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPicking(false);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picking]);

  useEffect(() => {
    if (!picking) {
      canvasDataRef.current = null;
      setHoverHex(null);
      setJustCopied(false);
    }
  }, [picking]);

  // Lazy-init the sampling canvas. We do this on first hover/click
  // rather than on mode start so we don't race the image's load —
  // by the time the user has moved the mouse to the image, we know
  // the <img>'s natural dimensions are populated.
  function ensureCanvas() {
    if (canvasDataRef.current) return canvasDataRef.current;
    const img = imageRef.current;
    if (!img) {
      console.warn('[eyedropper] no image ref');
      return null;
    }
    if (!img.naturalWidth) {
      console.warn('[eyedropper] image has no natural dimensions yet');
      return null;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      // Probe getImageData once now so a tainted-canvas SecurityError
      // surfaces in the console immediately instead of failing
      // silently on every hover via the pixelAt catch.
      try { ctx.getImageData(0, 0, 1, 1); }
      catch (err) {
        console.error('[eyedropper] canvas tainted — getImageData blocked:', err);
        return null;
      }
      canvasDataRef.current = {
        ctx,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
      return canvasDataRef.current;
    } catch (err) {
      console.error('[eyedropper] canvas init failed:', err);
      return null;
    }
  }

  function pixelAt(clientX, clientY) {
    const data = ensureCanvas();
    const img = imageRef.current;
    if (!data || !img) return null;
    const rect = img.getBoundingClientRect();
    const sx = Math.floor((clientX - rect.left) * (data.width / rect.width));
    const sy = Math.floor((clientY - rect.top) * (data.height / rect.height));
    if (sx < 0 || sy < 0 || sx >= data.width || sy >= data.height) return null;
    try {
      const px = data.ctx.getImageData(sx, sy, 1, 1).data;
      return (
        '#' +
        [px[0], px[1], px[2]]
          .map((c) => c.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
      );
    } catch (err) {
      console.error('[eyedropper] sample failed:', err);
      return null;
    }
  }

  function handleImageMouseMove(e) {
    if (!picking || justCopied) return;
    const hex = pixelAt(e.clientX, e.clientY);
    if (hex) {
      setHoverHex(hex);
      setHoverPos({ x: e.clientX, y: e.clientY });
    }
  }

  async function handleImageClick(e) {
    if (!picking) return;
    const hex = pixelAt(e.clientX, e.clientY);
    if (!hex) return;
    try {
      await navigator.clipboard.writeText(hex.toLowerCase());
    } catch (err) {
      console.error('Eyedropper copy failed:', err);
    }
    setHoverHex(hex);
    setHoverPos({ x: e.clientX, y: e.clientY });
    setJustCopied(true);
    setTimeout(() => setPicking(false), 900);
  }

  return {
    picking,
    togglePicking: () => setPicking((v) => !v),
    handleImageClick,
    handleImageMouseMove,
    hoverHex,
    hoverPos,
    justCopied,
  };
}
