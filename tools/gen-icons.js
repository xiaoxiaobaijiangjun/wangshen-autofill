// 生成扩展图标（纯 Node + zlib，无第三方依赖）。运行：node tools/gen-icons.js
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 图案：蓝底圆角方块 + 白色斜置铅笔（粗线段 + 笔尖三角）
function pointInTriangle(px, py, a, b, c) {
  const sign = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
  const d1 = sign(a, b, [px, py]);
  const d2 = sign(b, c, [px, py]);
  const d3 = sign(c, a, [px, py]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = 0.2; // 圆角半径（与 u/v 同为 0~1 归一化单位，切勿用像素单位）
  const bg = [47, 84, 235];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      // 圆角矩形判定（最近内点距离）
      const cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
      const inside = Math.hypot(u - cx, v - cy) <= r;
      if (!inside) continue;
      let col = bg;
      const dBody = distToSegment(u, v, 0.26, 0.74, 0.66, 0.34);
      const tip = pointInTriangle(u, v, [0.63, 0.29], [0.71, 0.37], [0.84, 0.16]);
      if (dBody <= 0.075 || tip) col = [255, 255, 255];
      const i = (y * size + x) * 4;
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  const png = drawIcon(s);
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), png);
  // 生成后自检：解压统计不透明像素占比，杜绝再生成"全透明图标"
  const raw = zlib.inflateSync(png.slice(pngIndexOfIdat(png)));
  const total = s * s;
  let opaque = 0;
  const stride = 1 + s * 4;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (raw[y * stride + 1 + x * 4 + 3] === 255) opaque++;
    }
  }
  const ratio = opaque / total;
  if (ratio < 0.6) throw new Error(`icon${s} 不透明像素仅 ${(ratio * 100).toFixed(1)}%，判定为空图标`);
  console.log(`icons/icon${s}.png OK (opaque ${(ratio * 100).toFixed(0)}%)`);
}

// 找到第一个 IDAT 块的数据起点
function pngIndexOfIdat(buf) {
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') return pos + 8;
    pos += 12 + len;
  }
  throw new Error('no IDAT');
}
