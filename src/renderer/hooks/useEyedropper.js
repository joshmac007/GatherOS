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

  // Map a viewport cursor coord to a pixel in the source image,
  // accounting for object-fit: contain letterboxing. The previous
  // implementation scaled cursor → natural dims using the element's
  // bounding rect, which is wrong because object-fit: contain shrinks
  // the rendered image to whichever axis is more constrained and
  // centers it — so the element box has empty (letterbox) bands on
  // the other axis. Sampling at the cursor offset relative to the
  // ELEMENT was sampling the image at the wrong pixel by however
  // wide the letterbox happened to be.
  //
  // Here we compute the rendered image rect inside the element, then
  // map the cursor relative to THAT rect. Hits in the letterbox area
  // return null so the hover swatch / click sampler doesn't lie.
  function pixelAt(clientX, clientY) {
    const data = ensureCanvas();
    const img = imageRef.current;
    if (!data || !img) return null;

    const rect = img.getBoundingClientRect();
    const elAspect = rect.width / rect.height;
    const imgAspect = data.width / data.height;

    let renderedW;
    let renderedH;
    if (elAspect > imgAspect) {
      // Element wider than image → letterboxed on left + right.
      renderedH = rect.height;
      renderedW = rect.height * imgAspect;
    } else {
      // Element taller than image → letterboxed on top + bottom.
      renderedW = rect.width;
      renderedH = rect.width / imgAspect;
    }
    const offsetX = (rect.width - renderedW) / 2;
    const offsetY = (rect.height - renderedH) / 2;

    const localX = clientX - rect.left - offsetX;
    const localY = clientY - rect.top - offsetY;
    // Outside the rendered image (in the letterbox bands) → no sample.
    if (localX < 0 || localY < 0 || localX >= renderedW || localY >= renderedH) {
      return null;
    }

    const sx = Math.floor(localX * (data.width / renderedW));
    const sy = Math.floor(localY * (data.height / renderedH));
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
