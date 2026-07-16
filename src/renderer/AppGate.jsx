import React from 'react';
import App from './App.jsx';
import DbIntegrityBanner from './components/DbIntegrityBanner.jsx';

// GatherLocal is a local-first app. It has no account, subscription, trial,
// or remote entitlement state. This shell keeps only local integrity recovery.
export default function AppGate() {
  return (
    <>
      <App />
      <DbIntegrityBanner
        onOpenBackups={() => {
          window.dispatchEvent(
            new CustomEvent('moodmark:open-settings', { detail: { drawer: 'data' } }),
          );
        }}
      />
    </>
  );
}
