// Runs only on the igrid page: tells the page the extension is present, and
// tells the extension when the list of boards changes.
document.documentElement.dataset.igridExt = chrome.runtime.getManifest().version;
window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.igrid === 'boards-changed') chrome.runtime.sendMessage({ igrid: 'refresh' }).catch(() => {});
});
