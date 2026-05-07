import React from 'react';
import { createRoot } from 'react-dom/client';
import AppGate from './AppGate.jsx';
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
