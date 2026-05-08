import React from 'react';
import { createRoot } from 'react-dom/client';
import AppGate from './AppGate.jsx';
// Geist variable fonts — bundled locally via @fontsource-variable
// so the app works fully offline. Loaded before our own styles so
// the @font-face declarations are registered before anything tries
// to use --font-ui / --font-mono.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/variables.css';
import './styles/global.css';

// Apply the persisted theme before the first paint. The value is
// pulled synchronously in the preload via ipcRenderer.sendSync, so
// the right palette is in place before any React markup mounts.
const initialTheme = window.moodmark?.app?.theme === 'dark' ? 'dark' : 'light';
document.documentElement.setAttribute('data-theme', initialTheme);

const container = document.getElementById('root');
createRoot(container).render(
  <React.StrictMode>
    <AppGate />
  </React.StrictMode>,
);
