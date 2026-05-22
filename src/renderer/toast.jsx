import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
// Pull in the design tokens defined in variables.css — without this,
// every var(--surface-1) / var(--border) / var(--text-primary) inside
// Toast.module.css resolves to the empty fallback, which is why the
// pill looked transparent against busy desktop backgrounds.
import './styles/variables.css';
import Toast from './components/Toast.jsx';

const TOAST_TTL_MS = 2500;

// Single-toast model: while one is on screen, additional saves bump
// the counter and refresh the TTL instead of stacking another pill.
// The thumbnail always shows the most recent save so the user sees
// confirmation of the last thing they did.
function ToastStack() {
  const [current, setCurrent] = useState(null); // { record, count } | null
  const timerRef = useRef(null);

  useEffect(() => {
    return window.toast.onShow((record) => {
      setCurrent((prev) => ({
        record,
        count: prev ? prev.count + 1 : 1,
      }));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCurrent(null), TOAST_TTL_MS);
    });
  }, []);

  // Forward mouse events only while there's something to interact with.
  useEffect(() => {
    window.toast.setInteractive(!!current);
    if (!current) window.toast.empty();
  }, [current]);

  function handleDismiss() {
    if (!current) return;
    window.toast.openImage(current.record.file_path);
    if (timerRef.current) clearTimeout(timerRef.current);
    setCurrent(null);
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        bottom: 0,
        right: 0,
        padding: 16,
        display: 'flex',
        alignItems: 'flex-start',
      }}
    >
      {current && (
        <Toast
          record={current.record}
          count={current.count}
          onDismiss={handleDismiss}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ToastStack />);
