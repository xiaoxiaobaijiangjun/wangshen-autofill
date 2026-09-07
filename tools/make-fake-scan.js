// 生成图片型 PDF（无文本层），用于验证「扫描件 → 视觉模式」判定。
// 运行：node tools/make-fake-scan.js  → 输出 test-pages/fake-scan.pdf
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 800;
const H = 1100;

// 白底 + 若干黑色横条，模拟扫描文档（不需要真实字形，验收点只看是否走了视觉模式）
function drawImage() {
  const rgb = Buffer.alloc(W * H * 3, 0xff);
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
  };
  let seed = 20260906;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // 标题块
  for (let y = 60; y < 100; y++) for (let x = 80; x < 420; x++) set(x, y, 30);
  // 正文行
  let y = 160;
  while (y < H - 80) {
    const lineHeight = 14 + Math.floor(rand() * 6);
    let x = 80;
    while (x < W - 120) {
      const w = 30 + Math.floor(rand() * 120);
      if (rand() > 0.18) {
        for (let yy = y; yy < y + lineHeight; yy++) for (let xx = x; xx < Math.min(x + w, W - 100); xx++) set(xx, yy, 40 + Math.floor(rand() * 60));
      }
      x += w + 24;
    }
    y += lineHeight + 26;
  }
  return rgb;
}

function buildPdf() {
  const img = zlib.deflateSync(drawImage(), { level: 9 });
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  const objs = [];
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objs[2] = Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs[3] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  objs[4] = Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`),
    img,
    Buffer.from('\nendstream'),
  ]);
  objs[5] = Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
    Buffer.from(content),
    Buffer.from('\nendstream'),
  ]);

  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.concat(parts).length;
    parts.push(Buffer.from(`${i} 0 obj\n`), objs[i], Buffer.from('\nendobj\n'));
  }
  const xrefStart = Buffer.concat(parts).length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

const out = path.join(__dirname, '..', 'test-pages', 'fake-scan.pdf');
fs.writeFileSync(out, buildPdf());
console.log('written', out, fs.statSync(out).size, 'bytes');
