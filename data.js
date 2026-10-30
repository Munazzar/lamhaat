// Where the gallery gets catalog, manifests and image URLs.
// Live (config.json present): the Cloudflare Worker, with the viewer's Firebase ID token.
// Static (no config.json): public albums next to the site (GitHub Pages), or the export staging folder via scripts/dev.js.
import { idToken } from './auth.js';

const MEDIA = 'media'; // relative: works at / locally and under /lamhaat/ on Pages
const TOKEN_TTL = 50 * 60e3; // album tokens last 1 h; refresh before that
let cfg = null;
const tokens = new Map(); // albumId -> { t, at }
const albums = new Map();
let currentAlbum = null;

export async function config() {
  try { const r = await fetch('config.json', { cache: 'no-cache' }); if (r.ok) { const c = await r.json(); if (c.worker) cfg = c; } } catch {}
  return cfg;
}

async function api(path) {
  const r = await fetch(cfg.worker + path, { headers: { authorization: `Bearer ${await idToken()}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `request failed (${r.status})`), { status: r.status });
  return body;
}

export const me = () => api('/me');

export async function catalog() {
  if (!cfg) {
    const res = await fetch(`${MEDIA}/lamha-catalog/catalog.json`);
    if (!res.ok) throw new Error('catalog unavailable');
    return res.json();
  }
  const cat = await api('/catalog');
  for (const a of cat.albums) if (a.token) tokens.set(a.id, { t: a.token, at: Date.now() });
  return cat;
}

export async function album(entry) {
  currentAlbum = entry.id;
  const fresh = !cfg || Date.now() - (tokens.get(entry.id)?.at || 0) < TOKEN_TTL;
  if (!albums.has(entry.id) || !fresh) {
    const p = (cfg
      ? api(`/album/${entry.id}`).then(({ manifest, token }) => { tokens.set(entry.id, { t: token, at: Date.now() }); return manifest; })
      : fetch(`${MEDIA}/${entry.repos[0]}/manifest.json`).then(r => { if (!r.ok) throw new Error('album unavailable'); return r.json(); })
    ).then(m => {
      if (m.schema !== 1) throw new Error(`This album needs a newer version of Lamha (schema ${m.schema}).`);
      return m;
    });
    p.catch(() => albums.delete(entry.id));
    albums.set(entry.id, p);
  }
  return albums.get(entry.id);
}

// ponytail: image links already on the page keep their 1 h token; reopening the album refreshes them.
export const src = (v, albumId = currentAlbum) => cfg
  ? `${cfg.worker}/img/${albumId}/${v.blob}.avif?t=${tokens.get(albumId)?.t}`
  : `${MEDIA}/${v.repo}/${v.path}`;
