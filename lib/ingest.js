// Image analysis and derivative generation.
//
// Every image that enters igrid is analysed once, here. The grid then decides
// per tile how to show it (see fitTile in public/app.js) using what we record:
//
//   edges    per-side flat colour (hex) when that side of the image is a
//            uniform backdrop, else null. A flat side can be extended
//            invisibly, so the image never needs cropping on that axis.
//   bg       the single backdrop colour when all four sides agree, or 'alpha'
//            for cut-outs on transparency.
//   trimmed  true when the stored view was cropped to the subject, so that
//            products shot with different margins render at the same scale.
//   focal    [x, y] in 0..1, the centre of visual interest, used to place the
//            crop window when a photo has to be cropped.
//   lqip     a tiny preview used as a blurred backdrop for extreme shapes.

import sharp from 'sharp';

const FORMATS = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', tiff: 'image/tiff', heif: 'image/avif', avif: 'image/avif',
};

const WORK_EDGE = 1600;   // working raster, long edge
const VIEW_EDGE = 1400;   // stored view, long edge
const ANALYSIS_EDGE = 160;
const EDGE_TOLERANCE = 14;      // colour distance for "this side is flat"
const SIDES_AGREE = 28;         // max distance between sides to call it one backdrop
const CONTENT_THRESHOLD = 18;   // distance from backdrop that counts as subject

const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export async function processImage(buf) {
  const base = { failOn: 'none' };
  const md = await sharp(buf, base).metadata();
  if (!md.width || !md.height) throw new Error('That is not an image igrid can read');
  const isSvg = md.format === 'svg';
  const open = () => sharp(buf, isSvg ? { ...base, density: 192 } : base).rotate();

  let ow = md.width, oh = md.height;
  if ((md.orientation || 1) >= 5) [ow, oh] = [oh, ow];

  // Working raster: oriented, sRGB, RGBA, capped. Everything else derives from it.
  const { data: work, info: wi } = await open()
    .resize(WORK_EDGE, WORK_EDGE, { fit: 'inside', withoutEnlargement: !isSvg })
    .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const fromWork = () => sharp(work, { raw: { width: wi.width, height: wi.height, channels: 4 } });

  const { data: A, info: ai } = await fromWork()
    .resize(ANALYSIS_EDGE, ANALYSIS_EDGE, { fit: 'inside', withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const aw = ai.width, ah = ai.height;

  // ---- Side analysis ------------------------------------------------------
  const alphaAt = (x, y) => A[(y * aw + x) * 4 + 3];
  const rgbAt = (x, y) => {           // composited over white
    const i = (y * aw + x) * 4, a = A[i + 3] / 255;
    return [A[i] * a + 255 * (1 - a), A[i + 1] * a + 255 * (1 - a), A[i + 2] * a + 255 * (1 - a)];
  };
  const t = Math.min(aw, ah) >= 16 ? 2 : 1;
  const sideCoords = {
    t: () => { const o = []; for (let y = 0; y < t; y++) for (let x = 0; x < aw; x++) o.push([x, y]); return o; },
    b: () => { const o = []; for (let y = ah - t; y < ah; y++) for (let x = 0; x < aw; x++) o.push([x, y]); return o; },
    l: () => { const o = []; for (let x = 0; x < t; x++) for (let y = 0; y < ah; y++) o.push([x, y]); return o; },
    r: () => { const o = []; for (let x = aw - t; x < aw; x++) for (let y = 0; y < ah; y++) o.push([x, y]); return o; },
  };

  const allEdge = Object.values(sideCoords).flatMap((f) => f());
  const transparentShare = allEdge.filter(([x, y]) => alphaAt(x, y) < 32).length / allEdge.length;
  const alphaMode = md.hasAlpha && transparentShare > 0.6;

  const flatColour = (coords) => {
    const px = coords.map(([x, y]) => rgbAt(x, y));
    const mean = [0, 1, 2].map((k) => px.reduce((s, p) => s + p[k], 0) / px.length);
    const ds = px.map((p) => dist(p, mean)).sort((a, b) => a - b);
    if (ds[Math.floor(ds.length * 0.9)] > EDGE_TOLERANCE) return null;
    const near = px.filter((p) => dist(p, mean) <= EDGE_TOLERANCE);
    return [0, 1, 2].map((k) => near.reduce((s, p) => s + p[k], 0) / near.length);
  };

  let edges = { t: null, r: null, b: null, l: null };
  let bg = null;
  let box = null; // subject bounding box in analysis coordinates

  const boundingBox = (isContent) => {
    const minRow = Math.max(1, Math.round(aw * 0.01)), minCol = Math.max(1, Math.round(ah * 0.01));
    let x0 = aw, x1 = -1, y0 = ah, y1 = -1;
    const colCount = new Uint16Array(aw);
    for (let y = 0; y < ah; y++) {
      let n = 0;
      for (let x = 0; x < aw; x++) if (isContent(x, y)) { n++; colCount[x]++; }
      if (n >= minRow) { if (y < y0) y0 = y; y1 = y; }
    }
    for (let x = 0; x < aw; x++) if (colCount[x] >= minCol) { if (x < x0) x0 = x; x1 = x; }
    if (x1 < 0 || y1 < 0) return null;
    return { x0, y0, x1, y1 };
  };

  if (alphaMode) {
    bg = 'alpha';
    box = boundingBox((x, y) => alphaAt(x, y) > 24);
  } else {
    const c = { t: flatColour(sideCoords.t()), r: flatColour(sideCoords.r()), b: flatColour(sideCoords.b()), l: flatColour(sideCoords.l()) };
    edges = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v && hex(v)]));
    const all = Object.values(c);
    if (all.every(Boolean)) {
      let spread = 0;
      for (const a of all) for (const b of all) spread = Math.max(spread, dist(a, b));
      if (spread < SIDES_AGREE) {
        const mean = [0, 1, 2].map((k) => all.reduce((s, p) => s + p[k], 0) / 4);
        bg = hex(mean);
        const thr = Math.max(CONTENT_THRESHOLD, spread * 0.8 + 8);
        box = boundingBox((x, y) => dist(rgbAt(x, y), mean) > thr);
      }
    }
  }

  // ---- Trim to the subject when there is real margin to remove ------------
  let trimmed = false;
  let region = { x0: 0, y0: 0, x1: aw - 1, y1: ah - 1 };
  let pipeline = fromWork();
  if (box) {
    const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    const hasMargin = bw < aw * 0.94 || bh < ah * 0.94;
    const sane = bw >= aw * 0.08 && bh >= ah * 0.08;
    if (hasMargin && sane) {
      const sx = wi.width / aw, sy = wi.height / ah;
      const left = clamp(Math.floor((box.x0 - 1) * sx), 0, wi.width - 1);
      const top = clamp(Math.floor((box.y0 - 1) * sy), 0, wi.height - 1);
      const right = clamp(Math.ceil((box.x1 + 2) * sx), left + 1, wi.width);
      const bottom = clamp(Math.ceil((box.y1 + 2) * sy), top + 1, wi.height);
      pipeline = pipeline.extract({ left, top, width: right - left, height: bottom - top });
      trimmed = true;
      region = box;
      if (bg !== 'alpha') edges = { t: bg, r: bg, b: bg, l: bg };
    }
  }

  // ---- Focal point: centroid of local contrast, weighted by saturation -----
  const luma = (x, y) => { const p = rgbAt(x, y); return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]; };
  let sw = 0, sxw = 0, syw = 0;
  const rw = region.x1 - region.x0 + 1, rh = region.y1 - region.y0 + 1;
  for (let y = Math.max(1, region.y0); y <= Math.min(ah - 2, region.y1); y++) {
    for (let x = Math.max(1, region.x0); x <= Math.min(aw - 2, region.x1); x++) {
      const p = rgbAt(x, y);
      const sat = (Math.max(...p) - Math.min(...p)) / 255;
      const e = Math.abs(luma(x + 1, y) - luma(x - 1, y)) + Math.abs(luma(x, y + 1) - luma(x, y - 1));
      const w = e * e * (1 + sat);
      sw += w; sxw += w * x; syw += w * y;
    }
  }
  let fx = 0.5, fy = 0.5;
  if (sw > 0) {
    fx = clamp((sxw / sw - region.x0 + 0.5) / rw, 0, 1);
    fy = clamp((syw / sw - region.y0 + 0.5) / rh, 0, 1);
  }
  // Tall pictures are usually people or full-length products: favour the top.
  if (rw / rh < 0.85) fy = Math.min(fy, 0.42);

  // ---- Derivatives ---------------------------------------------------------
  const { data: view, info: vi } = await pipeline
    .resize(VIEW_EDGE, VIEW_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86, alphaQuality: 100, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  const tiny = await sharp(view).resize(24, 24, { fit: 'inside' }).flatten({ background: '#ffffff' }).webp({ quality: 50 }).toBuffer();
  const stats = await sharp(tiny).stats();
  const dom = hex(stats.channels.slice(0, 3).map((c) => c.mean));

  return {
    view, w: vi.width, h: vi.height, ow, oh,
    mime: FORMATS[md.format] || 'application/octet-stream',
    meta: {
      edges, bg, trimmed,
      focal: [Math.round(fx * 1000) / 1000, Math.round(fy * 1000) / 1000],
      lqip: 'data:image/webp;base64,' + tiny.toString('base64'),
      dom,
    },
  };
}
