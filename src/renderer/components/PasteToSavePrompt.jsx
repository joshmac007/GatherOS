import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Link as LinkIcon } from 'lucide-react';
import styles from './PasteToSavePrompt.module.css';
import { requestUpgrade } from '../context/entitlement.jsx';

// Paste-aware "save a URL" prompt. When the window regains focus and a
// fresh http(s) link is on the clipboard, this slides in from the corner
// offering a one-tap save with a live preview (favicon / title / cover).
// Dismissing or saving a link suppresses it so it never nags about the
// same URL twice in a session. Manual entry lives in the + → Save URL
// modal; this surface is purely the clipboard convenience.

function clipboardUrl(raw) {
  const t = (raw || '').trim();
  return /^https?:\/\/\S+$/i.test(t) ? t : '';
}

function minimalPreview(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');
    return { title: host, siteName: host, image: '', favicon: `${u.origin}/favicon.ico` };
  } catch {
    return null;
  }
}

export default function PasteToSavePrompt({ onSaved, onVisibleChange, paused = false }) {
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewState, setPreviewState] = useState('idle'); // idle|loading|done|fail
  const [coverError, setCoverError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const handledRef = useRef(new Set()); // urls dismissed/saved this session
  const lastClipRef = useRef('');
  const reqRef = useRef(0);

  // Detect a copied link when the window regains focus (and on mount).
  useEffect(() => {
    if (paused) return undefined;
    let cancelled = false;
    async function check() {
      let clip = '';
      try { clip = ((await navigator.clipboard.readText()) || '').trim(); }
      catch { return; } // clipboard permission denied — non-fatal
      if (cancelled || !clip || clip === lastClipRef.current) return;
      lastClipRef.current = clip;
      const url = clipboardUrl(clip);
      if (!url || handledRef.current.has(url)) return;
      setLink(url);
      setSaved(false);
      setSaving(false);
      setPreviewState('loading');
      setCoverError(false);
      const id = ++reqRef.current;
      try {
        const res = await window.moodmark?.saves?.previewUrl?.(url);
        if (id !== reqRef.current || cancelled) return;
        if (res?.ok && res.preview) { setPreview(res.preview); setPreviewState('done'); return; }
      } catch { /* fall through to minimal */ }
      if (id !== reqRef.current || cancelled) return;
      const m = minimalPreview(url);
      setPreview(m);
      setPreviewState(m ? 'done' : 'fail');
    }
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const visible = !!link && !paused;
  useEffect(() => {
    onVisibleChange?.(visible);
    return () => onVisibleChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  function reset() {
    setLink('');
    setPreview(null);
    setPreviewState('idle');
    setSaved(false);
    setSaving(false);
  }

  function dismiss() {
    handledRef.current.add(link);
    reset();
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await window.moodmark?.saves?.captureUrl?.(link);
      if (res?.needsUpgrade) { handledRef.current.add(link); reset(); requestUpgrade('save'); return; }
      if (!res?.ok) { setSaving(false); return; }
      handledRef.current.add(link);
      setSaved(true);
      onSaved?.(res.record, { duplicate: !!res.duplicate });
      setTimeout(reset, 1000);
    } catch {
      setSaving(false);
    }
  }

  return ReactDOM.createPortal(
    <div className={styles.prompt} role="dialog" aria-label="Save copied link">
      <div className={styles.head}>
        <span className={styles.headLeft}>
          <LinkIcon size={15} strokeWidth={1.9} aria-hidden="true" /> Save a URL
        </span>
      </div>

      {previewState === 'loading' && (
        <div className={styles.loading}><span className={styles.spinner} aria-hidden="true" />Fetching preview…</div>
      )}
      {previewState === 'done' && preview && (
        <div className={styles.pv}>
          {preview.image && !coverError ? (
            <img className={styles.thumb} src={preview.image} alt="" onError={() => setCoverError(true)} />
          ) : (
            <div className={styles.thumbFallback} aria-hidden="true"><LinkIcon size={18} strokeWidth={1.8} /></div>
          )}
          <div className={styles.meta}>
            <span className={styles.title}>{preview.title}</span>
            <span className={styles.site}>
              {preview.favicon && (
                <img className={styles.fav} src={preview.favicon} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              )}
              {preview.siteName}
            </span>
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.dismiss} onClick={dismiss} disabled={saving}>Dismiss</button>
        <button type="button" className={styles.save} onClick={save} disabled={saving || saved}>
          {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save this link'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
