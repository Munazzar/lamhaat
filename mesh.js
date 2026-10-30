// The dot grid behind everything, as a live mesh. Dots lean away from the pointer and thread together where they
// stretch; a click on empty background bursts them into dust that drifts and settles home; scrolling slides the
// grid a little slower than the page and sends a faint ripple through it.
const S = 22;            // grid spacing, px
const R = 120;           // pointer reach
const BURST = 180;       // click reach
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const root = document.documentElement;

const cv = document.createElement('canvas');
cv.className = 'mesh';
cv.setAttribute('aria-hidden', 'true');
document.body.prepend(cv);
const ctx = cv.getContext('2d');

// per dot: home x, home y, x, y, vx, vy, dust (1 = just burst, 0 = settled)
let W, H, cols, rows, d, dpr, dot = '', accent = '', px = -1e4, py = -1e4, prevOff = 0;

function build() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  cols = Math.ceil(W / S) + 1; rows = Math.ceil(H / S) + 2;
  d = new Float32Array(cols * rows * 7);
  for (let r = 0, i = 0; r < rows; r++) for (let c = 0; c < cols; c++, i += 7) {
    d[i] = d[i + 2] = c * S + 1;
    d[i + 1] = d[i + 3] = (r - 1) * S + 1;
  }
}

function colors() {
  const cs = getComputedStyle(root);
  dot = cs.getPropertyValue('--dot').trim();
  accent = cs.getPropertyValue('--accent').trim();
}

function frame(t) {
  requestAnimationFrame(frame);
  if (root.classList.contains('viewing')) return; // the photo viewer covers everything
  const sy = scrollY;
  const off = -((sy * 0.12) % S);               // the grid slides at an eighth of the page's speed
  if (Math.abs(off - prevOff) > S / 2) {        // it wrapped by one row: move everyone with it, invisibly
    const shift = off > prevOff ? S : -S;
    for (let i = 0; i < d.length; i += 7) d[i + 3] += shift;
  }
  prevOff = off;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const still = reduced.matches;
  const calm = new Path2D(), dust = new Path2D(), threads = new Path2D();

  for (let i = 0; i < d.length; i += 7) {
    let tx = d[i], ty = d[i + 1] + off, near = false;
    if (!still) {
      // a slow ripple, nudged along by scrolling
      tx += Math.sin(d[i + 1] * 0.02 + t * 0.0004 + sy * 0.004) * 1.2;
      ty += Math.cos(d[i] * 0.017 + t * 0.0003 + sy * 0.003) * 1.2;
      const dx = d[i + 2] - px, dy = d[i + 3] - py, q = dx * dx + dy * dy;
      near = q < R * R * 1.4;
      if (q < R * R && q > 0.01) {
        const dist = Math.sqrt(q), f = (1 - dist / R) ** 2 * 26;
        tx += (dx / dist) * f; ty += (dy / dist) * f;
      }
    }
    const k = 0.07 * (1 - d[i + 6] * 0.96), damp = 0.76 + d[i + 6] * 0.16;
    d[i + 4] = (d[i + 4] + (tx - d[i + 2]) * k) * damp;
    d[i + 5] = (d[i + 5] + (ty - d[i + 3]) * k) * damp;
    if (still) { d[i + 2] = tx; d[i + 3] = ty; } else { d[i + 2] += d[i + 4]; d[i + 3] += d[i + 5]; }
    if (d[i + 6] > 0) d[i + 6] = Math.max(0, d[i + 6] - 0.0055); // about three seconds to come home

    const x = d[i + 2], y = d[i + 3];
    if (d[i + 6] > 0.04) { const s = 0.5 + (1 - d[i + 6]) * 0.6; dust.rect(x - s / 2, y - s / 2, s, s); }
    else { calm.moveTo(x + 1, y); calm.arc(x, y, 1, 0, 6.2832); }

    // where the mesh is stretched, draw the threads to the right and lower neighbours
    const ox = x - d[i], oy = y - (d[i + 1] + off);
    if (near && ox * ox + oy * oy > 9 && d[i + 6] < 0.3) {
      const j = i + 7, b = i + cols * 7;
      if ((i / 7) % cols !== cols - 1 && j < d.length) { threads.moveTo(x, y); threads.lineTo(d[j + 2], d[j + 3]); }
      if (b < d.length) { threads.moveTo(x, y); threads.lineTo(d[b + 2], d[b + 3]); }
    }
  }
  ctx.fillStyle = dot; ctx.fill(calm);
  ctx.strokeStyle = dot; ctx.lineWidth = 0.8; ctx.stroke(threads);
  ctx.globalAlpha = 0.7; ctx.fillStyle = accent; ctx.fill(dust); ctx.globalAlpha = 1;
}

function burst(x, y) {
  for (let i = 0; i < d.length; i += 7) {
    const dx = d[i + 2] - x, dy = d[i + 3] - y, dist = Math.hypot(dx, dy);
    if (dist > BURST) continue;
    const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.4;
    const v = (1 - dist / BURST) * (4 + Math.random() * 8);
    d[i + 4] += Math.cos(a) * v;
    d[i + 5] += Math.sin(a) * v - Math.random() * 2; // dust lifts a little as it scatters
    d[i + 6] = Math.max(d[i + 6], 0.6 + Math.random() * 0.4);
  }
}

addEventListener('pointermove', e => { px = e.clientX; py = e.clientY; }, { passive: true });
addEventListener('pointerleave', () => { px = py = -1e4; });
document.addEventListener('pointerout', e => { if (!e.relatedTarget) px = py = -1e4; });
addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') px = py = -1e4; });
addEventListener('pointerdown', e => {
  if (reduced.matches || e.button !== 0) return;
  if (e.target.closest('a, button, input, label, img, canvas:not(.mesh), .ribbon, .lb, .tile, .float, .row')) return;
  burst(e.clientX, e.clientY);
});
addEventListener('resize', build);
new MutationObserver(colors).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

build();
colors();
requestAnimationFrame(frame);
