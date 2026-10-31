// Where the gallery gets catalog, manifests and image URLs.
// Public albums always come from next to the site (GitHub Pages; or the export staging folder via
// scripts/dev.js). Private albums come from the Cloudflare Worker once a viewer has signed in with
// Google and is on the owner's list (config.json names the Worker; without it there are only public albums).
import { idToken, user } from './auth.js?v=ac50462a3d';

const MEDIA = 'media'; // relative: works at / locally and under /lamhaat/ on Pages
const TOKEN_TTL = 50 * 60e3; // album tokens last 1 h; refresh before that
let cfg = null;
const tokens = new Map(); // albumId -> { t, at }
const albums = new Map();
const viaWorker = new Set(); // albums that come through the Worker (private ones)
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

// the public albums, plus the private ones this viewer may see; `who` says whether they are on the list
export async function catalog() {
  const res = await fetch(`${MEDIA}/lamha-catalog/catalog.json`, { cache: 'no-cache' }).catch(() => null);
  const pub = res?.ok ? await res.json() : { schema: 1, albums: [] };
  if (!cfg || !user()) { if (!res?.ok && !cfg) throw new Error('catalog unavailable'); return { ...pub, who: null }; }
  let who = null, mine = [];
  try {
    who = await me();
    if (who.owner || who.groups.length) {
      const cat = await api('/catalog');
      for (const a of cat.albums) if (a.token) tokens.set(a.id, { t: a.token, at: Date.now() });
      mine = cat.albums.filter(a => !pub.albums.some(p => p.id === a.id));
    }
  } catch (err) { who = { error: err.message }; }
  viaWorker.clear(); for (const a of mine) viaWorker.add(a.id);
  return { ...pub, albums: [...pub.albums, ...mine.map(a => ({ ...a, private: true }))], who };
}

export async function album(entry) {
  currentAlbum = entry.id;
  const worker = viaWorker.has(entry.id);
  const fresh = !worker || Date.now() - (tokens.get(entry.id)?.at || 0) < TOKEN_TTL;
  if (!albums.has(entry.id) || !fresh) {
    const p = (worker
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
export const src = (v, albumId = currentAlbum) => viaWorker.has(albumId)
  ? `${cfg.worker}/img/${albumId}/${v.blob}.avif?t=${tokens.get(albumId)?.t}`
  : `${MEDIA}/${v.repo}/${v.path}`;
