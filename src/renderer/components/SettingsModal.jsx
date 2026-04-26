import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import styles from './SettingsModal.module.css';

const STATUS_IDLE = 'idle';
const STATUS_TESTING = 'testing';
const STATUS_OK = 'ok';
const STATUS_ERROR = 'error';

export default function SettingsModal({ open, onClose, onConfiguredChange }) {
  const [hasKey, setHasKey] = useState(false);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState(STATUS_IDLE);
  const [errorMessage, setErrorMessage] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.moodmark.settings.hasOpenAIKey().then((v) => {
      if (cancelled) return;
      setHasKey(!!v);
    });
    setDraft('');
    setStatus(STATUS_IDLE);
    setErrorMessage('');
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setStatus(STATUS_TESTING);
    setErrorMessage('');
    const result = await window.moodmark.settings.setOpenAIKey(trimmed);
    if (result.ok) {
      setStatus(STATUS_OK);
      setHasKey(true);
      setDraft('');
      onConfiguredChange?.(true);
      // Brief success state then close
      setTimeout(() => {
        if (status !== STATUS_ERROR) onClose();
      }, 700);
    } else {
      setStatus(STATUS_ERROR);
      setErrorMessage(reasonToMessage(result.reason));
    }
  }

  async function handleClear() {
    await window.moodmark.settings.clearOpenAIKey();
    setHasKey(false);
    setStatus(STATUS_IDLE);
    setErrorMessage('');
    onConfiguredChange?.(false);
  }

  async function handleTest() {
    setStatus(STATUS_TESTING);
    setErrorMessage('');
    const result = await window.moodmark.settings.testOpenAIKey();
    if (result.ok) {
      setStatus(STATUS_OK);
    } else {
      setStatus(STATUS_ERROR);
      setErrorMessage(reasonToMessage(result.reason));
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && draft.trim()) handleSave();
  }

  return ReactDOM.createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </header>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>OpenAI</div>
          <p className={styles.sectionHint}>
            Bring your own key to enable AI features like auto-tagging. Your key is encrypted with the system keychain and stored locally.
            Image data goes directly from your machine to OpenAI — never through anyone else.
          </p>

          <label className={styles.fieldLabel} htmlFor="openai-key-input">
            API Key
          </label>
          <input
            id="openai-key-input"
            ref={inputRef}
            className={styles.input}
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasKey ? '••••••••••••••••••••••••' : 'sk-...'}
            autoComplete="off"
            spellCheck={false}
          />

          <div className={styles.statusRow}>
            {status === STATUS_IDLE && hasKey && (
              <span className={`${styles.status} ${styles.statusOk}`}>
                <span className={styles.dot} aria-hidden="true" />
                Connected
              </span>
            )}
            {status === STATUS_IDLE && !hasKey && (
              <span className={`${styles.status} ${styles.statusMuted}`}>
                Not configured
              </span>
            )}
            {status === STATUS_TESTING && (
              <span className={`${styles.status} ${styles.statusMuted}`}>
                Testing…
              </span>
            )}
            {status === STATUS_OK && (
              <span className={`${styles.status} ${styles.statusOk}`}>
                <span className={styles.dot} aria-hidden="true" />
                Connected
              </span>
            )}
            {status === STATUS_ERROR && (
              <span className={`${styles.status} ${styles.statusError}`}>
                {errorMessage}
              </span>
            )}
          </div>

          <div className={styles.actions}>
            {hasKey && (
              <button
                type="button"
                className={styles.btn}
                onClick={handleTest}
                disabled={status === STATUS_TESTING}
              >
                Test connection
              </button>
            )}
            {hasKey && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleClear}
              >
                Forget key
              </button>
            )}
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleSave}
              disabled={!draft.trim() || status === STATUS_TESTING}
            >
              {hasKey ? 'Replace key' : 'Save key'}
            </button>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

function reasonToMessage(reason) {
  switch (reason) {
    case 'no-key': return 'No key configured';
    case 'invalid': return 'Key was rejected by OpenAI (401)';
    case 'invalid-format': return 'Key should start with sk-';
    case 'no-encryption': return 'OS keychain encryption unavailable on this system';
    case 'network': return 'Network error reaching OpenAI';
    case 'write-failed': return 'Could not save the encrypted key to disk';
    case 'test-failed': return 'Key test failed';
    default:
      if (typeof reason === 'string' && reason.startsWith('http-')) {
        return `OpenAI returned ${reason.replace('http-', 'HTTP ')}`;
      }
      return 'Something went wrong';
  }
}
