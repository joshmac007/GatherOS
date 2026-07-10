import React from 'react';
import styles from './VideoTagSuggestions.module.css';

function parseEvidence(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function evidenceLabel(value) {
  const evidence = new Set(parseEvidence(value).map((item) => String(item).toLowerCase()));
  if (evidence.has('poster')) return 'Poster frame';
  if (evidence.has('visual') && evidence.has('post_context')) return 'Visual + post context';
  if (evidence.has('visual')) return 'Visual';
  if (evidence.has('post_context')) return 'Post context';
  return null;
}

export function deriveVideoSuggestionView(snapshot) {
  const analysis = snapshot?.analysis || null;
  const state = String(analysis?.state || '').toLowerCase();
  const suggestions = (Array.isArray(snapshot?.suggestions) ? snapshot.suggestions : [])
    .filter((suggestion) => suggestion?.state === 'suggested')
    .map((suggestion) => ({
      id: suggestion.id,
      name: suggestion.name,
      evidenceLabel: evidenceLabel(suggestion.evidence),
    }))
    .filter((suggestion) => suggestion.id && suggestion.name);

  if (['pending', 'queued', 'running'].includes(state)) {
    return { mode: 'analyzing', statusText: 'Analyzing video…', suggestions };
  }
  if (state === 'failed') {
    return {
      mode: 'failed',
      statusText: analysis?.error || 'Video analysis could not finish',
      suggestions: [],
    };
  }
  if (suggestions.length > 0) return { mode: 'suggestions', statusText: null, suggestions };
  return { mode: 'empty', statusText: null, suggestions: [] };
}

export default function VideoTagSuggestions({ saveId, onAccepted }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);

  const refresh = React.useCallback(async () => {
    const api = window.moodmark?.videoAnalysis;
    if (!saveId || typeof api?.getForSave !== 'function') {
      setSnapshot(null);
      return;
    }
    try {
      setSnapshot(await api.getForSave(saveId));
      setError(null);
    } catch (nextError) {
      setError(nextError?.message || 'Could not load video suggestions');
    }
  }, [saveId]);

  React.useEffect(() => {
    let active = true;
    const load = async () => { if (active) await refresh(); };
    load();
    let unsubscribe = null;
    try {
      unsubscribe = window.moodmark?.on?.('video-analysis:updated', (payload) => {
        if (active && payload?.saveId === saveId) load();
      });
    } catch {}
    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [refresh, saveId]);

  async function act(name, callback, accepted = false) {
    if (busy) return;
    setBusy(name);
    setError(null);
    try {
      const result = await callback();
      if (result?.ok === false) {
        setError(result.detail || result.reason || 'Video suggestion action failed');
        return;
      }
      await refresh();
      if (accepted) onAccepted?.();
    } catch (nextError) {
      setError(nextError?.message || 'Video suggestion action failed');
    } finally {
      setBusy(null);
    }
  }

  const api = window.moodmark?.videoAnalysis;
  const view = deriveVideoSuggestionView(snapshot);
  if (view.mode === 'empty' && !error) return null;

  if (view.mode === 'analyzing') {
    return <p className={styles.status}>{view.statusText}</p>;
  }

  if (view.mode === 'failed') {
    return <p className={`${styles.status} ${styles.statusError}`}>{view.statusText}</p>;
  }

  return (
    <section className={styles.root} aria-label="AI tag suggestions">
      <div className={styles.header}>
        <span>AI suggestions</span>
        <div className={styles.bulkActions}>
          <button
            type="button"
            onClick={() => act('accept-all', () => api.acceptAll(saveId), true)}
            disabled={!!busy || typeof api?.acceptAll !== 'function'}
          >
            Accept all
          </button>
          <button
            type="button"
            onClick={() => act('dismiss-all', () => api.dismissAll(saveId))}
            disabled={!!busy || typeof api?.dismissAll !== 'function'}
          >
            Dismiss all
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {view.suggestions.map((suggestion) => (
          <div key={suggestion.id} className={styles.suggestion}>
            <div className={styles.suggestionCopy}>
              <strong>{suggestion.name}</strong>
              {suggestion.evidenceLabel && <span>{suggestion.evidenceLabel}</span>}
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.accept}
                aria-label={`Accept ${suggestion.name}`}
                onClick={() => act(
                  suggestion.id,
                  () => api.accept(suggestion.id),
                  true,
                )}
                disabled={!!busy || typeof api?.accept !== 'function'}
              >
                Accept
              </button>
              <button
                type="button"
                aria-label={`Dismiss ${suggestion.name}`}
                onClick={() => act(suggestion.id, () => api.dismiss(suggestion.id))}
                disabled={!!busy || typeof api?.dismiss !== 'function'}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}

