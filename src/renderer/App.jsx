import React, { useState, useCallback, useEffect } from 'react';
import Toast from './components/Toast.jsx';

let toastSeq = 0;

export default function App() {
  const [toasts, setToasts] = useState([]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    return window.moodmark.on('save:created', (record) => {
      showToast(record);
    });
  }, []);

  function showToast(record) {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, record }]);
    setTimeout(() => dismissToast(id), 2500);
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const hasImage = [...e.dataTransfer.items].some(
      (i) => i.kind === 'file' && i.type.startsWith('image/'),
    );
    if (hasImage) setDragging(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  }, []);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);

    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    for (const file of files) {
      try {
        const record = await window.moodmark.saves.dropFile(file.path);
        showToast(record);
      } catch (err) {
        console.error('Drop failed:', err);
      }
    }
  }, []);

  return (
    <div
      className={`app-shell${dragging ? ' drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="drag-region" />

      <main className="app-placeholder">
        <h1>Moodmark</h1>
        <p>Drop images here · Press ⌘⇧S to screenshot</p>
      </main>

      {dragging && (
        <div className="drop-overlay">
          <span className="drop-message">Drop to save</span>
        </div>
      )}

      <div className="toast-stack">
        {toasts.map((t) => (
          <Toast key={t.id} record={t.record} onDismiss={() => dismissToast(t.id)} />
        ))}
      </div>
    </div>
  );
}
