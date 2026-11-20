// Pinterest board import. No login and no API key: it reads what Pinterest
// serves to any signed-out visitor of a public board.
//
//   1. The widget endpoint resolves /user/board/ to the board id and name
//      (and gives up to 50 pins, kept as a fallback).
//   2. The board feed endpoint pages through every pin with a bookmark cursor,
//      returning original-resolution images and each pin's outbound link.
//
// Secret boards are not reachable this way.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Pinterest rejects feed requests that lack the handler header its own site sends.
const HEADERS = {
  'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
  'X-Pinterest-PWS-Handler': 'www/[username]/[slug].js',
};

const decode = (s) => (s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .trim();

export async function parseBoardUrl(input) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); }
  catch { throw new Error('That does not look like a Pinterest board link'); }
  if (url.hostname === 'pin.it') {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    url = new URL(r.url);
  }
  if (!/(^|\.)pinterest\.[a-z.]+$/i.test(url.hostname)) throw new Error('That is not a Pinterest link');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || parts[0] === 'pin') throw new Error('Paste the link to a board, like pinterest.com/name/board-name');
  return { user: parts[0], slug: parts[1] };
}

const best = (images) => {
  if (!images) return null;
  if (images.orig?.url) return images.orig.url;
  return Object.values(images).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
};

const toPin = (p) => {
  const image = best(p.images);
  if (!image || !p.id) return null;
  // Pinterest hands out different ids for the same pin depending on the
  // endpoint, so pins are recognised by their image file instead.
  const sig = (image.match(/\/([0-9a-f]{32})\.[a-z]+$/i) || [])[1];
  return {
    extId: sig ? 'pinimg:' + sig : 'pin:' + p.id,
    imageUrl: image,
    name: decode(p.grid_title || p.title || ''),
    sourceUrl: decode(p.link) || `https://www.pinterest.com/pin/${p.id}/`,
  };
};

// One page of the feed, retried: Pinterest drops the odd request.
async function feedPage(url) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('feed ' + r.status);
      return (await r.json()).resource_response || {};
    } catch (e) { last = e; }
  }
  throw last;
}

export async function fetchBoard(input, onProgress = () => {}) {
  const { user, slug } = await parseBoardUrl(input);
  const path = `/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/`;

  const wr = await fetch(`https://widgets.pinterest.com/v3/pidgets/boards${path}pins/`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  const wj = await wr.json().catch(() => null);
  if (!wr.ok || !wj?.data?.board) throw new Error('Pinterest did not return that board. It may be secret, renamed or mistyped.');
  const board = wj.data.board;
  const fallback = (wj.data.pins || []).map(toPin).filter(Boolean);

  const pins = [];
  const seen = new Set();
  let bookmarks = [];
  let feedOk = true;
  try {
    for (let page = 0; page < 400; page++) {
      const data = {
        options: {
          board_id: board.id, board_url: path, field_set_key: 'react_grid_pin',
          filter_section_pins: false, layout: 'default', page_size: 50,
          redux_normalize_feed: true, bookmarks,
        },
        context: {},
      };
      const qs = new URLSearchParams({ source_url: path, data: JSON.stringify(data) });
      const rr = await feedPage('https://www.pinterest.com/resource/BoardFeedResource/get/?' + qs);
      const rows = rr.data || [];
      for (const row of rows) {
        if (row.type && row.type !== 'pin') continue;
        const pin = toPin(row);
        if (pin && !seen.has(pin.extId)) { seen.add(pin.extId); pins.push(pin); }
      }
      onProgress(pins.length, board.pin_count || pins.length);
      const next = rr.bookmark;
      if (!next || String(next).startsWith('-end-') || !rows.length) break;
      bookmarks = [next];
    }
  } catch (e) {
    feedOk = false;
    if (!pins.length && !fallback.length) throw new Error('Pinterest refused the board feed (' + e.message + ')');
  }

  // The widget list is capped at 50, so it is only used when the feed failed.
  // A feed that broke part-way still beats the widget once it has more pins.
  const complete = feedOk && pins.length > 0;
  const useFeed = complete || pins.length > fallback.length;
  return {
    name: decode(board.name) || slug,
    url: 'https://www.pinterest.com' + path,
    pinCount: board.pin_count || null,
    pins: useFeed ? pins : fallback,
    partial: !complete,
  };
}
