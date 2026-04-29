import React from 'react';

// Small icon set used by the What's New modal. Lives next to the
// release-notes data so each release block can pull whichever fits.

export function GlassIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 6.5h6M5 9.5h4" />
    </svg>
  );
}

export function WindowIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6h12" />
      <circle cx="4.25" cy="4.5" r="0.4" fill="currentColor" />
      <circle cx="5.75" cy="4.5" r="0.4" fill="currentColor" />
    </svg>
  );
}

export function CardsIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="2.5" width="10" height="7" rx="1.2" transform="rotate(-4 8 6)" />
      <rect x="3" y="6.5" width="10" height="7" rx="1.2" transform="rotate(4 8 10)" />
    </svg>
  );
}

export function AcknowledgmentIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 14s-5-3-5-7.5A3 3 0 0 1 8 4a3 3 0 0 1 5 2.5C13 11 8 14 8 14z" />
    </svg>
  );
}

export function PermissionIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="6.4" width="10" height="7" rx="1.2" />
      <path d="M5.2 6.4V4.5a2.8 2.8 0 0 1 5.6 0v1.9" />
    </svg>
  );
}
