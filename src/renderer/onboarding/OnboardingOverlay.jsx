import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOnboarding } from './OnboardingContext.jsx';
import styles from './OnboardingOverlay.module.css';

// Visual padding around the spotlight ring, in CSS px.
const PAD = 6;

export default function OnboardingOverlay() {
  const {
    active, step, stepIndex, totalSteps, advance, exit,
  } = useOnboarding();
  const [targetRect, setTargetRect] = useState(null);

  // Resolve + watch the target's bbox. If the target isn't in the
  // DOM yet (e.g. we're waiting for a route transition to finish),
  // poll for up to ~1s before giving up and centering the tooltip.
  useLayoutEffect(() => {
    if (!active || !step?.target) {
      setTargetRect(null);
      return undefined;
    }
    let cancelled = false;
    let raf = 0;
    let tries = 0;
    const measure = () => {
      const el = document.querySelector(step.target);
      if (!el) {
        if (tries++ < 60 && !cancelled) raf = requestAnimationFrame(measure);
        else if (!cancelled) setTargetRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setTargetRect({
        x: r.left, y: r.top, width: r.width, height: r.height,
      });
    };
    measure();
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    const ro = new ResizeObserver(measure);
    if (document.body) ro.observe(document.body);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      ro.disconnect();
    };
  }, [active, step?.id, step?.target]);

  // Click gating: while active, swallow every mouse interaction
  // unless it lands on (a) the overlay's own tooltip or (b) the
  // currently-required target. Capture phase so we beat any
  // synthetic-event delegation in React.
  useEffect(() => {
    if (!active) return undefined;
    const wantsClick = step?.advance?.type === 'click';
    const targetSel = step?.target;
    const handler = (e) => {
      // Programmatic clicks the overlay dispatches itself (onEnter
      // navigation, clickBefore actions) carry isTrusted=false.
      // Let those through unconditionally so the walkthrough can
      // drive the app even on steps with no spotlight target.
      if (e.isTrusted === false) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      // Overlay UI always passes through.
      if (t.closest(`.${styles.tooltip}`)) return;
      // Required target — allow the original click, advance after
      // any handlers it triggers have a chance to settle.
      if (targetSel && t.closest(targetSel)) {
        if (wantsClick) queueMicrotask(advance);
        return;
      }
      e.stopPropagation();
      e.preventDefault();
    };
    document.addEventListener('mousedown', handler, true);
    document.addEventListener('click', handler, true);
    document.addEventListener('contextmenu', handler, true);
    return () => {
      document.removeEventListener('mousedown', handler, true);
      document.removeEventListener('click', handler, true);
      document.removeEventListener('contextmenu', handler, true);
    };
  }, [active, step?.target, step?.advance?.type, advance]);

  // Steps can declare a `dimSiblings` selector to fade every
  // matching element EXCEPT the target — pulls the eye to the
  // target without drawing a stroke around it. Inline-style
  // mutation so we don't have to ship CSS rules that know about
  // app-specific selectors; cleanup restores the original opacity.
  useEffect(() => {
    if (!active) return undefined;
    const dimSel = step?.dimSiblings;
    if (!dimSel) return undefined;
    const targetSel = step?.target;
    const targetEl = targetSel ? document.querySelector(targetSel) : null;
    const dimmed = [];
    document.querySelectorAll(dimSel).forEach((el) => {
      // Skip the target itself and any ancestor/descendant of it
      // (the target's own card might be matched by the same
      // selector — we don't want to dim it).
      if (targetEl && (el === targetEl
        || el.contains(targetEl) || targetEl.contains(el))) return;
      dimmed.push({
        el,
        prevOpacity: el.style.opacity,
        prevTransition: el.style.transition,
      });
      el.style.transition = 'opacity 200ms ease';
      el.style.opacity = '0.25';
    });
    return () => {
      dimmed.forEach(({ el, prevOpacity, prevTransition }) => {
        el.style.opacity = prevOpacity;
        el.style.transition = prevTransition;
      });
    };
  }, [active, step?.id, step?.dimSiblings, step?.target, targetRect]);

  // Steps can declare an `onEnter` selector that the overlay
  // clicks for the user — used to auto-switch to the Collections /
  // Spaces tab without making them tap an extra Next. Deferred to
  // the next frame so any clickBefore from the previous step has
  // already settled.
  useEffect(() => {
    if (!active) return undefined;
    const sel = step?.onEnter;
    if (!sel) return undefined;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(sel);
      if (el && typeof el.click === 'function') el.click();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, step?.id, step?.onEnter]);

  // Listen for the theme attribute flipping when a step is waiting
  // on the dark-mode toggle.
  useEffect(() => {
    if (!active) return undefined;
    if (step?.advance?.type !== 'theme') return undefined;
    const expected = step.advance.value;
    const check = () => {
      if (document.documentElement.getAttribute('data-theme') === expected) {
        advance();
      }
    };
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => mo.disconnect();
  }, [active, step?.advance?.type, step?.advance?.value, advance]);

  // Watch for a step that advances when a selector appears in the
  // DOM — used by 'pick-image' to wait until the detail panel
  // actually mounts, regardless of how the user opened it
  // (double-click, keyboard, etc).
  useEffect(() => {
    if (!active) return undefined;
    if (step?.advance?.type !== 'appears') return undefined;
    const sel = step.advance.selector;
    if (!sel) return undefined;
    if (document.querySelector(sel)) { advance(); return undefined; }
    const mo = new MutationObserver(() => {
      if (document.querySelector(sel)) advance();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [active, step?.advance?.type, step?.advance?.selector, advance]);

  if (!active || !step) return null;

  return createPortal(
    <div className={styles.overlay} aria-live="polite">
      {/* Focus ring around the target. Suppressed when the step
          uses dimSiblings — that step pulls the eye via opacity
          contrast and explicitly doesn't want a stroke. */}
      {targetRect && !step.dimSiblings && (
        <div
          className={styles.spotlight}
          style={{
            left: targetRect.x - PAD,
            top: targetRect.y - PAD,
            width: targetRect.width + PAD * 2,
            height: targetRect.height + PAD * 2,
          }}
        />
      )}
      <div className={styles.tooltip}>
        <div className={styles.tooltipHeader}>
          <span className={styles.stepCount}>
            Step {stepIndex + 1} of {totalSteps}
          </span>
          <button
            type="button"
            className={styles.exitBtn}
            onClick={exit}
            aria-label="Exit walkthrough"
          >
            Exit
          </button>
        </div>
        {step.title && <div className={styles.title}>{step.title}</div>}
        {step.body && <div className={styles.body}>{step.body}</div>}
        {step.advance?.type === 'next' && (
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => {
              // Some steps need to nudge the app state before
              // advancing (e.g. closing the detail panel so step 4
              // can spotlight the Collections tab in the library
              // view). The selector is dispatched a click before
              // the index moves forward.
              const sel = step.advance?.clickBefore;
              if (sel) {
                const el = document.querySelector(sel);
                if (el && typeof el.click === 'function') el.click();
              }
              advance();
            }}
          >
            {step.advance.label || 'Next'}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
