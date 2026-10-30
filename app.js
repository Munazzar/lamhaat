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

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k in el && !k.startsWith('aria') ? el[k] = v : el.setAttribute(k, v);
  el.append(...kids.filter(k => k != null));
  return el;
};
const year = d => d?.slice(0, 4);
const years = a => year(a.dateStart) === year(a.dateEnd) ? year(a.dateStart) : `${year(a.dateStart)} – ${year(a.dateEnd)}`;
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

function blurCanvas(hash, w = 32, h = 32) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h; c.className = 'bh';
  try {
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    img.data.set(decode(hash, w, h));
    ctx.putImageData(img, 0, 0);
  } catch {}
  return c;
}

// Fade an image in once it has decoded, so nothing ever pops in half-painted.
function whenReady(img, fn) {
  if (img.complete && img.naturalWidth) img.decode().catch(() => {}).then(fn);
  else img.addEventListener('load', () => img.decode().catch(() => {}).then(fn), { once: true });
}

// View Transitions where the browser has them; otherwise just swap.
let firstRender = true;
function transition(update) {
  if (firstRender || !document.startViewTransition || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
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

// ---------- home ----------
async function renderHome() {
  const cat = await getCatalog().catch(err => ({ error: err }));
  view.dataset.album = '';
  view.className = 'home';
  current = null;
  back.hidden = true; search.hidden = true; barTitle.textContent = '';
  scrollTo(0, 0);
  if (cat.error) return view.replaceChildren(message('Your library is not reachable right now.', String(cat.error.message || cat.error)));

  const albums = [...cat.albums].sort((a, b) => (b.dateEnd || '').localeCompare(a.dateEnd || ''));
  view.replaceChildren(
    h('section', { className: 'intro' },
      h('h1', { className: 'wordmark' }, 'Lamha'),
      h('p', { className: 'urdu', lang: 'ur', dir: 'rtl' }, 'لمحہ'),
      h('p', { className: 'lede' }, `${albums.length} ${albums.length === 1 ? 'album' : 'albums'} · ${albums.reduce((s, a) => s + a.count, 0)} photographs`),
      auth.user() ? h('button', { className: 'quiet', type: 'button', onclick: () => auth.signOut().then(() => location.replace(location.pathname)) }, 'Sign out') : null),
    h('section', { className: 'albums' }, ...albums.map(albumCard)),
  );
  watchBar(view.querySelector('.wordmark'), 'Lamha');
}

function albumCard(a) {
  const img = h('img', { alt: '', src: a.cover ? data.src(a.cover, a.id) : '', decoding: 'async' });
  const media = h('div', { className: 'card-media' }, a.cover ? blurCanvas(a.cover.blurhash) : null, img);
  media.style.viewTransitionName = `cover-${a.id}`;
  whenReady(img, () => media.classList.add('ready'));
  return h('a', { className: 'card', href: `#/a/${a.id}` },
    media,
    h('div', { className: 'card-text' },
      h('h2', {}, a.title),
      h('p', {}, `${years(a)} · ${a.count} photographs`)));
}

// ---------- album ----------
let current = null; // { entry, manifest, photos (filtered, in display order), tiles }

async function renderAlbum(id) {
  const cat = await getCatalog();
  const entry = cat.albums.find(a => a.id === id);
  if (!entry) return view.replaceChildren(message('This album isn’t here.', 'It may have been removed, or you may not have access to it.'));
  let manifest;
  try { manifest = await data.album(entry); } catch (err) { return view.replaceChildren(message('This album couldn’t be opened.', err.message)); }
  view.dataset.album = id;
  view.className = 'album';
  back.hidden = false; search.hidden = false; searchInput.value = '';
  scrollTo(0, 0);

  const ordered = [...manifest.photos].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const coverImg = h('img', { alt: '', src: entry.cover ? data.src(entry.cover, id) : '', decoding: 'async' });
  const heroMedia = h('div', { className: 'hero-media' }, entry.cover ? blurCanvas(entry.cover.blurhash) : null, coverImg);
  heroMedia.style.viewTransitionName = `cover-${id}`;
  whenReady(coverImg, () => heroMedia.classList.add('ready'));

  const tagCounts = new Map();
  for (const p of ordered) for (const t of p.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = [...tagCounts].filter(([, n]) => n > 2 && n < ordered.length).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t]) => t);
  const chips = h('div', { className: 'chips', role: 'group', 'aria-label': 'Filter by subject' },
    ...['All', ...topTags].map((t, i) => h('button', { className: 'chip', type: 'button', 'aria-pressed': String(i === 0) }, t)));

  const grid = h('div', { className: 'grid' });
  const title = h('h1', {}, entry.title);
  view.replaceChildren(
    h('section', { className: 'hero' }, heroMedia,
      h('div', { className: 'hero-text' }, title, h('p', {}, `${years(entry)} · ${entry.count} photographs`))),
    chips, grid,
    h('p', { className: 'empty', hidden: true }, 'No photographs match.'),
  );
  watchBar(title, entry.title);

  current = { entry, manifest, all: ordered, photos: ordered, tiles: new Map() };
  for (const p of ordered) current.tiles.set(p.h, tile(p));
  grid.append(...current.tiles.values());
  layout();

  let tag = 'All';
  const apply = () => {
    const q = searchInput.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    current.photos = ordered.filter(p => {
      const text = [p.title, p.src, ...(p.tags || []), p.camera, p.lens].join(' ').toLowerCase();
      return (tag === 'All' || p.tags?.includes(tag)) && words.every(w => text.includes(w));
    });
    view.querySelector('.empty').hidden = current.photos.length > 0;
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
  el._img = img;
  el._photo = p;
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
    revealQueue.sort((a, b) => a._y - b._y || a._x - b._x).forEach((el, i) => {
      whenReady(el._img, () => setTimeout(() => el.classList.add('in'), Math.min(i, 12) * 70));
    });
    revealQueue = [];
  }, 16);
}, { rootMargin: '0px 0px 10% 0px' });

function layout(animate = false) {
  const grid = view.querySelector('.grid');
  if (!current || !grid) return;
  const width = grid.clientWidth;
  const small = width < 640;
  const gap = small ? 3 : 8;
  const target = small ? Math.max(120, width / 2.6) : Math.min(340, Math.max(220, width / 4.6));
  const { boxes, height } = justify(current.photos, width, target, gap);
  grid.classList.toggle('animate', animate);
  grid.style.height = `${height}px`;
  const shown = new Set();
  for (const b of boxes) {
    const el = current.tiles.get(b.p.h);
    shown.add(el);
    el.hidden = false;
    el.classList.remove('out');
    Object.assign(el.style, { width: `${b.w}px`, height: `${b.h}px`, transform: `translate(${b.x}px, ${b.y}px)` });
    el._x = b.x; el._y = b.y;
    el._img.sizes = `${Math.ceil(b.w)}px`;
    if (!el.classList.contains('in')) io.observe(el);
  }
  for (const el of current.tiles.values()) if (!shown.has(el)) { el.classList.add('out'); io.unobserve(el); }
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
  view.replaceChildren(h('section', { className: 'intro gate-intro' },
    h('h1', { className: 'wordmark' }, 'Lamha'),
    h('p', { className: 'urdu', lang: 'ur', dir: 'rtl' }, 'لمحہ'),
    note, button));
}

start();
