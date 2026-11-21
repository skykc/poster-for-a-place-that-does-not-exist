// VELMARA — a travel poster for a place that does not exist.
//
// main.ts (Node 22, stdlib only, no network) draws the poster procedurally
// pixel by pixel and writes it as a PNG to /output/entry.png
// (or $MAKEFUN_OUTPUT_DIR/entry.png when set).
//
// The place: VELMARA, a chain of floating islands drifting above a sea of
// clouds at golden hour. One landmark sells the stay: the Sky-Lighthouse,
// whose beam sweeps the cloud sea as the sun sets. The name is set large
// across the sky so the eye goes name -> lighthouse -> horizon.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Tiny deterministic helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Deterministic 2D hash in [0, 1): texture and star placement only.
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967296;
}

type RGB = [number, number, number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---------------------------------------------------------------------------
// Pixel canvas
// ---------------------------------------------------------------------------

const buf = new Uint8Array(W * H * 4);

function setPixel(x: number, y: number, c: RGB, a = 1): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= W || iy < 0 || iy >= H) return;
  const o = (iy * W + ix) * 4;
  const inv = 1 - a;
  buf[o] = clamp(Math.round(c[0] * a + buf[o] * inv), 0, 255);
  buf[o + 1] = clamp(Math.round(c[1] * a + buf[o + 1] * inv), 0, 255);
  buf[o + 2] = clamp(Math.round(c[2] * a + buf[o + 2] * inv), 0, 255);
  buf[o + 3] = 255;
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      setPixel(x, y, c, a);
    }
  }
}

function disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        // Soft edge: fade the outer 25% of the radius.
        const d = Math.sqrt(d2) / r;
        const edge = d > 0.75 ? 1 - (d - 0.75) / 0.25 : 1;
        setPixel(x, y, c, a * clamp(edge, 0, 1));
      }
    }
  }
}

function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 1) {
        const d = Math.sqrt(d2);
        const edge = d > 0.8 ? 1 - (d - 0.8) / 0.2 : 1;
        setPixel(x, y, c, a * clamp(edge, 0, 1));
      }
    }
  }
}

function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / (w * 0.25)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(x0 + dx * t, y0 + dy * t, w / 2, c, a);
  }
}

// Scanline polygon fill (convex or concave, deterministic).
function polygon(points: Array<[number, number]>, c: RGB, a = 1): void {
  let minY = H;
  let maxY = 0;
  for (const [, y] of points) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let y = Math.max(0, Math.ceil(minY)); y <= Math.min(H - 1, Math.floor(maxY)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) {
        setPixel(x, y, c, a);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sky, sun and cloud sea
// ---------------------------------------------------------------------------

const SKY_STOPS: Array<[number, RGB]> = [
  [0.0, [34, 28, 74]],
  [0.28, [84, 52, 104]],
  [0.5, [176, 84, 96]],
  [0.66, [232, 122, 74]],
  [0.78, [247, 178, 103]],
  [1.0, [255, 214, 150]],
];

function skyAt(t: number): RGB {
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const [t0, c0] = SKY_STOPS[i];
    const [t1, c1] = SKY_STOPS[i + 1];
    if (t >= t0 && t <= t1) return mix(c0, c1, (t - t0) / (t1 - t0));
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}

const HORIZON = 700;

function paintSky(): void {
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const base = skyAt(t);
    for (let x = 0; x < W; x++) {
      // A whisper of deterministic grain so the gradient never bands.
      const g = (hash2(x, y) - 0.5) * 5;
      setPixel(x, y, [base[0] + g, base[1] + g, base[2] + g]);
    }
  }
}

function paintSun(): void {
  const sx = 420;
  const sy = 585;
  // Wide warm glow.
  for (let r = 280; r > 40; r -= 6) {
    const a = 0.05 + 0.1 * (1 - r / 280);
    disc(sx, sy, r, [255, 158, 94], a * 0.55);
  }
  disc(sx, sy, 70, [255, 214, 122], 1);
  disc(sx, sy, 55, [255, 232, 170], 1);
}

function paintStars(): void {
  for (let i = 0; i < 130; i++) {
    const x = Math.floor(hash2(i, 7) * W);
    const y = Math.floor(hash2(i, 13) * 300);
    const s = hash2(i, 29);
    if (s < 0.55) continue;
    const a = 0.25 + 0.6 * s;
    const r = s > 0.9 ? 2 : 1;
    disc(x, y, r, [255, 244, 214], a);
  }
}

function paintCloudSea(): void {
  // Base: warm cream rising to the horizon.
  for (let y = HORIZON; y < H; y++) {
    const t = (y - HORIZON) / (H - HORIZON);
    const c = mix([255, 214, 160], [255, 240, 216], t);
    for (let x = 0; x < W; x++) {
      const g = (hash2(x, y) - 0.5) * 4;
      setPixel(x, y, [c[0] + g, c[1] + g, c[2] + g]);
    }
  }
  // Billows: layered ellipses, lit tops and shaded bellies.
  const puffs: Array<[number, number, number, number, RGB, number]> = [
    [140, 830, 220, 70, [255, 227, 194], 0.95],
    [420, 880, 260, 80, [255, 236, 210], 0.95],
    [760, 840, 240, 75, [255, 227, 194], 0.95],
    [950, 920, 200, 70, [255, 240, 218], 0.95],
    [80, 950, 240, 80, [255, 240, 218], 0.95],
    [560, 950, 280, 85, [255, 244, 224], 0.95],
    [300, 790, 150, 48, [255, 214, 168], 0.9],
    [680, 790, 170, 52, [255, 216, 172], 0.9],
    [880, 760, 130, 42, [255, 220, 180], 0.9],
    [180, 760, 120, 40, [255, 220, 180], 0.9],
    [520, 800, 170, 50, [255, 222, 176], 0.9],
    [240, 900, 170, 55, [255, 232, 202], 0.95],
    [860, 960, 210, 60, [255, 234, 206], 0.95],
    [60, 830, 130, 45, [255, 222, 182], 0.9],
    [980, 800, 140, 46, [255, 224, 186], 0.9],
  ];
  for (const [cx, cy, rx, ry, c, a] of puffs) ellipse(cx, cy, rx, ry, c, a);
  // Soft shadows under the billows.
  const shadows: Array<[number, number, number, number]> = [
    [140, 872, 200, 34],
    [420, 922, 240, 36],
    [760, 882, 220, 34],
    [560, 990, 260, 36],
    [240, 940, 160, 30],
    [860, 998, 200, 30],
  ];
  for (const [cx, cy, rx, ry] of shadows) ellipse(cx, cy, rx, ry, [214, 150, 118], 0.28);
  // Distant cloud bank along the horizon, softening the sky/sea edge.
  const bank: Array<[number, number, number, number, RGB, number]> = [
    [80, 706, 150, 26, [255, 196, 158], 0.9],
    [300, 700, 180, 30, [255, 206, 168], 0.9],
    [560, 704, 190, 28, [255, 200, 162], 0.9],
    [800, 700, 170, 30, [255, 206, 168], 0.9],
    [980, 706, 130, 26, [255, 196, 158], 0.9],
  ];
  for (const [cx, cy, rx, ry, c, a] of bank) ellipse(cx, cy, rx, ry, c, a);
}

// ---------------------------------------------------------------------------
// Floating islands and the Sky-Lighthouse
// ---------------------------------------------------------------------------

function pine(x: number, y: number, s: number, c: RGB): void {
  polygon(
    [
      [x, y - 26 * s],
      [x - 13 * s, y + 6 * s],
      [x + 13 * s, y + 6 * s],
    ],
    c,
  );
  polygon(
    [
      [x, y - 16 * s],
      [x - 10 * s, y + 14 * s],
      [x + 10 * s, y + 14 * s],
    ],
    c,
  );
  fillRect(x - 1.5 * s, y + 12 * s, x + 1.5 * s, y + 20 * s, [74, 52, 40]);
}

function island(cx: number, topY: number, w: number, scale: number, withLight: boolean): void {
  const h = 150 * scale;
  // Rocky underside: a tapering mass with facets.
  polygon(
    [
      [cx - w / 2, topY],
      [cx + w / 2, topY],
      [cx + w * 0.28, topY + h * 0.55],
      [cx + w * 0.08, topY + h],
      [cx - w * 0.12, topY + h * 0.72],
      [cx - w * 0.34, topY + h * 0.5],
    ],
    [88, 58, 82],
  );
  // Facet highlights and shade.
  polygon(
    [
      [cx - w / 2, topY],
      [cx + w * 0.1, topY],
      [cx + w * 0.08, topY + h],
      [cx - w * 0.12, topY + h * 0.72],
      [cx - w * 0.34, topY + h * 0.5],
    ],
    [122, 84, 104],
    0.85,
  );
  polygon(
    [
      [cx + w * 0.1, topY],
      [cx + w / 2, topY],
      [cx + w * 0.28, topY + h * 0.55],
      [cx + w * 0.08, topY + h],
    ],
    [62, 40, 60],
    0.9,
  );
  // Grassy top, sunlit gold-green.
  ellipse(cx, topY + 2, w / 2, 26 * scale, [127, 168, 90]);
  ellipse(cx - w * 0.12, topY - 2, w * 0.3, 16 * scale, [168, 186, 104]);
  ellipse(cx + w * 0.16, topY, w * 0.24, 13 * scale, [201, 162, 39], 0.9);
  // Pines.
  const treeC: RGB = [46, 92, 58];
  pine(cx - w * 0.3, topY - 8 * scale, 0.9 * scale, treeC);
  pine(cx - w * 0.18, topY - 12 * scale, 1.1 * scale, treeC);
  pine(cx + w * 0.3, topY - 8 * scale, 0.8 * scale, treeC);
  if (withLight) {
    pine(cx + w * 0.2, topY - 10 * scale, 1.0 * scale, treeC);
  }
}

function lighthouse(cx: number, baseY: number, s: number): void {
  const towerH = 190 * s;
  const topY = baseY - towerH;
  const bw = 52 * s; // base width
  const tw = 34 * s; // top width
  // Tower body, warm white with a coral band.
  polygon(
    [
      [cx - bw / 2, baseY],
      [cx + bw / 2, baseY],
      [cx + tw / 2, topY],
      [cx - tw / 2, topY],
    ],
    [255, 246, 232],
  );
  polygon(
    [
      [cx - bw / 2 + 6 * s, baseY - 52 * s],
      [cx + bw / 2 - 6 * s, baseY - 52 * s],
      [cx + tw / 2 + 2 * s, topY + 58 * s],
      [cx - tw / 2 - 2 * s, topY + 58 * s],
    ],
    [217, 79, 61],
  );
  // Sunlit edge on the tower's left.
  thickLine(cx - bw / 2 + 4 * s, baseY, cx - tw / 2 + 4 * s, topY, 5 * s, [255, 226, 170], 0.9);
  // Gallery and lamp room.
  fillRect(cx - tw / 2 - 8 * s, topY - 10 * s, cx + tw / 2 + 8 * s, topY, [52, 40, 58]);
  fillRect(cx - tw / 2 + 2 * s, topY - 34 * s, cx + tw / 2 - 2 * s, topY - 10 * s, [255, 224, 138]);
  // Lamp glow.
  disc(cx, topY - 22 * s, 26 * s, [255, 224, 138], 0.55);
  disc(cx, topY - 22 * s, 14 * s, [255, 240, 190], 0.95);
  // Dome.
  polygon(
    [
      [cx - tw / 2 - 2 * s, topY - 34 * s],
      [cx + tw / 2 + 2 * s, topY - 34 * s],
      [cx + tw / 2 - 8 * s, topY - 50 * s],
      [cx - tw / 2 + 8 * s, topY - 50 * s],
    ],
    [217, 79, 61],
  );
  disc(cx, topY - 50 * s, 3 * s, [255, 224, 138]);
  // Beam sweeping right across the cloud sea, rising slightly.
  const beamY = topY - 22 * s;
  polygon(
    [
      [cx + 8 * s, beamY - 4 * s],
      [W, beamY - 44 * s],
      [W, beamY + 18 * s],
      [cx + 8 * s, beamY + 4 * s],
    ],
    [255, 226, 150],
    0.26,
  );
  polygon(
    [
      [cx + 8 * s, beamY - 2 * s],
      [W, beamY - 18 * s],
      [W, beamY + 7 * s],
      [cx + 8 * s, beamY + 2 * s],
    ],
    [255, 236, 178],
    0.32,
  );
}

function paintBirds(): void {
  const birds: Array<[number, number, number]> = [
    [300, 330, 1.0],
    [340, 300, 0.8],
    [700, 280, 0.9],
    [740, 320, 0.7],
    [640, 350, 0.6],
  ];
  for (const [x, y, s] of birds) {
    const w = 12 * s;
    thickLine(x - w, y, x, y - 5 * s, 2.5, [46, 34, 58], 0.9);
    thickLine(x, y - 5 * s, x + w, y, 2.5, [46, 34, 58], 0.9);
  }
}

// ---------------------------------------------------------------------------
// Lettering: stroke-drawn capitals for VELMARA (grid 7 x 9)
// ---------------------------------------------------------------------------

type Stroke = [number, number, number, number];

const GLYPHS: Record<string, Stroke[]> = {
  V: [
    [0, 0, 3, 9],
    [3, 9, 6, 0],
  ],
  E: [
    [0, 0, 0, 9],
    [0, 0, 6, 0],
    [0, 4.5, 5, 4.5],
    [0, 9, 6, 9],
  ],
  L: [
    [0, 0, 0, 9],
    [0, 9, 6, 9],
  ],
  M: [
    [0, 9, 0, 0],
    [0, 0, 3, 5],
    [3, 5, 6, 0],
    [6, 0, 6, 9],
  ],
  A: [
    [0, 9, 3, 0],
    [3, 0, 6, 9],
    [1.5, 6, 4.5, 6],
  ],
  R: [
    [0, 9, 0, 0],
    [0, 0, 4.5, 0],
    [4.5, 0, 6, 1.5],
    [6, 1.5, 4.5, 4],
    [4.5, 4, 0, 4],
    [2.5, 4, 6, 9],
  ],
};

function drawWord(word: string, x0: number, y0: number, unit: number, lw: number, c: RGB, a = 1): void {
  const cellW = 7;
  const gap = 1.2;
  let x = x0;
  for (const ch of word) {
    const strokes = GLYPHS[ch];
    if (!strokes) {
      x += (cellW + gap) * unit;
      continue;
    }
    for (const [sx1, sy1, sx2, sy2] of strokes) {
      thickLine(x + sx1 * unit, y0 + sy1 * unit, x + sx2 * unit, y0 + sy2 * unit, lw, c, a);
    }
    x += (cellW + gap) * unit;
  }
}

function wordWidth(word: string, unit: number): number {
  return word.length * (7 + 1.2) * unit - 1.2 * unit;
}

function paintTitle(): void {
  const word = "VELMARA";
  const unit = 16;
  const lw = 13;
  const w = wordWidth(word, unit);
  const x0 = (W - w) / 2;
  const y0 = 72;
  // Soft drop shadow first, then the cream letters.
  drawWord(word, x0 + 5, y0 + 6, unit, lw, [58, 32, 66], 0.55);
  drawWord(word, x0, y0, unit, lw, [255, 243, 214], 1);
  // A thin gold rule under the name, poster-style.
  const ruleY = y0 + 9 * unit + 26;
  fillRect(x0 + 60, ruleY, x0 + w - 60, ruleY + 4, [255, 205, 120], 0.95);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function paintFrame(): void {
  const c: RGB = [255, 243, 214];
  const m = 26;
  const t = 5;
  fillRect(m, m, W - m, m + t, c, 0.95);
  fillRect(m, H - m - t, W - m, H - m, c, 0.95);
  fillRect(m, m, m + t, H - m, c, 0.95);
  fillRect(W - m - t, m, W - m, H - m, c, 0.95);
}

// ---------------------------------------------------------------------------
// PNG encoder (stdlib zlib + hand-rolled CRC32)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function encodePNG(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compose and write
// ---------------------------------------------------------------------------

function main(): void {
  paintSky();
  paintStars();
  paintSun();
  // Far islands first, main island last so it sits in front.
  island(238, 545, 210, 0.62, false);
  island(800, 578, 230, 0.7, false);
  paintCloudSea();
  island(512, 618, 430, 1.0, true);
  lighthouse(512, 614, 1.0);
  paintBirds();
  paintTitle();
  paintFrame();

  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outDir, { recursive: true });
  const png = encodePNG(W, H, buf);
  writeFileSync(join(outDir, "entry.png"), png);
  console.log(`wrote ${join(outDir, "entry.png")} (${png.length} bytes, ${W}x${H})`);
}

main();
