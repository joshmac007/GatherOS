import { useCallback, useRef } from 'react';

const MAX_DEPTH = 50;

// Tiny LIFO undo stack. Each entry is { label, undoFn } — the
// label is shown in a "Undid <label>" toast after undo runs, the
// fn is responsible for reversing whatever mutation pushed it.
//
// Designed to be passed around as a stable handle: push/undo/clear
// are useCallback'd so consumer effects depending on them don't
// thrash. State lives in a ref because we never want a render to
// react to stack changes (the toast is the only feedback channel).
export function useUndoStack() {
  const stackRef = useRef([]);

  const push = useCallback((label, undoFn) => {
    if (typeof undoFn !== 'function') return;
    stackRef.current.push({ label, undoFn });
    if (stackRef.current.length > MAX_DEPTH) stackRef.current.shift();
  }, []);

  const undo = useCallback(() => {
    const entry = stackRef.current.pop();
    if (!entry) return null;
    try {
      const result = entry.undoFn();
      // Allow async undo fns; we still resolve the label
      // synchronously for the toast.
      if (result && typeof result.then === 'function') {
        result.catch((err) => console.error('Async undo failed:', err));
      }
    } catch (err) {
      console.error('Undo failed:', err);
    }
    return entry.label;
  }, []);

  const clear = useCallback(() => {
    stackRef.current = [];
  }, []);

  return { push, undo, clear };
}
