import React from 'react';
import { Sun, Moon } from 'lucide-react';

// Local-state theme toggle. Reads the current value off the
// data-theme attribute set on <html> at boot, flips it, mirrors
// the new value to localStorage via setPref AND to the main
// process via setTheme so the next BrowserWindow that opens picks
// the right material variant.
//
// The icon-only button is styled by the consumer via `className`
// — same component used by the Sidebar footer (until Stage 4d)
// and by the Toolbar's right cluster.
export default function ThemeToggle({ className }) {
  const [theme, setTheme] = React.useState(() =>
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark'
      : 'light',
  );
  function persist(next) {
    try {
      window.moodmark?.settings?.setPref?.('theme', next);
      window.moodmark?.app?.setTheme?.(next);
    } catch {
      /* best-effort — UI already reflects the swap */
    }
  }

  function applyTheme(next) {
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
  }

  // Glimm-style switch: the new theme is revealed by a circle expanding
  // from the toggle, via the View Transitions API. Falls back to an
  // instant swap when the API is unavailable or motion is reduced.
  function flip(e) {
    const next = theme === 'dark' ? 'light' : 'dark';
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (typeof document === 'undefined' || !document.startViewTransition || reduce) {
      applyTheme(next);
      persist(next);
      return;
    }

    // Circle emanates from the toggle's center, out to the farthest corner.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const root = document.documentElement;
    root.classList.add('theme-transition');
    const transition = document.startViewTransition(() => applyTheme(next));
    transition.ready
      .then(() => {
        root.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 460,
            easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
            pseudoElement: '::view-transition-new(root)',
          },
        );
      })
      .catch(() => {});
    transition.finished.finally(() => root.classList.remove('theme-transition'));
    persist(next);
  }
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className={className}
      onClick={flip}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark
        ? <Sun strokeWidth={1.6} aria-hidden="true" />
        : <Moon strokeWidth={1.6} aria-hidden="true" />}
    </button>
  );
}
