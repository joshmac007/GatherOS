import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import styles from './AcknowledgmentsModal.module.css';
import { ACKNOWLEDGMENTS } from '../data/acknowledgments.js';

export default function AcknowledgmentsModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function openExternal(e, url) {
    e.preventDefault();
    window.moodmark.shell.openUrl(url);
  }

  return ReactDOM.createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Open source acknowledgments"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Open source acknowledgments</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.lede}>
            GatherOS is built on top of a stack of generous open source software.
            Thanks to every maintainer and contributor of the projects below.
          </p>

          {ACKNOWLEDGMENTS.map(({ section, items }) => (
            <section key={section} className={styles.section}>
              <div className={styles.sectionTitle}>{section}</div>
              <ul className={styles.list}>
                {items.map((item) => (
                  <li key={item.name} className={styles.row}>
                    <a
                      href={item.url}
                      onClick={(e) => openExternal(e, item.url)}
                      className={styles.name}
                    >
                      {item.name}
                    </a>
                    <span className={styles.license}>{item.license}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className={styles.footnote}>
            Each package retains its original copyright and license text inside
            its own distribution. Transitive dependencies are licensed under
            permissive terms (MIT, ISC, BSD, Apache-2.0).
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
