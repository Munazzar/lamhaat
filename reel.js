// Reel: one fixed frame on a dark stage. Photographs travel up through it like a reel: drag and they
// follow the finger, flick for the next one, fling hard and the reel races through several before it
// settles. Each photograph arrives in black and white and fills with colour grain by grain, like sand,
// as it comes to rest in the frame; it drains back to grey as it leaves.
// Everything moving is drawn in one WebGL canvas, so nothing is re-laid-out mid-motion and nothing flickers.
import { Spring, project, rubberband, reducedMotion } from './spring.js';

export const reelSupported = (() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
})();

const VERT = `#version 300 es
in vec2 a;
uniform vec4 rect;   // x, y, w, h in css px, y down
uniform vec2 view;   // canvas size in css px
out vec2 uv;
void main() {
  uv = a;
  vec2 p = (rect.xy + a * rect.zw) / view * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D tex;
uniform int mode;     // 0 shadow, 1 flat placeholder, 2 photograph
uniform vec2 size;    // rect size in css px
uniform float radius, fill, alpha, grain, seed, shade;
out vec4 o;
float hash(vec2 p) { p = fract(p * vec2(234.34, 435.345) + seed); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float box(vec2 q, vec2 hs, float r) { vec2 d = abs(q) - (hs - r); return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }
void main() {
  vec2 q = uv * size - size * 0.5;
  if (mode == 0) {                       // a soft contact shadow, drawn on a larger rect
    float d = box(q - vec2(0.0, size.y * 0.035), size * 0.5 / 1.18, radius);
    float s = 1.0 - smoothstep(-size.y * 0.02, size.y * 0.09, d);
    o = vec4(0.0, 0.0, 0.0, s * 0.34 * alpha);
    return;
  }
  float edge = clamp(0.5 - box(q, size * 0.5, radius), 0.0, 1.0);
  if (mode == 1) { o = vec4(vec3(shade), 1.0) * edge * alpha; return; }
  vec3 c = texture(tex, uv).rgb;
  float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // grains: one random threshold per tiny cell, nudged so the colour settles in from the bottom up
  float h = hash(floor(uv * size / grain)) * 0.84 + (1.0 - uv.y) * 0.16;
  float p = fill * 1.04;
  float on = step(h, p);
  float glint = on * (1.0 - smoothstep(0.0, 0.05, p - h)) * (1.0 - fill); // a grain sparkles as it lands
  vec3 col = mix(vec3(g), c, on) + glint * 0.22;
  o = vec4(col, 1.0) * edge * alpha;
}`;

let R = null; // the open reel

export function openReel({ photos, index = 0, src, title = '', onClose }) {
  if (R || !photos.length) return;
  const N = photos.length;
  const root = document.createElement('div');
  root.className = 'reel';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', `${title} reel`);
  root.innerHTML = `
    <div class="reel-halo" aria-hidden="true"></div>
    <div class="reel-frame"><canvas></canvas></div>
    <div class="reel-cap" aria-live="polite"><p class="reel-t"></p><p class="reel-n"></p></div>
    <button class="reel-close" type="button" aria-label="Close reel"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
    <p class="reel-hint" aria-hidden="true">Swipe up</p>`;
  document.body.append(root);
  const frameEl = root.querySelector('.reel-frame'), canvas = root.querySelector('canvas');
  const capT = root.querySelector('.reel-t'), capN = root.querySelector('.reel-n'), halo = root.querySelector('.reel-halo');
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) { root.remove(); return; }

  const S = R = {
    root, gl, photos, src, onClose, N,
    slides: photos.map(() => ({ fill: 0, show: 0, tex: null, level: 0, want: 0, loading: 0 })),
    W: 0, H: 0, dpr: 1, raf: 0, last: 0, closing: false, drag: null, lastShown: -1,
    floor: index, // while the first photo rises in, nothing above it is drawn
    pos: new Spring(index - 1.15, { damping: 1, response: 0.5, precision: 0.0004, onUpdate: () => wake() }),
    uploads: [], prog: null, quad: null, u: {},
  };
  const returnFocus = document.activeElement;
  document.documentElement.classList.add('viewing');

  // ---- GL setup ----
  function init() {
    const sh = (type, code) => { const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error('reel shader:', gl.getProgramInfoLog(prog), ...gl.getAttachedShaders(prog).map(x => gl.getShaderInfoLog(x)));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['rect', 'view', 'tex', 'mode', 'size', 'radius', 'fill', 'alpha', 'grain', 'seed', 'shade']) S.u[n] = gl.getUniformLocation(prog, n);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    S.prog = prog;
  }
  init();
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); S.slides.forEach(s => { s.tex = null; s.level = 0; s.loading = 0; }); S.uploads = []; });
  canvas.addEventListener('webglcontextrestored', () => { init(); wake(); });

  // ---- sizing ----
  const resize = () => {
    S.dpr = Math.min(devicePixelRatio || 1, 2.5);
    S.W = frameEl.clientWidth; S.H = frameEl.clientHeight; // layout size: the frame's opening zoom must not skew the canvas
    canvas.width = Math.round(S.W * S.dpr); canvas.height = Math.round(S.H * S.dpr);
    draw(); // redraw in the same frame the canvas was cleared, so a resize never blinks
  };
  const ro = new ResizeObserver(resize);

  // ---- textures: a small version first, the sharp one when the photo is close ----
  function want(i, level) {
    const s = S.slides[i];
    if (!s || s.level >= level || s.loading >= level) return;
    s.loading = level;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.src = src(level === 2 ? photos[i].v.md : photos[i].v.thumb);
    img.decode().then(() => { if (R === S) { S.uploads.push([i, level, img]); wake(); } }, () => { s.loading = s.level; });
  }
  function upload() {
    // one upload per frame keeps the main thread smooth while the reel is moving
    const job = S.uploads.shift();
    if (!job) return;
    const [i, level, img] = job, s = S.slides[i];
    if (s.level >= level) return;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (s.tex) gl.deleteTexture(s.tex);
    s.tex = t; s.level = level;
  }
  function manage(center) {
    const c = Math.round(center);
    for (let d = 0; d <= 8; d++) for (const i of [c + d, c - d]) if (i >= 0 && i < N) want(i, Math.abs(i - c) <= 2 ? 2 : 1);
    S.slides.forEach((s, i) => { // keep GPU memory small on phones
      const d = Math.abs(i - c);
      if (s.tex && d > 12) { gl.deleteTexture(s.tex); s.tex = null; s.level = 0; s.loading = 0; s.show = 0; }
    });
  }

  // ---- drawing ----
  const fit = p => {
    const pad = Math.min(S.W, S.H) * 0.07, aw = S.W - pad * 2, ah = S.H - pad * 2, k = Math.min(aw / p.w, ah / p.hgt);
    return [p.w * k, p.hgt * k];
  };
  function draw() {
    if (!S.W) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(S.u.view, S.W, S.H);
    const pos = S.pos.value, D = S.H;
    const lo = Math.max(0, Math.floor(pos - 1)), hi = Math.min(N - 1, Math.ceil(pos + 1));
    for (let i = Math.max(lo, S.floor); i <= hi; i++) {
      const s = S.slides[i], [w, h] = fit(photos[i]);
      const cx = S.W / 2, cy = S.H / 2 + (i - pos) * D;
      if (cy + h / 2 < -4 || cy - h / 2 > S.H + 4) continue;
      const x = cx - w / 2, y = cy - h / 2, r = Math.min(10, w * 0.02);
      gl.uniform1f(S.u.radius, r);
      gl.uniform1f(S.u.alpha, 1);
      // shadow
      gl.uniform1i(S.u.mode, 0);
      gl.uniform4f(S.u.rect, x - w * 0.09, y - h * 0.09, w * 1.18, h * 1.18);
      gl.uniform2f(S.u.size, w * 1.18, h * 1.18);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.uniform4f(S.u.rect, x, y, w, h);
      gl.uniform2f(S.u.size, w, h);
      // placeholder until the photograph is on the GPU, then the photograph fades in over it
      if (s.show < 1) {
        gl.uniform1i(S.u.mode, 1);
        gl.uniform1f(S.u.shade, photos[i]._g ??= luminance(photos[i]));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      if (s.tex && s.show > 0) {
        gl.uniform1i(S.u.mode, 2);
        gl.uniform1f(S.u.alpha, s.show);
        gl.uniform1f(S.u.fill, s.fill);
        gl.uniform1f(S.u.grain, 1.8); // css px per grain
        gl.uniform1f(S.u.seed, (i * 0.618) % 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.uniform1i(S.u.tex, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
  }

  // ---- the loop: runs only while something is moving or filling ----
  function wake() { if (!S.raf && R === S) { S.last = performance.now(); S.raf = requestAnimationFrame(tick); } }
  function tick(t) {
    S.raf = 0;
    const dt = Math.min(0.05, (t - S.last) / 1000 || 0.016); S.last = t;
    upload();
    const pos = S.pos.value;
    manage(pos);
    let busy = S.uploads.length > 0 || S.pos.moving || !!S.drag;
    S.slides.forEach((s, i) => {
      const off = Math.abs(i - pos);
      if (off > 2.5 && s.fill === 0) return;
      // colour follows how settled the photo is in the frame: slowly in, quicker out
      const target = Math.max(0, Math.min(1, 1 - off * 1.6));
      const rate = reducedMotion.matches ? 99 : target > s.fill ? 0.62 : 2.4;
      const next = target > s.fill ? Math.min(target, s.fill + rate * dt) : Math.max(target, s.fill - rate * dt);
      if (next !== s.fill) { s.fill = next; busy = true; }
      if (s.tex && s.show < 1) { s.show = Math.min(1, s.show + dt / 0.28); busy = true; }
    });
    caption(Math.round(Math.max(0, Math.min(N - 1, pos))));
    draw();
    if (busy) wake();
  }

  function caption(i) {
    if (i === S.lastShown) return;
    S.lastShown = i;
    const p = photos[i];
    capT.textContent = p.title || '';
    capN.textContent = `${String(i + 1).padStart(2, '0')} / ${String(N).padStart(2, '0')}`;
    const [r, g, b] = p._rgb ??= rgbOf(p);
    halo.style.backgroundColor = `rgb(${r} ${g} ${b})`;
  }

  // ---- moving ----
  const go = (target, velocity = 0) => {
    if (Math.round(target) !== S.floor) S.floor = 0;
    target = Math.max(0, Math.min(N - 1, target));
    const dist = Math.abs(target - S.pos.value);
    S.pos.to(target, { velocity, damping: 1, response: Math.min(1.1, 0.46 + dist * 0.07) });
    if (target > 0) root.classList.add('moved');
  };
  const D = () => S.H || 1;

  root.addEventListener('pointerdown', e => {
    if (e.target.closest('.reel-close') || e.button > 0) return;
    try { root.setPointerCapture(e.pointerId); } catch {}
    S.pos.stop();
    S.floor = 0;
    S.drag = { y: e.clientY, start: S.pos.value, from: Math.round(S.pos.value), samples: [{ y: e.clientY, t: e.timeStamp }] };
    wake();
  });
  root.addEventListener('pointermove', e => {
    const d = S.drag; if (!d) return;
    let v = d.start - (e.clientY - d.y) / D();
    if (v < 0) v = -rubberband(-v * D(), D()) / D();
    if (v > N - 1) v = N - 1 + rubberband((v - (N - 1)) * D(), D()) / D();
    S.pos.value = S.pos.target = v; S.pos.velocity = 0;
    d.samples.push({ y: e.clientY, t: e.timeStamp }); if (d.samples.length > 8) d.samples.shift();
    wake();
  });
  const release = e => {
    const d = S.drag; if (!d) return;
    S.drag = null;
    const recent = d.samples.filter(s => e.timeStamp - s.t < 100);
    const pxv = recent.length > 1 ? (recent.at(-1).y - recent[0].y) / Math.max(1, recent.at(-1).t - recent[0].t) * 1000 : 0; // px/s, + is down
    const v = -pxv / D(); // slides per second
    let target = Math.round(S.pos.value - project(pxv) / D());
    // a quick flick always moves at least one, like a reel; a long fling travels as far as it was thrown
    if (target === d.from && Math.abs(pxv) > 260) target = d.from + Math.sign(v);
    if (Math.abs(target - d.from) > 1 && Math.abs(pxv) < 900) target = d.from + Math.sign(target - d.from);
    go(target, v);
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);

  let wheelLock = 0, wheelIdle = 0;
  root.addEventListener('wheel', e => {
    e.preventDefault();
    clearTimeout(wheelIdle);
    wheelIdle = setTimeout(() => { wheelLock = 0; }, 160);
    if (wheelLock || Math.abs(e.deltaY) < 4) return;
    wheelLock = 1;
    go(Math.round(S.pos.target) + Math.sign(e.deltaY));
  }, { passive: false });

  const key = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (['ArrowDown', 'PageDown', ' ', 'j'].includes(e.key)) { e.preventDefault(); go(Math.round(S.pos.target) + 1); }
    else if (['ArrowUp', 'PageUp', 'k'].includes(e.key)) { e.preventDefault(); go(Math.round(S.pos.target) - 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(N - 1);
    else if (e.key === 'Tab') { e.preventDefault(); root.querySelector('.reel-close').focus(); }
  };
  addEventListener('keydown', key);
  root.querySelector('.reel-close').addEventListener('click', () => close());

  // the phone's back gesture closes the reel instead of leaving the album
  history.pushState({ reel: true }, '', location.href);
  const pop = () => close(true);
  addEventListener('popstate', pop);

  function close(fromHistory = false) {
    if (S.closing) return;
    S.closing = true;
    removeEventListener('keydown', key);
    removeEventListener('popstate', pop);
    if (!fromHistory && history.state?.reel) history.back();
    root.classList.remove('on');
    const done = () => {
      ro.disconnect();
      cancelAnimationFrame(S.raf); S.raf = 0;
      S.pos.stop();
      S.slides.forEach(s => s.tex && gl.deleteTexture(s.tex));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      root.remove();
      document.documentElement.classList.remove('viewing');
      R = null;
      returnFocus?.focus?.({ preventScroll: true });
      onClose?.();
    };
    reducedMotion.matches ? done() : setTimeout(done, 480);
  }

  // ---- open ----
  ro.observe(frameEl);
  resize();
  manage(index);
  caption(index);
  requestAnimationFrame(() => {
    root.classList.add('on');
    // the first photograph rises into the frame from below
    S.pos.to(index, { damping: 1, response: 0.62, onRest: () => { S.floor = 0; } });
  });
  root.querySelector('.reel-close').focus({ preventScroll: true });
}

// Average colour and brightness from the blurhash's DC term, for the halo and the placeholder.
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
function rgbOf(p) {
  try {
    let v = 0;
    for (const c of p.blurhash.slice(2, 6)) v = v * 83 + CHARS.indexOf(c);
    return [v >> 16, (v >> 8) & 255, v & 255];
  } catch { return [60, 60, 64]; }
}
function luminance(p) { const [r, g, b] = rgbOf(p); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
