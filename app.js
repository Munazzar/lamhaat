import { decode } from './vendor/blurhash.js?v=mvvkr5we';
import * as data from './data.js?v=mvvkr5we';
import * as auth from './auth.js?v=mvvkr5we';
import { openViewer, closeViewer } from './viewer.js?v=mvvkr5we';
import './mesh.js?v=mvvkr5we';
import { openReel, reelSupported } from './reel.js?v=mvvkr5we';

const view = document.getElementById('view');
const bar = document.getElementById('bar');
const back = bar.querySelector('.back');
const barTitle = bar.querySelector('.bar-title');
const search = bar.querySelector('.search');
const searchInput = search.querySelector('input');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// Night and day. The new theme spreads from the button in a circle while the icon's sun sets and moon rises.
const themeBtn = document.querySelector('.theme');
function setTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#111110' : '#e8e6e1';
  themeBtn.setAttribute('aria-label', next === 'dark' ? 'Switch to day' : 'Switch to night');
}
setTheme(document.documentElement.dataset.theme || 'light');
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  if (!document.startViewTransition || reduced.matches) return setTheme(next);
  // Percentages, not px: the transition snapshot can be scaled on high-density screens, so px would land off the button.
  const r = themeBtn.getBoundingClientRect(), W = innerWidth, H = innerHeight;
  const x = r.left + r.width / 2, y = r.top + r.height / 2, at = `at ${(x / W) * 100}% ${(y / H) * 100}%`;
  const end = (Math.hypot(Math.max(x, W - x), Math.max(y, H - y)) / (Math.hypot(W, H) / Math.SQRT2)) * 100; // % of the reference radius
  document.documentElement.classList.add('theming');
  const t = document.startViewTransition(() => setTheme(next));
  t.ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0% ${at})`, `circle(${end}% ${at})`] },
    { duration: 1300, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
  t.finished.finally(() => document.documentElement.classList.remove('theming'));
});

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
  // Tapping a card opens the photo right here, growing out of the card, rather than navigating first
  // (a page swap under an opening photo is what made it flicker). The phone's back gesture closes it.
  const homePhotos = [...pool].sort((x, y) => (x.n ?? 0) - (y.n ?? 0));
  const cardOf = new Map(ringPhotos.map((p, i) => [p.h, cards[i]]));
  cards.forEach((card, i) => card.addEventListener('click', e => {
    e.preventDefault();
    const pop = () => { removeEventListener('popstate', pop); closeViewer(true); };
    history.pushState({ viewer: true }, '', location.href);
    addEventListener('popstate', pop);
    openViewer({
      photos: homePhotos, index: homePhotos.indexOf(ringPhotos[i]), from: card,
      tileFor: p => (c => c && c.style.visibility !== 'hidden' ? c : null)(cardOf.get(p.h)),
      onIndex: () => {}, fmtDate,
      onClose: () => { removeEventListener('popstate', pop); if (history.state?.viewer) history.back(); },
    });
  }));
  const headline = h('h1', { className: 'headline' },
    h('span', { className: 'w' }, 'Every'), ' ', h('span', { className: 'w' }, 'moment,'), ' ', h('em', { className: 'w' }, 'kept.'));
  const cine = h('section', { className: 'stagehead' },
    h('p', { className: 'mono kicker' }, `Lamhaat — ${total} photographs`),
    headline,
    stage,
    h('div', { className: 'ctas' },
      first ? h('a', { className: 'btn accent', href: `#/a/${first.id}` }, 'Enter the portfolio') : null,
      h('a', { className: 'btn ghost', href: '#albums', onclick: e => { e.preventDefault(); view.querySelector('.albums')?.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth' }); } }, 'All albums')),
    h('p', { className: 'mono hint', 'aria-hidden': 'true' }, 'drag to turn'));
  spin(stage, cards);
  if (slides[0]) ambient(avg(slides[0].blurhash));

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

  // 4. albums: on shelves, as gallery walls, or as a plain list. The switch remembers your choice.
  const [shelf, wall] = await Promise.all([shelves(albums), walls(albums)]);
  const index = h('section', { className: 'index' },
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

  const views = { shelves: ['Shelves', shelf], wall: ['Wall', wall], list: ['List', index] };
  let mode = 'shelves';
  try { mode = views[localStorage.getItem('albumsView')] ? localStorage.getItem('albumsView') : mode; } catch {}
  const seg = h('div', { className: 'seg', role: 'group', 'aria-label': 'Show albums as' },
    Object.entries(views).map(([k, [label]]) => h('button', { type: 'button', 'aria-pressed': String(k === mode), onclick: () => show(k) }, label)));
  const paint = () => {
    for (const [k, [, el]] of Object.entries(views)) el.hidden = k !== mode;
    [...seg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(views)[i] === mode)));
  };
  const show = k => {
    if (k === mode) return;
    try { localStorage.setItem('albumsView', k); } catch {}
    transition(() => { mode = k; paint(); });
  };
  paint();
  const list = h('section', { className: 'albums' }, h('div', { className: 'albums-head' }, h('h2', { className: 'eyebrow' }, 'Albums'), seg), shelf, wall, index);

  view.replaceChildren(cine, scatter, list);
  if (auth.user()) view.append(h('button', { className: 'quiet', type: 'button', onclick: () => auth.signOut().then(() => location.replace(location.pathname)) }, 'Sign out'));
  parallax(floats);
  reveal(view.querySelectorAll('.spot, .shelf-head, .plaque, .row, .eyebrow'));
  watchBar(headline, 'Lamhaat');
}

// Cards sit on the inside of a cylinder, so the edges lean toward you. Drag to turn it; a flick
// keeps spinning and eases back to a slow drift.
function spin(stage, cards) {
  const N = cards.length;
  if (!N) return;
  const drift = reduced.matches ? 0 : -4; // degrees per second
  // On a phone the cylinder is tighter than the full ring would be, so the curve stays visible with big
  // cards: the cards then run along a longer strip that wraps around (L degrees) rather than one circle.
  let W, R, Z0, P, spacing, L, angle = 0, vel = drift, raf = 0, last = 0, drag = null, moved = false;
  const size = () => {
    const phone = innerWidth < 700;
    W = phone ? innerWidth * 0.6 : Math.min(320, Math.max(150, innerWidth * 0.2));
    const ring = ((W * 1.18) * N) / (2 * Math.PI);
    R = phone ? Math.min(ring, innerWidth * 0.95) : ring;
    spacing = R < ring ? (W * 1.12 / R) * (180 / Math.PI) : 360 / N;
    L = spacing * N;
    Z0 = R * 0.9; P = R * 1.0;
    stage.style.perspective = `${P}px`;
    stage.style.height = `${W * 1.33 * 1.75}px`;
    for (const c of cards) Object.assign(c.style, { width: `${W}px`, height: `${W * 1.33}px`, marginLeft: `${-W / 2}px`, marginTop: `${-W * 0.665}px` });
  };
  const place = () => {
    cards.forEach((c, i) => {
      let a = (((i * spacing + angle) % L) + L) % L; if (a >= L / 2) a -= L;
      const r = (a * Math.PI) / 180, x = R * Math.sin(r), z = Z0 - R * Math.cos(r);
      const visible = Math.abs(a) < 88 && z < P * 0.62;
      c.style.visibility = visible ? 'visible' : 'hidden';
      if (!visible) return;
      c.style.transform = `translate3d(${x.toFixed(1)}px,0,${z.toFixed(1)}px) rotateY(${(-a).toFixed(2)}deg)`;
      c.style.opacity = Math.min(1, (P * 0.62 - z) / (P * 0.25)).toFixed(3);
    });
  };
  let onScreen = true;
  const frame = t => {
    const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    if (!drag) { angle += vel * dt; vel = drift + (vel - drift) * Math.exp(-dt * 1.6); }
    place();
    const idle = !onScreen || document.documentElement.classList.contains('viewing');
    raf = stage.isConnected && !idle ? requestAnimationFrame(frame) : 0;
  };
  const resume = () => { if (!raf && stage.isConnected) raf = requestAnimationFrame(t => { last = t; frame(t); }); };
  const seen = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) resume(); });
  seen.observe(stage);
  const afterView = new MutationObserver(() => { if (!document.documentElement.classList.contains('viewing')) resume(); });
  afterView.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  cleanup.push(() => { seen.disconnect(); afterView.disconnect(); });
  size(); place();
  resume();
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
  stage.addEventListener('click', e => { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
  addEventListener('resize', size);
  cleanup.push(() => { cancelAnimationFrame(raf); removeEventListener('resize', size); });
}

// Elements rise into place the first time they scroll into view.
function reveal(els) {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach(el => { el.classList.add('rv'); io.observe(el); });
  cleanup.push(() => io.disconnect());
}

// Chapters: each photo lands in the first chapter whose tags it shares; a tagless chapter catches the rest.
function chaptersOf(manifest, entry) {
  const ordered = [...manifest.photos].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const defs = manifest.chapters?.length ? manifest.chapters : [{ title: entry.title, sub: '', tags: [] }];
  const chapters = defs.map(d => ({ ...d, photos: [] }));
  for (const p of ordered) (chapters.find(c => !c.tags.length || c.tags.some(t => p.tags?.includes(t))) || chapters.at(-1)).photos.push(p);
  return { ordered, used: chapters.filter(c => c.photos.length) };
}

// ---------- shelves ----------
// Every album is a shelf; its chapters stand on it like editions. Covers pop in as the shelf scrolls
// sideways. Tap one and it comes off the shelf to the middle of the screen, where it can flip over
// to show what is inside, or open.
let pendingChapter = null; // set by "Open" so the album lands on that chapter

async function shelves(albums) {
  const loaded = (await Promise.all(albums.map(a => data.album(a).then(m => ({ a, m }), () => null)))).filter(Boolean);
  const shelvesEl = loaded.map(({ a, m }, si) => {
    const hi = new Set(m.highlights || []);
    const books = chaptersOf(m, a).used.map((c, ci) => {
      const cover = c.photos.find(p => hi.has(p.src)) || c.photos[0];
      const img = h('img', { alt: '', decoding: 'async', loading: 'lazy', draggable: false, src: data.src(cover.v.md, a.id) });
      const book = h('button', { className: 'book', type: 'button', 'aria-label': `${c.title}, ${c.photos.length} photographs` },
        h('span', { className: 'face' }, blurCanvas(cover.blurhash, 16, 16), img,
          h('span', { className: 'b-title' }, h('em', {}, ROMAN[ci]), c.title)));
      whenReady(img, () => book.classList.add('ready'));
      book.addEventListener('click', () => pull(book, { album: a, chapter: c, index: ci, cover, img }));
      return book;
    });
    return h('section', { className: 'shelf', id: `shelf-${a.id}` },
      h('header', { className: 'shelf-head' },
        h('span', { className: 'num' }, pad(si + 1)),
        h('h3', {}, a.title),
        h('span', { className: 'meta' }, `${years(a)}  ·  ${a.count} photographs`)),
      h('div', { className: 'track' }, books));
  });
  const go = a => e => { e.preventDefault(); document.getElementById(`shelf-${a.id}`)?.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'center' }); };
  const timeline = h('nav', { className: 'timeline', 'aria-label': 'Albums by year' },
    loaded.map(({ a }) => h('a', { href: `#shelf-${a.id}`, onclick: go(a) }, h('span', {}, years(a)), h('b', {}, a.title))));
  return h('section', { className: 'shelves' }, shelvesEl, timeline);
}

const SIZES = [1.25, 0.9, 1.05, 0.8, 1.15, 0.85, 1, 0.95]; // a salon hang mixes sizes

async function walls(albums) {
  const loaded = (await Promise.all(albums.map(a => data.album(a).then(m => ({ a, m }), () => null)))).filter(Boolean);
  const pendulums = [];
  const wallsEl = loaded.map(({ a, m }, wi) => {
    const hi = new Set(m.highlights || []);
    const frames = chaptersOf(m, a).used.map((c, ci) => {
      const cover = c.photos.find(p => hi.has(p.src)) || c.photos[0];
      const img = h('img', { alt: '', decoding: 'async', loading: 'lazy', draggable: false, src: data.src(cover.v.md, a.id) });
      const pic = h('span', { className: 'pic' }, blurCanvas(cover.blurhash, 16, 16), img);
      pic.style.aspectRatio = `${cover.w} / ${cover.hgt}`;
      const cord = document.createRange().createContextualFragment('<svg class="cord" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path d="M6 40 50 2 94 40" /></svg>');
      const swing = h('span', { className: 'swing' }, cord, h('span', { className: 'frame' }, h('span', { className: 'mat' }, pic)));
      const hang = h('button', { className: 'hang', type: 'button', 'aria-label': `${c.title}, ${c.photos.length} photographs` },
        h('span', { className: 'nail', 'aria-hidden': 'true' }), swing,
        h('span', { className: 'label' }, h('em', {}, ROMAN[ci]), h('b', {}, c.title), h('span', {}, `${c.photos.length} photographs`)));
      hang.style.setProperty('--w', SIZES[ci % SIZES.length]);
      hang.style.setProperty('--drop', `${[0, 38, 12, 54, 6, 30, 46, 18][ci % 8]}px`);
      whenReady(img, () => hang.classList.add('ready'));
      const pend = { el: swing, base: ((ci * 37) % 7 - 3) * 0.45, a: 0, v: 0 }; // each hangs a touch crooked
      pend.a = pend.base;
      swing.style.rotate = `${pend.base}deg`;
      pendulums.push(pend);
      hang.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') kick(pend, (e.movementX || 4) * 0.35); });
      hang.addEventListener('click', () => pull(swing.querySelector('.frame'), { album: a, chapter: c, index: ci, cover, img }));
      return hang;
    });
    return h('section', { className: 'wall', id: `wall-${a.id}` },
      h('header', { className: 'plaque' },
        h('span', { className: 'num' }, pad(wi + 1)),
        h('h3', {}, a.title),
        h('span', { className: 'meta' }, `${years(a)}  ·  ${a.count} photographs`)),
      h('div', { className: 'hangs' }, frames));
  });
  swayLoop(pendulums);
  return h('section', { className: 'walls' }, wallsEl);
}

// Pendulums: a lightly damped spring around each frame's resting tilt. The loop sleeps when everything is still.
let swayRaf = 0, swayWake = null;
function kick(p, dv) { if (reduced.matches) return; p.v += dv; swayWake?.(); }
function swayLoop(ps) {
  if (reduced.matches || !ps.length) return;
  const w = (2 * Math.PI) / 1.7, zeta = 0.07; // about 1.7s a swing, settles over several seconds
  let last = 0, lastY = scrollY;
  const step = t => {
    const dt = Math.min(0.033, (t - last) / 1000 || 0.016); last = t;
    let moving = false;
    for (const p of ps) {
      p.v += (-w * w * (p.a - p.base) - 2 * zeta * w * p.v) * dt;
      p.a += p.v * dt;
      p.el.style.rotate = `${p.a.toFixed(3)}deg`;
      if (Math.abs(p.v) > 0.02 || Math.abs(p.a - p.base) > 0.02) moving = true;
    }
    swayRaf = moving && ps[0].el.isConnected ? requestAnimationFrame(step) : 0;
  };
  swayWake = () => { if (!swayRaf) { last = performance.now(); swayRaf = requestAnimationFrame(step); } };
  // scrolling jostles the wall: frames swing against the direction of travel, each a little differently
  const onScroll = () => {
    const dy = scrollY - lastY; lastY = scrollY;
    if (!ps[0].el.getClientRects().length) return; // the wall view isn't showing
    ps.forEach((p, i) => kick(p, Math.max(-6, Math.min(6, -dy * 0.05 * (0.7 + ((i * 13) % 5) / 8)))));
  };
  addEventListener('scroll', onScroll, { passive: true });
  cleanup.push(() => { removeEventListener('scroll', onScroll); cancelAnimationFrame(swayRaf); swayRaf = 0; swayWake = null; });
}

function pull(book, { album, chapter, index, cover, img }) {
  const from = book.getBoundingClientRect();
  const backFace = h('div', { className: 'pb-back' },
    h('p', { className: 'mono' }, `${album.title}  ·  ${ROMAN[index]}`),
    h('h3', {}, chapter.title),
    chapter.sub ? h('p', { className: 'sub' }, chapter.sub) : null,
    h('ol', {}, chapter.photos.slice(0, 12).map(p => h('li', {}, p.title || p.src))),
    chapter.photos.length > 12 ? h('p', { className: 'mono more' }, `and ${chapter.photos.length - 12} more`) : null);
  const front = h('div', { className: 'pb-front' }, blurCanvas(cover.blurhash, 16, 16), h('img', { alt: '', src: img.currentSrc || img.src }),
    h('span', { className: 'b-title' }, h('em', {}, ROMAN[index]), chapter.title));
  const card = h('div', { className: 'pb-card' }, front, backFace);
  const flip = h('button', { className: 'pill-btn', type: 'button' }, 'Flip');
  const openBtn = h('button', { className: 'pill-btn dark', type: 'button' }, 'Open');
  const layer = h('div', { className: 'pullout', role: 'dialog', 'aria-modal': 'true', 'aria-label': chapter.title },
    h('div', { className: 'pb-stage' }, card), h('div', { className: 'pb-actions' }, flip, openBtn));
  document.body.append(layer);
  book.classList.add('lifted');

  const offset = (a, b) => `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${a.width / b.width})`;
  if (!reduced.matches) card.animate([{ transform: offset(from, card.getBoundingClientRect()) }, { transform: 'none' }], { duration: 760, easing: 'cubic-bezier(0.2, 1.15, 0.3, 1)' });
  requestAnimationFrame(() => layer.classList.add('on'));
  flip.focus({ preventScroll: true });

  const finish = () => { removeEventListener('keydown', key); layer.remove(); book.classList.remove('lifted'); };
  const close = () => {
    layer.classList.remove('on');
    card.classList.remove('flipped');
    if (reduced.matches) return finish();
    card.animate([{ transform: 'none' }, { transform: offset(book.getBoundingClientRect(), card.getBoundingClientRect()) }],
      { duration: 520, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).finished.then(() => { finish(); book.focus({ preventScroll: true }); });
  };
  const key = e => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', key);
  layer.addEventListener('click', e => { if (e.target === layer || e.target.classList.contains('pb-stage')) close(); });
  flip.onclick = card.onclick = () => card.classList.toggle('flipped');
  openBtn.onclick = () => { pendingChapter = index; finish(); location.hash = `#/a/${album.id}`; };
  cleanup.push(() => layer.isConnected && finish());
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

  const { ordered, used } = chaptersOf(manifest, entry);

  if (entry.cover) ambient(avg(entry.cover.blurhash));

  const toc = h('ol', { className: 'toc' }, used.map((c, i) =>
    h('li', {}, h('button', { type: 'button', onclick: () => c.el.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth' }) },
      h('span', { className: 'rn' }, ROMAN[i]), h('span', { className: 't' }, c.title), h('span', { className: 'c' }, String(c.photos.length))))));

  const tagCounts = new Map();
  for (const p of ordered) for (const t of p.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = [...tagCounts].filter(([, n]) => n > 2 && n < ordered.length).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t]) => t);
  const chips = h('div', { className: 'chips', role: 'group', 'aria-label': 'Filter by subject' },
    ['All', ...topTags].map((t, i) => h('button', { className: 'chip', type: 'button', 'aria-pressed': String(i === 0) }, t)));

  current = { entry, chapters: used, photos: ordered, tiles: new Map(), grid: false };
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

  // Reel: the album one photograph at a time, travelling up through a fixed frame.
  function reelBtn() {
    return reelSupported ? h('button', { className: 'btn ghost', type: 'button', onclick: () => openReel({ photos: current.photos, index: 0, src: v => data.src(v, id), title: entry.title }) }, 'Reel') : null;
  }
  // It opens like the home page: a ribbon of the album's photographs. "Expand into grid" lays them all out.
  const step = Math.max(1, Math.floor(ordered.length / 30));
  const ringPhotos = ordered.filter((_, i) => i % step === 0).slice(0, 30);
  const cards = new Map(ringPhotos.map(p => {
    const img = h('img', { alt: '', decoding: 'async', draggable: false, src: data.src(p.v.thumb, id) });
    const card = h('button', { className: 'card3d', type: 'button', 'aria-label': p.title || 'Photo' }, blurCanvas(p.blurhash, 16, 16), img);
    card.addEventListener('click', () => open(current.photos.indexOf(p), card));
    whenReady(img, () => card.classList.add('ready'));
    return [p.h, card];
  }));
  const ribbon = h('div', { className: 'ribbon' }, [...cards.values()]);
  const title = h('h1', { className: 'headline' }, entry.title);
  const stage = h('section', { className: 'stagehead' },
    h('p', { className: 'mono kicker' }, `${years(entry)}  ·  ${entry.count} photographs`),
    title,
    ribbon,
    h('div', { className: 'ctas' },
      h('button', { className: 'btn accent', type: 'button', onclick: () => setMode(true) }, 'Expand into grid'),
      reelBtn(),
      h('a', { className: 'btn ghost', href: '#/' }, 'All albums')),
    h('p', { className: 'mono hint', 'aria-hidden': 'true' }, 'drag to turn  ·  tap to open'));
  spin(ribbon, [...cards.values()]);

  const gridView = h('div', { className: 'gridview', hidden: true },
    h('div', { className: 'gridtop' },
      h('h1', { className: 'gridtitle' }, entry.title),
      h('div', { className: 'ctas tight' }, reelBtn(), h('button', { className: 'btn ghost', type: 'button', onclick: () => setMode(false) }, 'Back to ribbon'))),
    h('section', { className: 'contents' }, h('p', { className: 'eyebrow' }, 'Contents'), toc),
    chips,
    ...sections,
    h('p', { className: 'empty', hidden: true }, 'No photographs match.'));
  view.replaceChildren(stage, gridView);

  // The viewer flies back to whatever the photo is showing as right now: its tile, or its card if it's on the ribbon.
  current.tileFor = p => current.grid ? current.tiles.get(p.h) : (c => c?.style.visibility !== 'hidden' ? c : null)(cards.get(p.h));
  const setMode = grid => transition(() => {
    current.grid = grid;
    stage.hidden = grid; gridView.hidden = !grid; search.hidden = !grid;
    scrollTo(0, 0);
    if (grid) { layout(); reveal(view.querySelectorAll('.contents, .ch-head')); }
    watchBar(grid ? gridView.querySelector('.gridtitle') : title, entry.title);
  });
  search.hidden = true;
  watchBar(title, entry.title);
  if (pendingChapter != null) {
    const c = used[pendingChapter]; pendingChapter = null;
    current.grid = true; stage.hidden = true; gridView.hidden = false; search.hidden = false;
    layout(); reveal(view.querySelectorAll('.contents, .ch-head'));
    watchBar(gridView.querySelector('.gridtitle'), entry.title);
    requestAnimationFrame(() => c?.el.scrollIntoView({ behavior: 'instant', block: 'start' }));
  }

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

// Masonry: every photo keeps its full frame and drops into the shortest column.
function masonry(photos, width, cols, gap) {
  const w = (width - gap * (cols - 1)) / cols, tops = Array(cols).fill(0), out = [];
  for (const p of photos) {
    const c = tops.indexOf(Math.min(...tops)), hgt = w * (p.hgt / p.w);
    out.push({ p, x: c * (w + gap), y: tops[c], w, h: hgt });
    tops[c] += hgt + gap;
  }
  return { boxes: out, height: Math.max(0, Math.max(...tops) - gap) };
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
  const gap = small ? 4 : 12;
  const cols = small ? 2 : width < 1100 ? 3 : 4;
  current.photos = [];
  for (const c of current.chapters) {
    const shown = c.shown || c.photos;
    current.photos.push(...shown);
    c.el.hidden = !shown.length;
    const { boxes, height } = masonry(shown, width, cols, gap);
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
    tileFor: current.tileFor,
    onIndex: p => history.replaceState({ viewer: true }, '', `#/a/${current.entry.id}/${p.h}`),
    onClose: () => { if (history.state?.viewer) history.back(); else history.replaceState(null, '', `#/a/${current.entry.id}`); },
    fmtDate,
  });
}
function openFromHash(hsh) {
  const i = current?.photos.findIndex(p => p.h === hsh);
  if (i >= 0) openViewer({ photos: current.photos, index: i, from: null, tileFor: current.tileFor,
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
    try { who = await data.me(); } catch (err) { return view.replaceChildren(message('Lamhaat is not reachable right now.', err.message)); }
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
    h('h1', { className: 'giant solo' }, 'Lamhaat'),
    h('p', { className: 'urdu' , lang: 'ur', dir: 'rtl' }, 'لمحات'),
    note, button));
}

start();
