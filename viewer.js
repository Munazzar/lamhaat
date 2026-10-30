// Full-screen photo viewer. Every motion is a spring that starts from what is on screen, so the
// photo can be grabbed mid-flight: it rises out of its tile, follows the finger 1:1, and is
// thrown back into its place in the grid when dismissed.
import { Spring, project, rubberband, reducedMotion } from './spring.js';
import * as data from './data.js';

const root = document.getElementById('lb');
const GAP = 28, MAX_ZOOM = 5;
let S = null; // the open session

const render = () => {
  if (!S) return;
  S.trackEl.style.transform = `translate3d(${S.track.value}px,0,0)`;
  const cur = S.slides.get(S.index);
  if (cur) cur.frame.style.transform = `translate3d(${S.zx.value}px,${S.zy.value}px,0) scale(${S.zs.value})`;
  root.style.setProperty('--scrim', S.scrim.value.toFixed(3));
};

const W = () => root.clientWidth || innerWidth;
const H = () => root.clientHeight || innerHeight;
const step = () => W() + GAP;
function fit(p) {
  const s = Math.min(W() / p.w, H() / p.hgt);
  const w = p.w * s, h = p.hgt * s;
  return { w, h, left: (W() - w) / 2, top: (H() - h) / 2, cx: W() / 2, cy: H() / 2 };
}
const photo = () => S.photos[S.index];
const bounds = s => { const f = fit(photo()); return { x: Math.max(0, (f.w * s - W()) / 2), y: Math.max(0, (f.h * s - H()) / 2) }; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Transform that puts the fitted photo exactly over a tile on the page.
function overTile(tile) {
  const r = tile.getBoundingClientRect(), f = fit(photo());
  return { x: r.left + r.width / 2 - f.cx, y: r.top + r.height / 2 - f.cy, s: r.width / f.w };
}

function whenAll(springs, done) {
  let left = springs.length;
  for (const [s, target, opts] of springs) s.to(target, { ...opts, onRest: () => --left || done() });
}

// ---------- building ----------
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; }
const icon = {
  close: '<svg viewBox="0 0 20 20"><path d="M4 4l12 12M16 4 4 16"/></svg>',
  info: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6.2v.1"/></svg>',
  prev: '<svg viewBox="0 0 20 20"><path d="M12.5 4 6.5 10l6 6"/></svg>',
  next: '<svg viewBox="0 0 20 20"><path d="m7.5 4 6 6-6 6"/></svg>',
};

function build() {
  root.replaceChildren();
  S.trackEl = el('div', 'lb-track');
  const top = el('div', 'lb-top');
  S.closeBtn = el('button', 'lb-btn', icon.close); S.closeBtn.setAttribute('aria-label', 'Close');
  S.count = el('span', 'lb-count');
  S.infoBtn = el('button', 'lb-btn', icon.info); S.infoBtn.setAttribute('aria-label', 'Details');
  top.append(S.closeBtn, S.count, S.infoBtn);
  S.prevBtn = el('button', 'lb-nav prev', icon.prev); S.prevBtn.setAttribute('aria-label', 'Previous photo');
  S.nextBtn = el('button', 'lb-nav next', icon.next); S.nextBtn.setAttribute('aria-label', 'Next photo');
  S.caption = el('div', 'lb-caption');
  const chrome = el('div', 'lb-chrome');
  chrome.append(top, S.prevBtn, S.nextBtn, S.caption);
  // Ambient glow: the photo's own colours, blurred into the dark around it.
  S.glow = el('div', 'lb-glow');
  root.append(el('div', 'lb-scrim'), S.glow, S.trackEl, chrome);

  S.closeBtn.onclick = () => closeViewer(true);
  S.infoBtn.onclick = () => root.classList.toggle('details');
  S.prevBtn.onclick = () => goTo(S.index - 1);
  S.nextBtn.onclick = () => goTo(S.index + 1);
}

function slide(i) {
  const p = S.photos[i], f = fit(p);
  const s = el('div', 'lb-slide');
  s.style.transform = `translate3d(${i * step()}px,0,0)`;
  const frame = el('div', 'lb-frame');
  Object.assign(frame.style, { left: `${f.left}px`, top: `${f.top}px`, width: `${f.w}px`, height: `${f.h}px` });
  const lo = new Image(); lo.src = data.src(p.v.thumb); lo.alt = '';
  const hi = new Image(); hi.decoding = 'async'; hi.alt = p.title || '';
  hi.src = data.src(p.v.md);
  hi.decode().then(() => hi.classList.add('ready')).catch(() => {});
  frame.append(lo, hi);
  s.append(frame);
  return { el: s, frame, p, full: null };
}

function loadFull(sl) {
  if (sl.full) return;
  const img = new Image(); img.decoding = 'async'; img.alt = '';
  img.src = data.src(sl.p.v.full);
  img.decode().then(() => img.classList.add('ready')).catch(() => {});
  sl.full = img; sl.frame.append(img);
}

function ensureSlides() {
  const keep = new Set();
  for (let i = S.index - 2; i <= S.index + 2; i++) if (i >= 0 && i < S.photos.length) keep.add(i);
  for (const [i, sl] of S.slides) if (!keep.has(i)) { sl.el.remove(); S.slides.delete(i); }
  for (const i of keep) if (!S.slides.has(i)) { const sl = slide(i); S.slides.set(i, sl); S.trackEl.append(sl.el); }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function glow(p) {
  const img = new Image(); img.alt = ''; img.src = data.src(p.v.thumb);
  img.decode().catch(() => {}).then(() => {
    if (!S) return;
    S.glow.append(img);
    requestAnimationFrame(() => img.classList.add('on'));
    const old = [...S.glow.children].slice(0, -1);
    setTimeout(() => old.forEach(o => o.remove()), 1600);
  });
}

function caption() {
  const p = photo();
  glow(p);
  S.count.textContent = `${S.index + 1} of ${S.photos.length}`;
  const settings = [p.f && `ƒ/${p.f}`, p.shutter, p.iso && `ISO ${p.iso}`].filter(Boolean).join('  ·  ');
  const rows = [['Camera', p.camera], ['Lens', p.lens], ['Exposure', settings], ['Size', `${p.w} × ${p.hgt}`]].filter(r => r[1]);
  S.caption.innerHTML = `<h2>${esc(p.title)}</h2><p>${esc(S.fmtDate(p.taken))}${p.camera ? ` · ${esc(p.camera)}` : ''}</p>` +
    `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` +
    (p.tags?.length ? `<p class="tags">${p.tags.map(esc).join('  ·  ')}</p>` : '');
  S.prevBtn.hidden = S.index === 0;
  S.nextBtn.hidden = S.index === S.photos.length - 1;
}

// ---------- open / navigate / close ----------
export function openViewer(opts) {
  if (S) { if (!S.closing) goTo(opts.index); return; }
  S = { ...opts, slides: new Map(), closing: false };
  S.track = new Spring(-S.index * step(), { precision: 0.2, onUpdate: render });
  S.zx = new Spring(0, { precision: 0.2, onUpdate: render });
  S.zy = new Spring(0, { precision: 0.2, onUpdate: render });
  S.zs = new Spring(1, { precision: 0.0005, onUpdate: render });
  S.scrim = new Spring(0, { precision: 0.002, onUpdate: render });
  build();
  root.hidden = false;
  root.classList.remove('bare', 'details');
  document.documentElement.classList.add('viewing');
  ensureSlides(); caption();
  S.returnFocus = document.activeElement;
  S.closeBtn.focus({ preventScroll: true });

  const tile = S.tileFor(photo());
  if (S.from && tile) {
    const t = overTile(S.from);
    S.zx.set(t.x); S.zy.set(t.y); S.zs.set(t.s);
    tile.classList.add('away');
  } else S.zs.set(0.94);
  render();
  // A slow, settled rise — no overshoot on something the user didn't throw.
  S.zx.to(0, { response: 0.55 }); S.zy.to(0, { response: 0.55 }); S.zs.to(1, { response: 0.55 });
  S.scrim.to(1, { response: 0.5 });
}

function goTo(i, velocity = 0) {
  i = clamp(i, 0, S.photos.length - 1);
  if (i !== S.index) {
    S.tileFor(photo())?.classList.remove('away');
    const old = S.slides.get(S.index);
    S.index = i;
    S.tileFor(photo())?.classList.add('away');
    S.zx.set(0); S.zy.set(0); S.zs.set(1);
    ensureSlides(); caption();
    S.onIndex(photo());
    S.track.to(-i * step(), { velocity, response: 0.5, onRest: () => old && (old.frame.style.transform = '') });
  } else S.track.to(-i * step(), { velocity, response: 0.5 });
}

export function closeViewer(animated, velocity = {}) {
  if (!S || S.closing) return;
  S.closing = true;
  const s = S;
  const tile = s.tileFor(photo());
  const teardown = () => {
    if (S !== s) return;
    tile?.classList.remove('away');
    root.hidden = true; root.replaceChildren();
    document.documentElement.classList.remove('viewing');
    for (const sp of [s.track, s.zx, s.zy, s.zs, s.scrim]) sp.stop();
    S = null;
    s.returnFocus?.focus?.({ preventScroll: true });
    s.onClose();
  };
  if (!animated || reducedMotion.matches) return teardown();

  root.classList.add('bare');
  let t = null;
  if (tile && !tile.classList.contains('out')) {
    const r = tile.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) tile.scrollIntoView({ block: 'center', behavior: 'instant' });
    t = overTile(tile);
  }
  if (t) {
    whenAll([[s.zx, t.x, { velocity: velocity.x, response: 0.5 }], [s.zy, t.y, { velocity: velocity.y, response: 0.5 }],
      [s.zs, t.s, { response: 0.5 }], [s.scrim, 0, { response: 0.42 }]], teardown);
  } else {
    root.classList.add('fading');
    whenAll([[s.zs, 0.9, { response: 0.4 }], [s.scrim, 0, { response: 0.4 }]], teardown);
  }
}

// ---------- zoom ----------
function zoomTo(scale, px, py, response = 0.45) {
  const f = fit(photo());
  const s0 = S.zs.target, x0 = S.zx.target, y0 = S.zy.target;
  scale = clamp(scale, 1, MAX_ZOOM);
  // Keep the point under (px, py) under it while scaling.
  let x = x0 + (px - (f.cx + x0)) * (1 - scale / s0);
  let y = y0 + (py - (f.cy + y0)) * (1 - scale / s0);
  const b = bounds(scale);
  x = clamp(x, -b.x, b.x); y = clamp(y, -b.y, b.y);
  S.zs.to(scale, { response }); S.zx.to(x, { response }); S.zy.to(y, { response });
  if (scale > 1.3) loadFull(S.slides.get(S.index));
}
function toggleZoom(px, py) {
  if (S.zs.target > 1.01) return zoomTo(1, W() / 2, H() / 2);
  const f = fit(photo());
  zoomTo(clamp(Math.min(photo().w, 3000) / f.w, 2, 4), px, py);
}

// ---------- gestures ----------
const pts = new Map();
let g = null, lastTap = null, tapTimer = 0;

function velocityOf(samples) {
  const now = performance.now();
  const recent = samples.filter(s => now - s.t < 100);
  if (recent.length < 2) return { x: 0, y: 0 };
  const a = recent[0], b = recent.at(-1), dt = Math.max(1, b.t - a.t) / 1000;
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
}
function baseline(p) {
  g = { mode: S.zs.value > 1.01 ? 'pan' : null, x0: p.x, y0: p.y, t0: performance.now(), moved: false,
    track0: S.track.value, zx0: S.zx.value, zy0: S.zy.value, samples: [{ x: p.x, y: p.y, t: performance.now() }] };
}
function pinchStart() {
  const [a, b] = [...pts.values()];
  const f = fit(photo());
  g = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: S.zs.value, moved: true,
    u: { x: ((a.x + b.x) / 2 - (f.cx + S.zx.value)) / S.zs.value, y: ((a.y + b.y) / 2 - (f.cy + S.zy.value)) / S.zs.value } };
  loadFull(S.slides.get(S.index));
}

root.addEventListener('pointerdown', e => {
  if (!S || S.closing || e.button > 0 || e.target.closest('button, .lb-caption')) return;
  root.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  for (const s of [S.track, S.zx, S.zy, S.zs, S.scrim]) s.stop(); // grab it where it is
  if (pts.size === 1) baseline(pts.get(e.pointerId));
  else if (pts.size === 2) pinchStart();
});

root.addEventListener('pointermove', e => {
  if (!S || !pts.has(e.pointerId) || !g) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.mode === 'pinch') {
    if (pts.size < 2) return;
    const [a, b] = [...pts.values()];
    let s = g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0;
    if (s < 1) s = 1 - rubberband(1 - s, 1, 0.9);
    if (s > MAX_ZOOM) s = MAX_ZOOM + rubberband(s - MAX_ZOOM, MAX_ZOOM, 0.5);
    const f = fit(photo()), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.zs.set(s); S.zx.set(mx - g.u.x * s - f.cx); S.zy.set(my - g.u.y * s - f.cy);
    S.scrim.set(clamp(s, 0.6, 1) ** 2);
    return;
  }
  const x = e.clientX, y = e.clientY, dx = x - g.x0, dy = y - g.y0;
  g.samples.push({ x, y, t: performance.now() }); if (g.samples.length > 8) g.samples.shift();
  if (!g.moved) {
    if (Math.hypot(dx, dy) < 8) return;
    g.moved = true;
    g.mode ||= Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'dismiss';
  }
  if (g.mode === 'swipe') {
    const max = 0, min = -(S.photos.length - 1) * step();
    let v = g.track0 + dx;
    if (v > max) v = max + rubberband(v - max, W());
    if (v < min) v = min - rubberband(min - v, W());
    S.track.set(v);
  } else if (g.mode === 'dismiss') {
    const k = Math.min(1, Math.abs(dy) / (H() * 0.7));
    S.zx.set(dx * 0.9); S.zy.set(dy); S.zs.set(1 - k * 0.3); S.scrim.set(1 - k);
  } else if (g.mode === 'pan') {
    const b = bounds(S.zs.value);
    let nx = g.zx0 + dx, ny = g.zy0 + dy;
    if (Math.abs(nx) > b.x) nx = Math.sign(nx) * (b.x + rubberband(Math.abs(nx) - b.x, W()));
    if (Math.abs(ny) > b.y) ny = Math.sign(ny) * (b.y + rubberband(Math.abs(ny) - b.y, H()));
    S.zx.set(nx); S.zy.set(ny);
  }
});

function release(e) {
  if (!S || !pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (!g) return;
  if (g.mode === 'pinch') {
    if (pts.size === 1) { baseline([...pts.values()][0]); g.moved = true; g.mode = 'pan'; return; }
    if (pts.size) return;
    const s = clamp(S.zs.value, 1, MAX_ZOOM), b = bounds(s);
    S.scrim.to(1, { response: 0.4 });
    if (s <= 1.01) { S.zs.to(1, { response: 0.45 }); S.zx.to(0, { response: 0.45 }); S.zy.to(0, { response: 0.45 }); }
    else { S.zs.to(s, { response: 0.4 }); S.zx.to(clamp(S.zx.value, -b.x, b.x), { response: 0.4 }); S.zy.to(clamp(S.zy.value, -b.y, b.y), { response: 0.4 }); }
    g = null; return;
  }
  const v = velocityOf(g.samples);
  const mode = g.mode, moved = g.moved;
  g = null;
  if (!moved) return tap(e);
  if (mode === 'swipe') {
    const landing = S.track.value + project(v.x, 0.995);
    const target = clamp(Math.round(-landing / step()), S.index - 1, S.index + 1);
    goTo(target, v.x);
  } else if (mode === 'dismiss') {
    if (Math.abs(S.zy.value + project(v.y, 0.99)) > H() * 0.22) closeViewer(true, v);
    else {
      // Not far enough: it springs home with the momentum it was given.
      S.zx.to(0, { velocity: v.x, response: 0.45, damping: 0.85 });
      S.zy.to(0, { velocity: v.y, response: 0.45, damping: 0.85 });
      S.zs.to(1, { response: 0.45 }); S.scrim.to(1, { response: 0.45 });
    }
  } else if (mode === 'pan') {
    const b = bounds(S.zs.value);
    S.zx.to(clamp(S.zx.value + project(v.x, 0.995), -b.x, b.x), { velocity: v.x, response: 0.6 });
    S.zy.to(clamp(S.zy.value + project(v.y, 0.995), -b.y, b.y), { velocity: v.y, response: 0.6 });
  }
}
root.addEventListener('pointerup', release);
root.addEventListener('pointercancel', release);

function tap(e) {
  const x = e.clientX, y = e.clientY;
  if (e.pointerType === 'mouse') {
    // Mouse: click the photo to zoom, click the dark around it to close.
    const r = S.slides.get(S.index).frame.getBoundingClientRect();
    const onPhoto = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    return onPhoto ? toggleZoom(x, y) : closeViewer(true);
  }
  // Touch: double-tap zooms, single tap shows/hides the chrome.
  if (lastTap && performance.now() - lastTap.t < 280 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
    clearTimeout(tapTimer); lastTap = null; return toggleZoom(x, y);
  }
  lastTap = { x, y, t: performance.now() };
  tapTimer = setTimeout(() => { lastTap = null; root.classList.toggle('bare'); }, 280);
}

root.addEventListener('wheel', e => {
  if (!S || S.closing) return;
  e.preventDefault();
  if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) && S.zs.target <= 1.01) {
    // Two-finger horizontal swipe on a trackpad pages through photos.
    if (Math.abs(e.deltaX) > 30 && !S.track.moving) goTo(S.index + Math.sign(e.deltaX));
    return;
  }
  const scale = S.zs.target * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0025));
  zoomTo(scale, e.clientX, e.clientY, 0.25);
}, { passive: false });

addEventListener('keydown', e => {
  if (!S || S.closing) return;
  const k = e.key;
  if (k === 'Escape') closeViewer(true);
  else if (k === 'ArrowRight') goTo(S.index + 1);
  else if (k === 'ArrowLeft') goTo(S.index - 1);
  else if (k === 'i') root.classList.toggle('details');
  else if (k === '+' || k === '=') zoomTo(S.zs.target * 1.6, W() / 2, H() / 2);
  else if (k === '-') zoomTo(S.zs.target / 1.6, W() / 2, H() / 2);
  else if (k === 'Tab') { // keep focus inside the viewer
    const f = [...root.querySelectorAll('button:not([hidden])')];
    const i = f.indexOf(document.activeElement);
    e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
  } else return;
  if (k !== 'Tab') e.preventDefault();
});

addEventListener('resize', () => {
  if (!S || S.closing) return;
  for (const [i, sl] of S.slides) { sl.el.remove(); S.slides.delete(i); }
  S.zx.set(0); S.zy.set(0); S.zs.set(1); S.track.set(-S.index * step());
  ensureSlides(); render();
});
