// igrid front end. No framework, no build step.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(path, { method = 'GET', json, body, type } = {}) {
  const opts = { method };
  if (json !== undefined) { opts.body = JSON.stringify(json); opts.headers = { 'Content-Type': 'application/json' }; }
  else if (body) { opts.body = body; opts.headers = { 'Content-Type': type || 'application/octet-stream' }; }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

const S = {
  view: 'home',        // home | archived | board
  boards: [], board: null, items: [],
  q: '', tags: new Set(), results: null,
  pending: 0, busy: 0, hover: null,
};

const bar = $('#bar'), main = $('#main'), tagbar = $('#tagbar');

// ---------------------------------------------------------------------------
// Fitting. This is the heart of igrid: given one image and the tile shape,
// choose the presentation that loses the least.
// ---------------------------------------------------------------------------
const SHAPES = [
  ['auto', 'Auto shape'], ['1', 'Square'], ['0.8', 'Portrait 4:5'], ['0.75', 'Portrait 3:4'], ['0.6667', 'Tall 2:3'],
  ['0.5625', 'Tall 9:16'], ['1.3333', 'Landscape 4:3'], ['1.5', 'Landscape 3:2'], ['1.7778', 'Wide 16:9'],
];
const SNAP = SHAPES.slice(1).map(([v]) => +v);
const FITS = [['smart', 'Smart fit'], ['fill', 'Fill tiles'], ['fit', 'Show whole image']];

// Auto shape: boards hold similar pictures, so the typical picture's shape is
// the right tile shape. Median aspect, snapped to a familiar ratio.
function autoAspect(items) {
  if (!items.length) return 1;
  const a = items.map((i) => i.w / i.h).sort((x, y) => x - y);
  const med = a[Math.floor(a.length / 2)];
  return SNAP.reduce((best, s) => (Math.abs(Math.log(s / med)) < Math.abs(Math.log(best / med)) ? s : best), 1);
}

function fitTile(el, item, T, fit) {
  const a = item.w / item.h, m = item.meta || {}, e = m.edges || {};
  const img = $('img.pic', el);
  const wide = a > T;                                   // bars would sit above and below
  const sides = wide ? [e.t, e.b] : [e.l, e.r];         // the two sides a bar would touch
  const extendable = m.bg === 'alpha' || (sides[0] && sides[1]);
  const lost = 1 - Math.min(a / T, T / a);              // share of the picture a crop removes

  let mode;
  if (fit === 'fill') mode = 'cover';
  else if (fit === 'fit') mode = extendable ? 'flat' : 'blur';
  else if (m.bg === 'alpha' || m.trimmed) mode = 'flat';          // cut-outs and product shots: never crop
  else if (lost < 0.06) mode = 'cover';                            // near-perfect match
  else if (extendable) mode = 'flat';                              // backdrop continues invisibly
  else if (lost <= 0.34) mode = 'cover';                           // a photo that crops well
  else mode = 'blur';                                              // too far off: show all of it

  el.classList.remove('flat', 'blur', 'padded');
  el.style.background = '';
  img.style.objectPosition = '';
  if (mode === 'cover') {
    // Slide the crop window so the focal point sits as near centre as it can.
    const [fx, fy] = m.focal || [0.5, 0.5];
    const span = wide ? a / T : T / a, f = wide ? fx : fy;
    const pos = span > 1.001 ? (Math.max(0, Math.min(span - 1, f * span - 0.5)) / (span - 1)) * 100 : 50;
    img.style.objectPosition = wide ? `${pos.toFixed(1)}% 50%` : `50% ${pos.toFixed(1)}%`;
    el.style.background = m.dom || '';
  } else if (mode === 'flat') {
    el.classList.add('flat');
    if (m.bg === 'alpha') { el.style.background = 'var(--alpha-bg)'; el.classList.add('padded'); }
    else {
      const [c1, c2] = [sides[0] || m.bg, sides[1] || m.bg];
      el.style.background = c1 === c2 ? c1 : `linear-gradient(${wide ? 'to bottom' : 'to right'}, ${c1} 50%, ${c2} 50%)`;
      if (m.trimmed) el.classList.add('padded');
    }
  } else {
    el.classList.add('blur');
    $('.backdrop', el).style.backgroundImage = `url(${m.lqip})`;
  }
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------
function toast(msg, { action, onAction, sticky } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span></span>${action ? `<button>${esc(action)}</button>` : ''}`;
  el.firstChild.textContent = msg;
  $('#toasts').append(el);
  let timer = sticky ? null : setTimeout(() => el.remove(), action ? 7000 : 3200);
  if (action) $('button', el).onclick = () => { el.remove(); onAction(); };
  return {
    update: (t) => { el.firstChild.textContent = t; },
    close: (t, ms = 3500) => { if (t) el.firstChild.textContent = t; clearTimeout(timer); setTimeout(() => el.remove(), t ? ms : 0); },
  };
}
const oops = (e) => toast(e.message || String(e));

function ask({ title, html = '', placeholder = '', value = '', cta = 'OK', input = true }) {
  const d = $('#ask');
  d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${html}
    ${input ? `<input class="field" name="v" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}">` : ''}
    <div class="row"><button class="btn" value="cancel" formnovalidate>${input ? 'Cancel' : 'Close'}</button>
    ${input ? `<button class="btn primary" value="ok">${esc(cta)}</button>` : ''}</div></form>`;
  return new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue === 'ok' ? d.querySelector('[name=v]').value.trim() || null : null);
    d.returnValue = '';
    d.showModal();
    if (input) { const f = d.querySelector('[name=v]'); f.focus(); f.select(); }
  });
}

const themeNow = () => localStorage.getItem('igrid-theme') || 'auto';
const themeIcon = () => ({ auto: '◐', light: '☀', dark: '☾' }[themeNow()]);
function cycleTheme() {
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[themeNow()];
  if (next === 'auto') { localStorage.removeItem('igrid-theme'); delete document.documentElement.dataset.theme; }
  else { localStorage.setItem('igrid-theme', next); document.documentElement.dataset.theme = next; }
  $('#theme').textContent = themeIcon();
  $('#theme').title = `Theme: ${next}`;
}
const tellExtension = () => window.postMessage({ igrid: 'boards-changed' }, location.origin);

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
async function go() {
  const h = location.hash.replace(/^#\/?/, '');
  S.q = ''; S.tags.clear(); S.results = null; S.hover = null; tagbar.innerHTML = ''; tiles.clear();
  const m = h.match(/^b\/(\d+)$/);
  try {
    if (m) { S.view = 'board'; await loadBoard(+m[1]); renderBoardBar(); renderGrid(); }
    else { S.view = h === 'archived' ? 'archived' : 'home'; S.board = null; S.boards = await api('/api/boards' + (S.view === 'archived' ? '?archived=1' : '')); renderHomeBar(); renderHome(); }
  } catch (e) { location.hash = '#/'; oops(e); }
  document.title = S.board ? `${S.board.name} · igrid` : 'igrid';
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', go);

async function loadBoard(id) {
  const b = await api('/api/boards/' + id);
  S.items = b.items; delete b.items;
  S.board = b;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
const logo = `<a class="logo" href="#/"><img src="/icon.svg" alt="">igrid</a>`;
const themeBtn = () => `<button class="btn quiet" id="theme" title="Theme: ${themeNow()}">${themeIcon()}</button>`;

function renderHomeBar() {
  bar.innerHTML = `${logo}<span class="spacer"></span>
    <input class="search" id="search" type="search" placeholder="Search all boards" value="${esc(S.q)}">
    <button class="btn" id="pin">Import from Pinterest</button>
    <button class="btn primary" id="newboard">New board</button>${themeBtn()}`;
  $('#search').oninput = debounce(async (e) => {
    S.q = e.target.value.trim();
    S.results = S.q ? await api('/api/search?q=' + encodeURIComponent(S.q)) : null;
    renderHome();
  }, 180);
  $('#pin').onclick = () => importPinterest(null);
  $('#newboard').onclick = newBoard;
  $('#theme').onclick = cycleTheme;
}

function renderHome() {
  if (S.results) {
    main.innerHTML = `<p class="resulthead">${S.results.length} ${S.results.length === 1 ? 'image' : 'images'} matching "${esc(S.q)}"</p><div class="grid" style="--size:200px;--ar:1"></div>`;
    const grid = $('.grid', main);
    for (const it of S.results) grid.append(tileEl(it, 1, 'smart', it.board_name));
    return;
  }
  const archived = S.view === 'archived';
  const cards = S.boards.map((b) => `
    <a class="card" href="#/b/${b.id}">
      <div class="mosaic n${b.covers.length}">${b.covers.length ? b.covers.map((c) => `<div style="background-color:${c.dom};background-image:url(/img/${c.file}.webp)"></div>`).join('') : 'Empty'}</div>
      <h3>${esc(b.name)}</h3><p>${b.count} ${b.count === 1 ? 'image' : 'images'}</p>
      <button class="btn cardact" data-archive="${b.id}">${archived ? 'Restore' : 'Archive'}</button>
    </a>`).join('');
  main.innerHTML = `
    <div class="homehead"><h1>${archived ? 'Archived boards' : 'Boards'}</h1>
      <a href="${archived ? '#/' : '#/archived'}">${archived ? 'Back to boards' : 'Archived'}</a></div>
    <div class="boards">${cards}${archived ? '' : `<a class="card new" href="#" id="newcard"><div class="mosaic">+</div><h3>New board</h3><p>&nbsp;</p></a>`}</div>
    ${archived && !S.boards.length ? '<div class="empty"><h2>Nothing archived</h2>Archived boards are kept here, never deleted.</div>' : ''}`;
  const nc = $('#newcard'); if (nc) nc.onclick = (e) => { e.preventDefault(); newBoard(); };
  main.querySelectorAll('[data-archive]').forEach((btn) => btn.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    await api('/api/boards/' + btn.dataset.archive, { method: 'PATCH', json: { archived: !archived } });
    tellExtension(); go();
  });
}

async function newBoard() {
  const name = await ask({ title: 'New board', placeholder: 'Board name', cta: 'Create' });
  if (!name) return;
  const b = await api('/api/boards', { method: 'POST', json: { name } });
  tellExtension();
  location.hash = '#/b/' + b.id;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
const setting = (k, d) => S.board.settings[k] ?? d;
let unsaved = {};
const flushSettings = debounce((id) => { const patch = unsaved; unsaved = {}; api('/api/boards/' + id, { method: 'PATCH', json: { settings: patch } }).catch(oops); }, 300);
const saveSettings = (patch) => { Object.assign(unsaved, patch); flushSettings(S.board.id); };
const filtered = () => !!S.q || S.tags.size > 0;

function visibleItems() {
  if (!filtered()) return S.items;
  const tokens = S.q.toLowerCase().split(/\s+/).filter(Boolean);
  return S.items.filter((i) => {
    if ([...S.tags].some((t) => !i.tags.includes(t))) return false;
    const hay = `${i.name} ${i.tags.join(' ')} ${i.page_title || ''} ${host(i.source_url)}`.toLowerCase();
    return tokens.every((t) => hay.includes(t.replace(/^#/, '')));
  });
}
const currentList = () => (S.view === 'board' ? visibleItems() : S.results || []);

function renderBoardBar() {
  const b = S.board;
  bar.innerHTML = `${logo}<span class="crumb">/</span>
    <input class="title" id="title" value="${esc(b.name)}" spellcheck="false" title="Rename board">
    <span class="count" id="count"></span><span class="spacer"></span>
    <input class="search" id="search" type="search" placeholder="Search names and tags">
    <label class="ctl" title="Tile size">Size <input type="range" id="size" min="50" max="520" step="5" value="${setting('size', 220)}"></label>
    <select id="shape" title="Tile shape">${SHAPES.map(([v, l]) => `<option value="${v}" ${setting('shape', 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="fit" title="How images fill tiles">${FITS.map(([v, l]) => `<option value="${v}" ${setting('fit', 'smart') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="menuwrap"><button class="btn primary" data-menu>Add</button><div class="menu">
      <button id="addurl">Add image by address</button>
      <button id="addfile">Upload from this Mac</button>
      <button id="addpin">Import a Pinterest board here</button><hr>
      <button id="setup">Right-click capture setup</button></div></div>
    <div class="menuwrap"><button class="btn quiet" data-menu title="More">⋯</button><div class="menu">
      ${b.source_url ? `<button id="srcboard">Open original on Pinterest</button>` : ''}
      <button id="archive">${b.archived ? 'Restore board' : 'Archive board'}</button></div></div>${themeBtn()}`;

  $('#title').onchange = async (e) => {
    const name = e.target.value.trim();
    if (!name) { e.target.value = b.name; return; }
    S.board = { ...S.board, ...(await api('/api/boards/' + b.id, { method: 'PATCH', json: { name } })) };
    document.title = `${name} · igrid`; tellExtension();
  };
  $('#title').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  $('#search').oninput = (e) => { S.q = e.target.value.trim(); renderGrid(); };
  $('#size').oninput = (e) => { S.board.settings.size = +e.target.value; $('.grid', main)?.style.setProperty('--size', e.target.value + 'px'); saveSettings({ size: +e.target.value }); };
  $('#shape').onchange = (e) => { S.board.settings.shape = e.target.value; saveSettings({ shape: e.target.value }); renderGrid(); };
  $('#fit').onchange = (e) => { S.board.settings.fit = e.target.value; saveSettings({ fit: e.target.value }); renderGrid(); };
  $('#addurl').onclick = async () => {
    const url = await ask({ title: 'Add image by address', html: '<p>Paste the address of an image, or of a page: igrid uses the page\'s preview image.</p>', placeholder: 'https://', cta: 'Add' });
    if (url) addUrl(url);
  };
  $('#addfile').onclick = () => $('#filepick').click();
  $('#addpin').onclick = () => importPinterest(b.id);
  $('#setup').onclick = showSetup;
  const sb = $('#srcboard'); if (sb) sb.onclick = () => window.open(b.source_url, '_blank', 'noopener');
  $('#archive').onclick = async () => {
    await api('/api/boards/' + b.id, { method: 'PATCH', json: { archived: !b.archived } });
    tellExtension();
    toast(b.archived ? 'Board restored' : 'Board archived. Find it under Archived.');
    location.hash = '#/';
  };
  $('#theme').onclick = cycleTheme;
}

// Tiles are kept and reused across renders, so reordering, deleting or
// filtering never makes the pictures reload or flash.
const tiles = new Map();
function tileEl(item, T, fit, boardName) {
  let el = tiles.get(item.id);
  if (!el) {
    el = document.createElement('div');
    el.dataset.id = item.id;
    el.innerHTML = `<div class="backdrop"></div><img class="pic" loading="lazy" draggable="false" alt="" src="/img/${item.file}.webp"><div class="cap"></div><div class="acts"><button class="top" title="Move to top of board">↑</button><button class="bottom" title="Move to bottom of board">↓</button><button class="info" title="Details (Space)">✎</button><button class="del" title="Delete (Backspace)">✕</button></div>`;
    tiles.set(item.id, el);
  }
  el.className = 'tile';
  el.draggable = S.view === 'board' && !filtered();
  $('.top', el).hidden = S.view !== 'board' || S.items[0]?.id === item.id;
  $('.bottom', el).hidden = S.view !== 'board' || S.items.at(-1)?.id === item.id;
  const sub = [boardName, item.tags.map((t) => '#' + t).join(' ')].filter(Boolean).join('  ');
  $('.cap', el).innerHTML = (item.name ? `<b>${esc(item.name)}</b>` : '') + (sub ? `<span>${esc(sub)}</span>` : '');
  $('img.pic', el).alt = item.name;
  el.title = item.source_url ? 'Open ' + host(item.source_url) : '';
  fitTile(el, item, T, fit);
  return el;
}

function renderGrid() {
  if (S.view !== 'board') return renderHome();
  const list = visibleItems();
  $('#count').textContent = filtered() ? `${list.length} of ${S.items.length}` : `${S.items.length} ${S.items.length === 1 ? 'image' : 'images'}`;
  renderTagbar();

  if (!S.items.length && !S.pending) {
    const ext = document.documentElement.dataset.igridExt;
    main.innerHTML = `<div class="empty"><h2>This board is empty</h2>Add images any way you like:
      <ul><li><b>Right-click</b> any image in Chrome and choose Save to igrid${ext ? '' : ' (one-time setup under Add)'}</li>
      <li><b>Drag</b> an image here from another window</li>
      <li><b>Paste</b> a copied image or image address with <kbd>⌘V</kbd></li>
      <li><b>Import</b> a whole Pinterest board from the Add menu</li></ul></div>`;
    return;
  }
  const shape = setting('shape', 'auto');
  const T = shape === 'auto' ? autoAspect(S.items) : +shape;
  const fit = setting('fit', 'smart');
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.setProperty('--size', setting('size', 220) + 'px');
  grid.style.setProperty('--ar', T);
  for (const it of list) grid.append(tileEl(it, T, fit));
  for (let i = 0; i < S.pending; i++) { const p = document.createElement('div'); p.className = 'tile pending'; grid.append(p); }
  main.replaceChildren(grid);
  if (filtered() && !list.length) main.innerHTML = `<div class="empty"><h2>No matches</h2>Nothing on this board matches that search.</div>`;
}

function renderTagbar() {
  const counts = new Map();
  for (const i of S.items) for (const t of i.tags) counts.set(t, (counts.get(t) || 0) + 1);
  for (const t of S.tags) if (!counts.has(t)) S.tags.delete(t);
  tagbar.innerHTML = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `<span class="chip ${S.tags.has(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)} <small>${n}</small></span>`).join('');
}
tagbar.onclick = (e) => {
  const c = e.target.closest('[data-tag]'); if (!c) return;
  S.tags.has(c.dataset.tag) ? S.tags.delete(c.dataset.tag) : S.tags.add(c.dataset.tag);
  renderGrid();
};

// ---- Tile clicks ----
const findItem = (id) => currentList().find((i) => i.id === +id);
main.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile[data-id]'); if (!tile) return;
  const item = findItem(tile.dataset.id); if (!item) return;
  if (e.target.closest('.del')) return removeItem(item);
  if (e.target.closest('.top')) return moveToEnd(item, true);
  if (e.target.closest('.bottom')) return moveToEnd(item, false);
  if (e.target.closest('.info') || !item.source_url) return openDetail(item.id);
  window.open(item.source_url, '_blank', 'noopener');
});
main.addEventListener('mouseover', (e) => { const t = e.target.closest('.tile[data-id]'); S.hover = t ? +t.dataset.id : null; });

async function saveOrder() {
  S.busy++;
  try { await api(`/api/boards/${S.board.id}/order`, { method: 'PUT', json: { ids: S.items.map((i) => i.id) } }); }
  catch (err) { oops(err); } finally { S.busy--; }
}

async function moveToEnd(item, top) {
  if (S.view !== 'board') return;
  const rest = S.items.filter((i) => i.id !== item.id);
  S.items = top ? [item, ...rest] : [...rest, item];
  renderGrid();
  await saveOrder();
}

async function removeItem(item) {
  try {
    await api('/api/items/' + item.id, { method: 'DELETE' });
    S.items = S.items.filter((i) => i.id !== item.id);
    if (S.results) S.results = S.results.filter((i) => i.id !== item.id);
    S.hover = null;
    renderGrid();
    toast('Image deleted', { action: 'Undo', onAction: async () => {
      await api(`/api/items/${item.id}/restore`, { method: 'POST' });
      if (S.view === 'board' && S.board.id === item.board_id) { await loadBoard(S.board.id); renderGrid(); }
      else if (S.results) { S.results = await api('/api/search?q=' + encodeURIComponent(S.q)); renderHome(); }
    } });
  } catch (e) { oops(e); }
}

// ---- Reordering: the order is the user's, and only the user changes it ----
let drag = null;
const clearMarks = () => main.querySelectorAll('.before,.after').forEach((t) => t.classList.remove('before', 'after'));
main.addEventListener('dragstart', (e) => {
  const tile = e.target.closest?.('.tile[data-id]');
  if (!tile || S.view !== 'board' || filtered()) return;
  drag = { id: +tile.dataset.id, target: null };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-igrid', String(drag.id));
  requestAnimationFrame(() => tile.classList.add('dragging'));
});
main.addEventListener('dragover', (e) => {
  if (!drag) return;
  e.preventDefault();
  const tile = e.target.closest('.tile[data-id]');
  clearMarks();
  if (!tile || +tile.dataset.id === drag.id) { drag.target = null; return; }
  const r = tile.getBoundingClientRect();
  const after = e.clientX > r.left + r.width / 2;
  tile.classList.add(after ? 'after' : 'before');
  drag.target = { id: +tile.dataset.id, after };
});
main.addEventListener('drop', async (e) => {
  if (!drag) return;
  e.preventDefault();
  const { id, target } = drag;
  if (target) {
    const moving = S.items.find((i) => i.id === id);
    const rest = S.items.filter((i) => i.id !== id);
    const at = rest.findIndex((i) => i.id === target.id) + (target.after ? 1 : 0);
    rest.splice(at, 0, moving);
    S.items = rest;
    renderGrid();
    await saveOrder();
  }
});
main.addEventListener('dragend', () => { drag = null; clearMarks(); main.querySelectorAll('.dragging').forEach((t) => t.classList.remove('dragging')); });

// ---------------------------------------------------------------------------
// Adding images
// ---------------------------------------------------------------------------
async function adding(fn) {
  S.pending++; S.busy++; renderGrid();
  try { const item = await fn(); if (item.duplicate) toast('Already on this board'); else S.items.push(item); }
  catch (e) { oops(e); }
  finally { S.pending--; S.busy--; renderGrid(); }
}
const addUrl = (url, source) => adding(() => api(`/api/boards/${S.board.id}/items`, { method: 'POST', json: { url, source } }));
const addFile = (file) => adding(() => api(`/api/boards/${S.board.id}/items`, { method: 'POST', body: file, type: file.type || 'application/octet-stream' }));

$('#filepick').onchange = (e) => { [...e.target.files].forEach(addFile); e.target.value = ''; };

const veil = $('#dropveil');
const external = (e) => S.view === 'board' && !drag && !$('dialog[open]') && [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/uri-list');
window.addEventListener('dragover', (e) => { if (external(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; veil.classList.add('on'); } });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) veil.classList.remove('on'); });
window.addEventListener('drop', (e) => {
  veil.classList.remove('on');
  if (!external(e)) return;
  e.preventDefault();
  const dt = e.dataTransfer;
  const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) return files.forEach(addFile);
  // Dragged from a web page: the markup carries the image, the link carries where it leads.
  const src = new DOMParser().parseFromString(dt.getData('text/html') || '', 'text/html').querySelector('img')?.src;
  const link = (dt.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'))?.trim();
  if (src && /^(https?|data):/.test(src)) addUrl(src, link && link !== src ? link : undefined);
  else if (link) addUrl(link);
});

document.addEventListener('paste', (e) => {
  if (S.view !== 'board' || e.target.closest('input, textarea') || $('dialog[open]')) return;
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); return files.forEach(addFile); }
  const text = e.clipboardData.getData('text/plain').trim();
  if (/^https?:\/\/\S+$/.test(text)) { e.preventDefault(); addUrl(text); }
});

// ---- Pinterest ----
async function importPinterest(boardId) {
  const url = await ask({
    title: 'Import from Pinterest',
    html: `<p>Paste the link to a public Pinterest board. ${boardId ? 'Its images are added to the end of this board' : 'igrid creates a new board with the same name'}, in Pinterest's order, each linked to where it came from.</p>`,
    placeholder: 'https://www.pinterest.com/name/board-name/', cta: 'Import',
  });
  if (!url) return;
  const t = toast('Reading the Pinterest board', { sticky: true });
  try {
    let job = await api('/api/import/pinterest', { method: 'POST', json: { url, boardId } });
    let moved = false;
    while (job.status !== 'done' && job.status !== 'error') {
      await new Promise((r) => setTimeout(r, 900));
      job = await api('/api/jobs/' + job.id);
      if (job.status === 'reading') t.update(`Reading the Pinterest board: ${job.found} found`);
      if (job.status === 'saving') {
        t.update(`Saving ${job.done} of ${job.total} images`);
        if (!moved && job.boardId) { moved = true; tellExtension(); if (S.board?.id !== job.boardId) { location.hash = '#/b/' + job.boardId; } }
        if (S.board?.id === job.boardId && !drag && !$('dialog[open]')) { await loadBoard(job.boardId); renderGrid(); }
      }
    }
    if (job.status === 'error') return t.close(job.error, 7000);
    if (S.board?.id === job.boardId) { await loadBoard(job.boardId); renderGrid(); }
    const saved = job.total - job.failed - (job.dupes || 0);
    const notes = [job.skipped && `${job.skipped} already here`, job.dupes && `${job.dupes} exact duplicates skipped`, job.failed && `${job.failed} could not be fetched`, job.partial && 'Pinterest only shared part of this board'].filter(Boolean);
    t.close(`Imported ${saved} ${saved === 1 ? 'image' : 'images'}${notes.length ? ' (' + notes.join(', ') + ')' : ''}`, 6000);
  } catch (e) { t.close(e.message, 7000); }
}

async function showSetup() {
  const ping = await api('/api/ping');
  const on = document.documentElement.dataset.igridExt;
  ask({
    title: 'Right-click capture', input: false,
    html: on
      ? `<p>The igrid extension is installed (version ${esc(on)}). Right-click any image in Chrome and choose <b>Save to igrid</b>, then a board.</p>
         <p>If a site blocks right-click, open the image in its own tab first, then right-click it there.</p>`
      : `<p>One-time setup in Chrome:</p><ol><li>Open <code>chrome://extensions</code></li><li>Turn on <b>Developer mode</b> (top right)</li>
         <li>Choose <b>Load unpacked</b> and pick this folder:<br><code>${esc(ping.extensionPath)}</code></li><li>Reload this page</li></ol>
         <p>After that, right-click any image and choose <b>Save to igrid</b>.</p>`,
  });
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
const detail = $('#detail');
let detailId = null;

async function patchItem(id, patch) {
  try {
    const item = await api('/api/items/' + id, { method: 'PATCH', json: patch });
    for (const list of [S.items, S.results || []]) { const i = list.findIndex((x) => x.id === id); if (i >= 0) list[i] = { ...list[i], ...item }; }
    return item;
  } catch (e) { oops(e); }
}

async function openDetail(id) {
  const list = currentList();
  const idx = list.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const it = list[idx];
  detailId = id;
  const boards = S.view === 'board' ? await api('/api/boards') : [];
  detail.innerHTML = `
    <div class="stage">
      <img src="/img/${it.file}.orig" alt="">
      <button class="nav prev" ${idx === 0 ? 'disabled' : ''} title="Previous">‹</button>
      <button class="nav next" ${idx === list.length - 1 ? 'disabled' : ''} title="Next">›</button>
    </div>
    <aside>
      <div class="top"><span class="count">${idx + 1} of ${list.length}</span><button class="btn quiet" id="dclose" title="Close (Esc)">✕</button></div>
      <label>Name (optional)<input class="field" id="dname" value="${esc(it.name)}" placeholder="${esc(it.page_title || 'Untitled')}"></label>
      <label>Tags (optional)<div class="tagbox" id="dtags"></div></label>
      <label>Links to<input class="field" id="dsrc" value="${esc(it.source_url || '')}" placeholder="No link saved"></label>
      ${it.source_url ? `<a class="btn open" href="${esc(it.source_url)}" target="_blank" rel="noopener">Open ${esc(host(it.source_url))} ↗</a>` : ''}
      ${boards.length > 1 ? `<label>Board<select id="dboard">${boards.map((b) => `<option value="${b.id}" ${b.id === it.board_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
      <div class="facts">${it.ow} × ${it.oh} px<br>Saved ${new Date(it.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}${it.board_name ? `<br>On ${esc(it.board_name)}` : ''}</div>
      <div class="pushdown"><button class="btn danger" id="ddel">Delete image</button></div>
    </aside>`;
  $('.stage img', detail).onerror = (e) => { e.target.onerror = null; e.target.src = `/img/${it.file}.webp`; };
  $('.prev', detail).onclick = () => openDetail(list[idx - 1].id);
  $('.next', detail).onclick = () => openDetail(list[idx + 1].id);
  $('#dclose').onclick = () => detail.close();
  $('#dname').onchange = (e) => patchItem(id, { name: e.target.value });
  $('#dsrc').onchange = (e) => patchItem(id, { source_url: e.target.value });
  $('#ddel').onclick = () => { detail.close(); removeItem(it); };
  const sel = $('#dboard');
  if (sel) sel.onchange = async () => {
    await patchItem(id, { board_id: +sel.value });
    S.items = S.items.filter((i) => i.id !== id);
    detail.close();
    toast('Moved to ' + sel.selectedOptions[0].textContent);
  };

  let tags = [...it.tags];
  const box = $('#dtags');
  const drawTags = () => {
    box.innerHTML = tags.map((t, i) => `<span class="chip">${esc(t)}<button data-i="${i}" title="Remove">×</button></span>`).join('') + `<input placeholder="${tags.length ? '' : 'Type a tag, press Return'}">`;
    const inp = $('input', box);
    const commit = () => {
      const fresh = inp.value.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter((t) => t && !tags.includes(t));
      if (!fresh.length) { inp.value = ''; return false; }
      tags.push(...fresh); patchItem(id, { tags }); drawTags(); $('input', box).focus(); return true;
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      else if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); patchItem(id, { tags }); drawTags(); $('input', box).focus(); }
    };
    inp.onblur = commit;
  };
  box.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) { e.preventDefault(); tags.splice(+b.dataset.i, 1); patchItem(id, { tags }); drawTags(); }
    else $('input', box).focus();
  };
  drawTags();
  if (!detail.open) detail.showModal();
  $('#dclose').focus();
}
detail.addEventListener('close', () => { detailId = null; renderGrid(); });

// ---------------------------------------------------------------------------
// Keys, menus, background refresh
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select');
  if (detail.open) {
    if (typing) return;
    if (e.key === 'ArrowLeft') $('.prev', detail).click();
    if (e.key === 'ArrowRight') $('.next', detail).click();
    return;
  }
  if (typing || $('dialog[open]')) return;
  if (e.key === '/') { e.preventDefault(); $('#search')?.focus(); return; }
  const item = S.hover && findItem(S.hover);
  if (!item) return;
  if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeItem(item); }
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); openDetail(item.id); }
});

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-menu]');
  document.querySelectorAll('.menu.open').forEach((m) => { if (!trigger || m !== trigger.nextElementSibling) m.classList.remove('open'); });
  if (trigger) trigger.nextElementSibling.classList.toggle('open');
});

// Pick up images saved from other tabs (the right-click menu) without a reload.
async function refresh() {
  if (S.view !== 'board' || document.hidden || S.busy || drag || $('dialog[open]')) return;
  try {
    const id = S.board.id;
    const b = await api('/api/boards/' + id);
    if (S.view !== 'board' || S.board.id !== id || S.busy || drag) return;
    if (b.items.map((i) => i.id).join() !== S.items.map((i) => i.id).join()) { S.items = b.items; renderGrid(); }
  } catch {}
}
setInterval(refresh, 3000);
document.addEventListener('visibilitychange', refresh);
window.addEventListener('focus', refresh);

go();
