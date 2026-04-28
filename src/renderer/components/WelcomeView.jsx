import React from 'react';
import styles from './WelcomeView.module.css';

function DownIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 6 V22" />
      <path d="M9 15 L16 22 L23 15" />
      <path d="M6 26 H26" />
    </svg>
  );
}

export default function WelcomeView({ dragging, onSkip }) {
  return (
    <div className={styles.welcome} role="region" aria-label="Welcome">
      <div className={styles.hero} aria-hidden="true">
        <div className={styles.heroCard} />
        <div className={styles.heroCard} />
        <div className={styles.heroCard} />
        <div className={styles.heroCard} />
        <div className={styles.heroCard} />
      </div>

      <div className={styles.copy}>
        <h1 className={styles.headline}>Welcome to Moodmark.</h1>
        <p className={styles.subhead}>
          Your visual library — every screenshot, font, color, and reference, in one place.
        </p>
      </div>

      <div className={[styles.dropzone, dragging && styles.dragOver].filter(Boolean).join(' ')}>
        <span className={styles.dropIcon}><DownIcon /></span>
        <span className={styles.dropTitle}>Drag your first image here</span>
        <span className={styles.dropSub}>From your desktop, a browser tab, anywhere</span>
      </div>

      <div className={styles.hints}>
        <span className={styles.chip}>
          <span className={styles.chipKey}>⌘</span><span className={styles.chipKey}>V</span>
          paste an image
        </span>
        <span className={styles.chip}>
          <span className={styles.chipKey}>⌘</span><span className={styles.chipKey}>K</span>
          jump anywhere
        </span>
        <span className={styles.chip}>
          right-click to capture a region
        </span>
      </div>

      <button type="button" className={styles.skip} onClick={onSkip}>
        Skip →
      </button>
    </div>
  );
}
