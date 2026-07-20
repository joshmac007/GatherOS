// Isolated-world content script for cosmos.so.
//
// Relays the saved-element batches the MAIN-world interceptor
// (cosmos-interceptor.js) pulls out of Cosmos's network responses up to the
// background service worker, which owns the "seen" baseline and routes new
// elements through the desktop /save pipeline — mirroring the Instagram
// watcher.
//
// v1 is interceptor-only: no real-time "save" click capture. The
// interceptor already sees newly-saved elements when Cosmos refetches your
// saves, which is enough to sync them.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'gatheros-cosmos-interceptor') return;
  if (data.type === 'saved-batch' && Array.isArray(data.elements)) {
    chrome.runtime.sendMessage({ type: 'gatheros:cosmos-saved-batch', elements: data.elements });
  }
});
