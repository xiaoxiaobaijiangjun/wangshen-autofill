// 打商店上传包：只含运行必需文件，输出 dist/wangshen-autofill-v<version>.zip
// 运行：node tools/package.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

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

// 收集运行必需文件（不含 test-pages/tools/文档/日志/测试 profile）
const files = ['manifest.json', 'background.js', 'common.js'];
for (const dir of ['content', 'sidepanel', 'options', 'data', 'icons', 'libs']) {
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(path.relative(ROOT, full));
    }
  })(path.join(ROOT, dir));
}
files.sort();

const localParts = [];
const centralParts = [];
let offset = 0;
for (const rel of files) {
  const data = fs.readFileSync(path.join(ROOT, rel));
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); // local file header
  lh.writeUInt16LE(20, 4); // version needed
  lh.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
  lh.writeUInt16LE(8, 8); // method: deflate
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  localParts.push(lh, name, comp);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); // central directory header
  ch.writeUInt16LE(20, 4); // version made by
  ch.writeUInt16LE(20, 6); // version needed
  ch.writeUInt16LE(0x0800, 8); // UTF-8 flag
  ch.writeUInt16LE(8, 10); // method: deflate
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(offset, 42); // local header offset
  centralParts.push(ch, name);

  offset += 30 + name.length + comp.length;
}

const cdStart = offset;
const cdBuf = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(cdStart, 16);

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'))).version;
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `wangshen-autofill-v${version}.zip`);
fs.writeFileSync(out, Buffer.concat([...localParts, cdBuf, eocd]));
console.log(`written ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${files.length} files)`);
