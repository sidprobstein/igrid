// igrid capture. Adds "Save to igrid" to the right-click menu on images, with
// one entry per board. The image is fetched here, in the browser, so it comes
// with the user's own session and works on sites that refuse outside requests.

const BASE = 'http://localhost:4747';
let building = Promise.resolve();

const rebuild = () => (building = building.then(build, build));

async function build() {
  let boards = null;
  try { boards = await (await fetch(BASE + '/api/boards')).json(); } catch {}
  await chrome.contextMenus.removeAll();
  const add = (o) => chrome.contextMenus.create(o, () => void chrome.runtime.lastError);
  if (!boards) {
    add({ id: 'offline', title: 'igrid is not running (click to retry)', contexts: ['image'] });
    return;
  }
  add({ id: 'root', title: 'Save to igrid', contexts: ['image'] });
  boards.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  for (const b of boards) add({ id: 'b:' + b.id, parentId: 'root', title: b.name.replace(/&/g, '&&'), contexts: ['image'] });
  if (boards.length) add({ id: 'sep', parentId: 'root', type: 'separator', contexts: ['image'] });
  add({ id: 'new', parentId: 'root', title: 'New board…', contexts: ['image'] });
  add({ id: 'open', parentId: 'root', title: 'Open igrid', contexts: ['image'] });
}

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('boards', { periodInMinutes: 1 }); rebuild(); });
chrome.runtime.onStartup.addListener(rebuild);
chrome.alarms.onAlarm.addListener(rebuild);
chrome.runtime.onMessage.addListener((m) => { if (m && m.igrid === 'refresh') rebuild(); });
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: BASE }));

function note(tab, text, ok = true) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#c0392b' });
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
  if (!tab || tab.id == null) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [text, ok],
    func: (text, ok) => {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = `position:fixed;z-index:2147483647;right:18px;bottom:18px;padding:10px 14px;border-radius:10px;
        font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;background:${ok ? '#1c1c1a' : '#c0392b'};
        box-shadow:0 6px 24px rgba(0,0,0,.3);transition:opacity .3s`;
      document.documentElement.append(el);
      setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 1800);
    },
  }).catch(() => {});
}

// Images held in page memory (blob:) can only be read from inside the page.
async function readInPage(tabId, src) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, args: [src],
    func: async (src) => {
      const blob = await (await fetch(src)).blob();
      return await new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(blob); });
    },
  });
  return await (await fetch(r.result)).blob();
}

async function save(boardId, boardName, info, tab) {
  const src = info.srcUrl;
  const page = info.pageUrl && info.pageUrl !== src ? info.pageUrl : (info.linkUrl || src);
  const meta = new URLSearchParams();
  if (/^https?:/.test(src)) meta.set('image_url', src);
  if (/^https?:/.test(page)) meta.set('source', page);
  if (tab && tab.title && page !== src) meta.set('title', tab.title);

  let blob = null;
  try {
    if (src.startsWith('blob:')) blob = await readInPage(tab.id, src);
    else { const r = await fetch(src, { credentials: 'include' }); if (r.ok) blob = await r.blob(); }
  } catch {}

  let res;
  if (blob && blob.size) {
    res = await fetch(`${BASE}/api/boards/${boardId}/items?${meta}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  } else {
    // Could not read it here: let igrid fetch it by address.
    res = await fetch(`${BASE}/api/boards/${boardId}/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: src, source: meta.get('source') || undefined, title: meta.get('title') || undefined }),
    });
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'igrid could not save that image');
  const saved = await res.json().catch(() => ({}));
  note(tab, (saved.duplicate ? 'Already on ' : 'Saved to ') + boardName);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  try {
    if (id === 'offline') return rebuild();
    if (id === 'open') return chrome.tabs.create({ url: BASE });
    if (id === 'new') {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => prompt('Name the new igrid board') });
      const name = r && r.result && r.result.trim();
      if (!name) return;
      const made = await fetch(BASE + '/api/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!made.ok) throw new Error('Could not create the board');
      const board = await made.json();
      await save(board.id, board.name, info, tab);
      return rebuild();
    }
    if (id.startsWith('b:')) {
      const boards = await (await fetch(BASE + '/api/boards')).json();
      const board = boards.find((b) => b.id === +id.slice(2));
      if (!board) { rebuild(); throw new Error('That board is no longer available'); }
      await save(board.id, board.name, info, tab);
      rebuild();
    }
  } catch (e) {
    note(tab, e.message === 'Failed to fetch' ? 'igrid is not running' : e.message, false);
    rebuild();
  }
});
