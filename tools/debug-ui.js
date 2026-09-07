// 一次性 UI 预览：打开侧边栏页面并截图（含字段库种子数据）
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    await sleep(300);
  }
  throw new Error('timeout: ' + desc);
}
class CDP {
  constructor() { this.msgId = 0; this.pending = new Map(); }
  async connect(port) {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params, sessionId) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); }, 15000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async list() { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()); }
}
(async () => {
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like '*edge-dbg*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
  await sleep(1200);
  try { fs.rmSync(path.join(ROOT, '.edge-dbg'), { recursive: true, force: true }); } catch (e) {}
  // 释放被孤儿 renderer 继承的 CDP 监听端口
  const nr = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  (nr.stdout || '').split('\n').forEach((line) => {
    if (line.includes(':9222 ') && /LISTENING/i.test(line)) {
      const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
      if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    }
  });
  await sleep(800);
  const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--user-data-dir=' + path.join(ROOT, '.edge-dbg'),
    '--remote-debugging-port=9222', '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--edge-skip-compat-layer-relaunch',
    '--load-extension=' + ROOT, 'about:blank',
  ], { stdio: 'ignore' });
  await waitFor('cdp', async () => (await fetch('http://127.0.0.1:9222/json/version')).ok, 25000);
  const cdp = new CDP();
  cdp.port = 9222;
  await cdp.connect(9222);
  const sw = await waitFor('sw', () => cdp.list().then((l) => l.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url))), 15000);
  const extId = sw.url.match(/chrome-extension:\/\/([a-p]+)\//)[1];

  const t = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel/sidepanel.html` });
  await sleep(1500);
  const psid = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).then((r) => r.sessionId);
  await waitFor('sidepanel ready', async () => {
    try {
      return (await cdp.send('Runtime.evaluate', { expression: 'window.WSA && WSA.ready ? "y" : "n"', returnByValue: true }, psid)).result.value === 'y';
    } catch (e) { return false; }
  }, 15000);
  // 种子：填一些示例数据（在页面上下文里做，再刷新渲染）
  await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const obj = await chrome.storage.local.get('wangshenAutofill');
      const s = obj.wangshenAutofill;
      const set = (k, v) => { const f = s.profiles[0].fields.find((x) => x.key === k); if (f) f.value = v; };
      set('name','王小明'); set('phone','13800138000'); set('email','wangxm@example.com');
      set('gender','男'); set('school','江城理工大学'); set('major','电子信息工程');
      set('degree','硕士'); set('graduationDate','2027-06'); set('gpa','3.6/4.0');
      set('expectedPosition','嵌入式软件工程师'); set('expectedCity','江城');
      set('politicalStatus','共青团员'); set('ethnic','汉'); set('hometown','江城');
      set('selfEvaluation','踏实肯干，动手能力强，喜欢钻研底层原理。');
      s.onboardingDone = true;
      await chrome.storage.local.set({ wangshenAutofill: s });
      return 'seeded';
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, psid);
  // 宽一点模拟真实侧边栏
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, psid);
  await cdp.send('Page.reload', {}, psid);
  await sleep(1500);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, psid);
  fs.writeFileSync(path.join(ROOT, '.ui-preview.png'), Buffer.from(shot.data, 'base64'));
  console.log('saved .ui-preview.png');

  // 第二张：⋯ 菜单展开
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btnMore').click()` , returnByValue: true }, psid);
  await sleep(400);
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' }, psid);
  fs.writeFileSync(path.join(ROOT, '.ui-preview-menu.png'), Buffer.from(shot2.data, 'base64'));
  await cdp.send('Runtime.evaluate', { expression: `document.body.click()`, returnByValue: true }, psid);

  // 第三张：填充页
  await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.tabs button[data-tab="fill"]').click()`, returnByValue: true }, psid);
  await sleep(800);
  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' }, psid);
  fs.writeFileSync(path.join(ROOT, '.ui-preview-fill.png'), Buffer.from(shot3.data, 'base64'));
  console.log('saved menu + fill previews');
  edge.kill();
  await sleep(1000);
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like '*edge-dbg*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
  try { fs.rmSync(path.join(ROOT, '.edge-dbg'), { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error('fail:', e.message); process.exit(1); });
