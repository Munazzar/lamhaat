import { decode } from './vendor/blurhash.js';
import * as data from './data.js';
import * as auth from './auth.js';
import { openViewer, closeViewer } from './viewer.js';

const view = document.getElementById('view');
const bar = document.getElementById('bar');
const back = bar.querySelector('.back');
const barTitle = bar.querySelector('.bar-title');
const search = bar.querySelector('.search');
const searchInput = search.querySelector('input');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k in el && !k.startsWith('aria') ? el[k] = v : el.setAttribute(k, v);
  el.append(...kids.flat(Infinity).filter(k => k != null));
  return el;
};
const year = d => d?.slice(0, 4);
const years = a => year(a.dateStart) === year(a.dateEnd) ? year(a.dateStart) : `${year(a.dateStart)} – ${year(a.dateEnd)}`;
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const pad = n => String(n).padStart(2, '0');

function blurCanvas(hash, w = 32, ht = 32) {
  const c = document.createElement('canvas');
  c.width = w; c.height = ht; c.className = 'bh';
  try {
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, ht);
    img.data.set(decode(hash, w, ht));
    ctx.putImageData(img, 0, 0);
  } catch {}
  return c;
}
// Average colour of a photo, straight from its blurhash.
const avg = hash => { try { const d = decode(hash, 1, 1); return [d[0], d[1], d[2]]; } catch { return [20, 20, 22]; } };

// Fade an image in once it has decoded, so nothing ever pops in half-painted.
function whenReady(img, fn) {
  if (img.complete && img.naturalWidth) img.decode().catch(() => {}).then(fn);
  else img.addEventListener('load', () => img.decode().catch(() => {}).then(fn), { once: true });
}

// The page's ambient light follows the photographs in view.
function ambient(rgb) {
  const [r, g, b] = rgb.map(v => Math.round(v * 0.75 + 12));
  document.documentElement.style.setProperty('--amb', `rgb(${r} ${g} ${b})`);
}

// View Transitions where the browser has them; otherwise just swap.
let firstRender = true;
function transition(update) {
  if (firstRender || !document.startViewTransition || document.hidden || reduced.matches) {
    firstRender = false;
    return Promise.resolve(update());
  }
  const t = document.startViewTransition(update);
  t.ready.catch(() => {});
  return t.updateCallbackDone;
}

let catalogP, catalogAt = 0;
const getCatalog = () => {
  if (!catalogP || Date.now() - catalogAt > 50 * 60e3) { catalogAt = Date.now(); catalogP = data.catalog(); catalogP.catch(() => { catalogP = null; }); }
  return catalogP;
};
let ready = false; // set once the viewer is signed in and allowed
let cleanup = []; // per-page timers and listeners

// ---------- routing ----------
async function route() {
  if (!ready) return;
  const [, kind, id, photo] = location.hash.split('/');
  if (kind === 'a' && id) {
    if (view.dataset.album === id) { photo ? openFromHash(photo) : closeViewer(true); return; }
    await transition(() => renderAlbum(id));
    if (photo) openFromHash(photo);
  } else {
    closeViewer(false);
    await transition(renderHome);
  }
}
addEventListener('hashchange', route);

function leavePage() {
  cleanup.forEach(f => f()); cleanup = [];
  current = null;
  scrollTo(0, 0);
}

// Things drift at different speeds as you scroll, like layers of paper.
function parallax(els) {
  if (reduced.matches) return;
  let raf = 0;
  const tick = () => {
    raf = 0;
    const mid = innerHeight / 2;
    for (const el of els) {
      const r = el.parentElement.getBoundingClientRect();
      el.style.transform = `translate3d(0, ${((r.top + r.height / 2 - mid) * -el._speed).toFixed(1)}px, 0)`;
    }
  };
  const on = () => { raf ||= requestAnimationFrame(tick); };
  addEventListener('scroll', on, { passive: true });
  tick();
  cleanup.push(() => removeEventListener('scroll', on));
}

// ---------- home ----------
async function renderHome() {
  leavePage();
  const cat = await getCatalog().catch(err => ({ error: err }));
  view.dataset.album = '';
  view.className = 'home';
  back.hidden = true; search.hidden = true; barTitle.textContent = '';
  if (cat.error) return view.replaceChildren(message('Your library is not reachable right now.', String(cat.error.message || cat.error)));

  const albums = [...cat.albums].sort((a, b) => (b.dateEnd || '').localeCompare(a.dateEnd || ''));
  const total = albums.reduce((s, a) => s + a.count, 0);
  const first = albums[0];
  const manifest = first ? await data.album(first).catch(() => null) : null;
  const pool = manifest?.photos || [];
  const byName = new Map(pool.map(p => [p.src, p]));
  const slides = (manifest?.highlights || []).map(s => byName.get(s)).filter(Boolean);
  if (!slides.length) slides.push(...pool.slice(0, 6));
  const albumId = first?.id;

  // 1. a curved ribbon of photographs that turns slowly and can be spun by hand
  const step = Math.max(1, Math.floor(pool.length / 20));
  const ringPhotos = [...pool].sort((x, y) => (x.n ?? 0) - (y.n ?? 0)).filter((_, i) => i % step === 0).slice(0, 20);
  const cards = ringPhotos.map(p => {
    const img = h('img', { alt: p.title || '', decoding: 'async', draggable: false, src: data.src(p.v.thumb, albumId) });
    const card = h('a', { className: 'card3d', href: `#/a/${albumId}/${p.h}`, draggable: false, 'aria-label': p.title || 'Photo' }, blurCanvas(p.blurhash, 16, 16), img);
    whenReady(img, () => card.classList.add('ready'));
    return card;
  });
  const stage = h('div', { className: 'ribbon' }, cards);
  const headline = h('h1', { className: 'headline' },
    h('span', { className: 'w' }, 'Every'), ' ', h('span', { className: 'w' }, 'moment,'), ' ', h('em', { className: 'w' }, 'kept.'));
  const cine = h('section', { className: 'stagehead' },
    h('p', { className: 'mono kicker' }, h('span', { lang: 'ur', dir: 'rtl', className: 'urdu' }, 'لمحہ'), h('span', {}, `Lamha — ${total} photographs`)),
    headline,
    stage,
    h('div', { className: 'ctas' },
      first ? h('a', { className: 'btn accent', href: `#/a/${first.id}` }, 'Enter the portfolio') : null,
      h('a', { className: 'btn ghost', href: '#albums', onclick: e => { e.preventDefault(); view.querySelector('.index')?.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth' }); } }, 'All albums')),
    h('p', { className: 'mono hint', 'aria-hidden': 'true' }, 'drag to turn'));
  spin(stage, cards);
  if (slides[0]) ambient(avg(slides[0].blurhash));

  // 2. manifesto
  const manifesto = h('section', { className: 'manifesto' },
    h('p', { className: 'kicker' }, h('span', { lang: 'ur', dir: 'rtl', className: 'urdu' }, 'لمحہ'), h('span', {}, 'lamha, noun')),
    h('p', { className: 'statement' }, 'Urdu for ', h('em', {}, 'a moment'), ' — the blink between seeing a thing and keeping it. These are the ones I kept.'),
    h('p', { className: 'fine' }, `${total} photographs  ·  ${albums.length} ${albums.length === 1 ? 'album' : 'albums'}  ·  ${years({ dateStart: albums.at(-1)?.dateStart, dateEnd: first?.dateEnd })}`));

  // 3. a loose, layered scatter of photographs drifting at their own speeds
  const scatterPicks = slides.slice(0, 5); // the highlights, loosely pinned
  const floats = [];
  const scatter = h('section', { className: 'scatter', 'aria-hidden': 'true' }, scatterPicks.map((p, i) => {
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', src: data.src(p.v.md, albumId) });
    const inner = h('div', { className: 'float' }, blurCanvas(p.blurhash, 16, 16), img);
    inner._speed = [0.12, -0.08, 0.2, -0.04, 0.1][i];
    inner.style.aspectRatio = `${p.w} / ${p.hgt}`;
    floats.push(inner);
    whenReady(img, () => inner.classList.add('ready'));
    return h('div', { className: `spot s${i}` }, inner);
  }));

  // 4. albums, as an index
  const list = h('section', { className: 'index' },
    h('h2', { className: 'eyebrow' }, 'Albums'),
    albums.map((a, i) => {
      const img = h('img', { alt: '', decoding: 'async', loading: 'lazy', src: a.cover ? data.src(a.cover, a.id) : '' });
      const media = h('div', { className: 'card-media' }, a.cover ? blurCanvas(a.cover.blurhash) : null, img);
      media.style.viewTransitionName = `cover-${a.id}`;
      whenReady(img, () => media.classList.add('ready'));
      return h('a', { className: 'row', href: `#/a/${a.id}` },
        h('span', { className: 'num' }, pad(i + 1)),
        h('span', { className: 'title' }, a.title),
        h('span', { className: 'meta' }, `${a.count} photographs`, h('br'), years(a)),
        media);
    }));

  const foot = footer();
  view.replaceChildren(cine, manifesto, scatter, list, foot);
  if (auth.user()) view.append(h('button', { className: 'quiet', type: 'button', onclick: () => auth.signOut().then(() => location.replace(location.pathname)) }, 'Sign out'));
  parallax(floats);
  reveal(view.querySelectorAll('.manifesto > *, .spot, .row, .eyebrow'));
  watchBar(headline, 'Lamha');
}

// Cards sit on the inside of a cylinder, so the edges lean toward you. Drag to turn it; a flick
// keeps spinning and eases back to a slow drift.
function spin(stage, cards) {
  const N = cards.length;
  if (!N) return;
  const drift = reduced.matches ? 0 : -4; // degrees per second
  let W, R, Z0, P, angle = 0, vel = drift, raf = 0, last = 0, drag = null, moved = false;
  const size = () => {
    W = Math.min(220, Math.max(108, innerWidth * 0.14));
    R = ((W * 1.18) * N) / (2 * Math.PI);
    Z0 = R * 0.9; P = R * 1.0;
    stage.style.perspective = `${P}px`;
    stage.style.height = `${W * 1.33 * 1.9}px`;
    for (const c of cards) Object.assign(c.style, { width: `${W}px`, height: `${W * 1.33}px`, marginLeft: `${-W / 2}px`, marginTop: `${-W * 0.665}px` });
  };
  const place = () => {
    cards.forEach((c, i) => {
      let a = ((i * 360) / N + angle) % 360; if (a > 180) a -= 360; if (a < -180) a += 360;
      const r = (a * Math.PI) / 180, x = R * Math.sin(r), z = Z0 - R * Math.cos(r);
      const visible = Math.abs(a) < 88 && z < P * 0.62;
      c.style.visibility = visible ? 'visible' : 'hidden';
      if (!visible) return;
      c.style.transform = `translate3d(${x.toFixed(1)}px,0,${z.toFixed(1)}px) rotateY(${(-a).toFixed(2)}deg)`;
      c.style.opacity = Math.min(1, (P * 0.62 - z) / (P * 0.25)).toFixed(3);
    });
  };
  const frame = t => {
    const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    if (!drag) { angle += vel * dt; vel = drift + (vel - drift) * Math.exp(-dt * 1.6); }
    place();
    raf = stage.isConnected ? requestAnimationFrame(frame) : 0;
  };
  size(); place();
  raf = requestAnimationFrame(t => { last = t; frame(t); });
  const degPerPx = () => 180 / (Math.PI * R) * 1.4;
  stage.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, a: angle, samples: [{ x: e.clientX, t: performance.now() }] }; moved = false;
    stage.setPointerCapture(e.pointerId); stage.classList.add('grabbing');
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 6) moved = true;
    angle = drag.a + dx * degPerPx();
    drag.samples.push({ x: e.clientX, t: performance.now() }); if (drag.samples.length > 6) drag.samples.shift();
  });
  const end = () => {
    if (!drag) return;
    const s = drag.samples.filter(p => performance.now() - p.t < 100);
    vel = s.length > 1 ? ((s.at(-1).x - s[0].x) / Math.max(1, s.at(-1).t - s[0].t)) * 1000 * degPerPx() : drift;
    vel = Math.max(-240, Math.min(240, vel));
    drag = null; stage.classList.remove('grabbing');
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('click', e => { if (moved) e.preventDefault(); }, true);
  addEventListener('resize', size);
  cleanup.push(() => { cancelAnimationFrame(raf); removeEventListener('resize', size); });
}

function footer() {
  const phrase = ['Lamha', 'لمحہ', 'a moment, held'];
  const run = () => h('span', {}, Array.from({ length: 4 }, () => phrase.map(t => h('b', {}, t))));
  return h('footer', { className: 'marquee', 'aria-hidden': 'true' }, h('div', { className: 'track' }, run(), run()));
}

// Elements rise into place the first time they scroll into view.
function reveal(els) {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach(el => { el.classList.add('rv'); io.observe(el); });
  cleanup.push(() => io.disconnect());
}

// ---------- album ----------
let current = null; // { entry, chapters: [{ el, grid, photos, shown }], photos (visible, in order), tiles }

async function renderAlbum(id) {
  leavePage();
  const cat = await getCatalog();
  const entry = cat.albums.find(a => a.id === id);
  if (!entry) return view.replaceChildren(message('This album isn’t here.', 'It may have been removed, or you may not have access to it.'));
  let manifest;
  try { manifest = await data.album(entry); } catch (err) { return view.replaceChildren(message('This album couldn’t be opened.', err.message)); }
  view.dataset.album = id;
  view.className = 'album';
  back.hidden = false; search.hidden = false; searchInput.value = '';

  const ordered = [...manifest.photos].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  // Chapters: each photo lands in the first chapter whose tags it shares; a tagless chapter catches the rest.
  const defs = manifest.chapters?.length ? manifest.chapters : [{ title: entry.title, sub: '', tags: [] }];
  const chapters = defs.map(d => ({ ...d, photos: [] }));
  for (const p of ordered) (chapters.find(c => !c.tags.length || c.tags.some(t => p.tags?.includes(t))) || chapters.at(-1)).photos.push(p);
  const used = chapters.filter(c => c.photos.length);

  const coverImg = h('img', { alt: '', src: entry.cover ? data.src(entry.cover, id) : '', decoding: 'async' });
  const heroMedia = h('div', { className: 'hero-media' }, entry.cover ? blurCanvas(entry.cover.blurhash) : null, coverImg);
  heroMedia.style.viewTransitionName = `cover-${id}`;
  whenReady(coverImg, () => heroMedia.classList.add('ready'));
  if (entry.cover) ambient(avg(entry.cover.blurhash));

  const title = h('h1', {}, entry.title);
  const toc = h('ol', { className: 'toc' }, used.map((c, i) =>
    h('li', {}, h('button', { type: 'button', onclick: () => c.el.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth' }) },
      h('span', { className: 'rn' }, ROMAN[i]), h('span', { className: 't' }, c.title), h('span', { className: 'c' }, String(c.photos.length))))));

  const tagCounts = new Map();
  for (const p of ordered) for (const t of p.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = [...tagCounts].filter(([, n]) => n > 2 && n < ordered.length).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t]) => t);
  const chips = h('div', { className: 'chips', role: 'group', 'aria-label': 'Filter by subject' },
    ['All', ...topTags].map((t, i) => h('button', { className: 'chip', type: 'button', 'aria-pressed': String(i === 0) }, t)));

  current = { entry, chapters: used, photos: ordered, tiles: new Map() };
  for (const p of ordered) current.tiles.set(p.h, tile(p));
  const sections = used.map((c, i) => {
    c.grid = h('div', { className: 'grid' }, c.photos.map(p => current.tiles.get(p.h)));
    c.rgb = c.photos.map(p => avg(p.blurhash)).reduce((s, v) => s.map((x, k) => x + v[k] / c.photos.length), [0, 0, 0]);
    c.el = h('section', { className: 'chapter' },
      h('header', { className: 'ch-head' },
        h('span', { className: 'rn' }, ROMAN[i]),
        h('h2', {}, c.title),
        h('p', {}, c.sub || ''),
        h('span', { className: 'c' }, `${c.photos.length} photographs`)),
      c.grid);
    return c.el;
  });

  view.replaceChildren(
    h('section', { className: 'hero' }, heroMedia,
      h('div', { className: 'hero-text' },
        h('p', { className: 'kicker' }, `${years(entry)}  ·  ${entry.count} photographs`),
        title)),
    h('section', { className: 'contents' }, h('p', { className: 'eyebrow' }, 'Contents'), toc),
    chips,
    ...sections,
    h('p', { className: 'empty', hidden: true }, 'No photographs match.'),
    footer(),
  );
  watchBar(title, entry.title);
  layout();
  reveal(view.querySelectorAll('.contents, .ch-head'));

  // Ambient light shifts to each chapter's colours as it takes the screen.
  const amb = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) ambient(used.find(c => c.el === e.target).rgb);
  }, { rootMargin: '-45% 0px -45% 0px' });
  used.forEach(c => amb.observe(c.el));
  cleanup.push(() => amb.disconnect());

  let tag = 'All';
  const apply = () => {
    const words = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = p => {
      const text = [p.title, p.src, ...(p.tags || []), p.camera, p.lens].join(' ').toLowerCase();
      return (tag === 'All' || p.tags?.includes(tag)) && words.every(w => text.includes(w));
    };
    for (const c of used) c.shown = c.photos.filter(match);
    layout(true);
  };
  chips.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    tag = b.textContent;
    for (const c of chips.children) c.setAttribute('aria-pressed', String(c === b));
    apply();
  });
  searchInput.oninput = apply;
}

function tile(p) {
  const img = h('img', { alt: p.title || '', decoding: 'async', loading: 'lazy' });
  img.src = data.src(p.v.thumb);
  img.srcset = `${data.src(p.v.thumb)} 400w, ${data.src(p.v.md)} 1600w`;
  const inner = h('span', { className: 'ph' }, blurCanvas(p.blurhash, 24, 24), img);
  const el = h('button', { className: 'tile', type: 'button', 'aria-label': p.title || 'Photo' }, inner);
  el.addEventListener('click', () => {
    const i = current.photos.indexOf(p);
    if (i >= 0) open(i, el);
  });
  // The photo leans gently toward the pointer.
  el.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    el.style.setProperty('--my', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  });
  el.addEventListener('pointerleave', () => { el.style.setProperty('--mx', 0); el.style.setProperty('--my', 0); });
  el._img = img;
  return el;
}

// Justified rows: every photo keeps its full frame, rows fill the width exactly.
function justify(photos, width, target, gap) {
  const out = [];
  let row = [], sum = 0, y = 0;
  const flush = (full) => {
    const hgt = full ? (width - gap * (row.length - 1)) / sum : Math.min(target, (width - gap * (row.length - 1)) / sum);
    let x = 0;
    for (const p of row) { const w = (p.w / p.hgt) * hgt; out.push({ p, x, y, w, h: hgt }); x += w + gap; }
    y += hgt + gap; row = []; sum = 0;
  };
  for (const p of photos) {
    row.push(p); sum += p.w / p.hgt;
    if (sum * target + gap * (row.length - 1) >= width) flush(true);
  }
  if (row.length) flush(false);
  return { boxes: out, height: Math.max(0, y - gap) };
}

let revealQueue = [], revealTimer = 0;
const io = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); revealQueue.push(e.target); }
  // Stagger whatever entered together, in reading order — the grid settles in like a breath.
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    revealQueue.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a._x - b._x).forEach((el, i) => {
      whenReady(el._img, () => setTimeout(() => el.classList.add('in'), Math.min(i, 12) * 80));
    });
    revealQueue = [];
  }, 16);
}, { rootMargin: '0px 0px 10% 0px' });

function layout(animate = false) {
  if (!current) return;
  const width = current.chapters[0]?.grid.clientWidth;
  if (!width) return;
  const small = width < 640;
  const gap = small ? 3 : 10;
  const target = small ? Math.max(120, width / 2.6) : Math.min(360, Math.max(220, width / 4.4));
  current.photos = [];
  for (const c of current.chapters) {
    const shown = c.shown || c.photos;
    current.photos.push(...shown);
    c.el.hidden = !shown.length;
    const { boxes, height } = justify(shown, width, target, gap);
    c.grid.classList.toggle('animate', animate);
    c.grid.style.height = `${height}px`;
    const on = new Set();
    for (const b of boxes) {
      const el = current.tiles.get(b.p.h);
      on.add(el);
      el.classList.remove('out');
      Object.assign(el.style, { width: `${b.w}px`, height: `${b.h}px`, transform: `translate(${b.x}px, ${b.y}px)` });
      el._x = b.x;
      el._img.sizes = `${Math.ceil(b.w)}px`;
      if (!el.classList.contains('in')) io.observe(el);
    }
    for (const p of c.photos) { const el = current.tiles.get(p.h); if (!on.has(el)) { el.classList.add('out'); io.unobserve(el); } }
  }
  view.querySelector('.empty').hidden = current.photos.length > 0;
}
new ResizeObserver(() => layout()).observe(view);

// ---------- viewer hookup ----------
function open(i, fromEl) {
  history.pushState({ viewer: true }, '', `#/a/${current.entry.id}/${current.photos[i].h}`);
  openViewer({
    photos: current.photos, index: i, from: fromEl,
    tileFor: p => current.tiles.get(p.h),
    onIndex: p => history.replaceState({ viewer: true }, '', `#/a/${current.entry.id}/${p.h}`),
    onClose: () => { if (history.state?.viewer) history.back(); else history.replaceState(null, '', `#/a/${current.entry.id}`); },
    fmtDate,
  });
}
function openFromHash(hsh) {
  const i = current?.photos.findIndex(p => p.h === hsh);
  if (i >= 0) openViewer({ photos: current.photos, index: i, from: null, tileFor: p => current.tiles.get(p.h),
    onIndex: p => history.replaceState(null, '', `#/a/${current.entry.id}/${p.h}`),
    onClose: () => history.replaceState(null, '', `#/a/${current.entry.id}`), fmtDate });
}

// ---------- chrome ----------
let barWatch;
function watchBar(el, text) {
  barWatch?.disconnect();
  barTitle.textContent = text;
  bar.classList.remove('scrolled');
  barWatch = new IntersectionObserver(([e]) => bar.classList.toggle('scrolled', !e.isIntersecting), { rootMargin: '-56px 0px 0px 0px' });
  barWatch.observe(el);
}

function message(title, detail) {
  return h('section', { className: 'message' }, h('h1', {}, title), h('p', {}, detail));
}

// ---------- sign-in gate ----------
async function start() {
  const cfg = await data.config();
  if (cfg) {
    const user = await auth.init(cfg.firebase).catch(() => null);
    if (!user) return gate('signin', cfg);
    let who;
    try { who = await data.me(); } catch (err) { return view.replaceChildren(message('Lamha is not reachable right now.', err.message)); }
    if (!who.owner && !who.groups.length) return gate('denied', cfg, who.email);
  }
  ready = true;
  route();
}

function gate(kind, cfg, email) {
  view.className = 'gate';
  back.hidden = true; search.hidden = true;
  const button = h('button', { className: 'google', type: 'button' },
    h('span', { className: 'g', 'aria-hidden': 'true' }), kind === 'signin' ? 'Continue with Google' : 'Use another account');
  const note = h('p', { className: 'note' }, kind === 'signin'
    ? `A private library. Only people ${cfg.ownerName || 'the owner'} has invited can see these photographs.`
    : `You’re signed in as ${email}, which isn’t on the list yet. Ask ${cfg.ownerName || 'the owner'} to add you, then come back.`);
  button.onclick = async () => {
    button.disabled = true;
    try { if (kind === 'denied') await auth.signOut(); await auth.signIn(); await start(); }
    catch (err) { if (err.code !== 'auth/popup-closed-by-user') note.textContent = 'Sign-in didn’t finish. Please try again.'; }
    finally { button.disabled = false; }
  };
  view.replaceChildren(h('section', { className: 'gate-intro' },
    h('h1', { className: 'giant solo' }, 'Lamha'),
    h('p', { className: 'urdu' , lang: 'ur', dir: 'rtl' }, 'لمحہ'),
    note, button));
}

start();
