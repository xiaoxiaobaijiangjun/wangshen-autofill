// 自动化验收：隔离 profile 启动 Edge（--load-extension）+ 本地 http 服务 + host 映射，
// 通过 CDP 驱动扩展页面与 mock 表单页，逐条执行执行文档 §5 阶段 0~3/4/5 的命令类验收。
// 用法：node tools/verify.js [--keep]   （--keep 保留 Edge 窗口供人工查看）
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTTP_PORT = 8321;
const PROXY_PORT = 8399;
const CDP_PORT = 9222;
const PROFILE_BASE = path.join(ROOT, '.edge-test-profile');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 真实简历测试（可选）：设置环境变量 WSA_RESUME 指向任意本地 PDF 即可启用，不设置则跳过
const RESUME_FILE = process.env.WSA_RESUME || '';
const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs) {
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(400);
  }
  throw new Error(`等待超时: ${desc} ${lastErr}`);
}

// ============ 极简 CDP 客户端 ============

class CDP {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`;
    this.port = port;
    this.msgId = 0;
    this.pending = new Map();
  }
  async connect() {
    this.base = `http://127.0.0.1:${this.port}`;
    const ver = await (await fetch(this.base + '/json/version')).json();
    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('WS 连接失败'));
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.method || 'CDP') + JSON.stringify(m.error)) : resolve(m.result);
      }
    });
  }
  send(method, params, sessionId) {
    const id = ++this.msgId;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时: ' + method));
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }
  async list() {
    return (await (await fetch(this.base + '/json/list')).json());
  }
  async attach(targetId) {
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return r.sessionId;
  }
  async createTarget(url) {
    const r = await this.send('Target.createTarget', { url });
    return r.targetId;
  }
  async eval(sessionId, expr) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails).slice(0, 300));
    }
    return r.result.value;
  }
}

// ============ 主流程 ============

async function launchEdge(cdp, profileDir) {
  const ports = [CDP_PORT, CDP_PORT + 1, CDP_PORT + 2];
  let lastErr = null;
  freeCdpPorts();
  for (const port of ports) {
    const args = [
      '--user-data-dir=' + profileDir,
      '--remote-debugging-port=' + port,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--edge-skip-compat-layer-relaunch', // 防止 Edge 自我重启导致 kill 失效、CDP 状态错乱
      '--ignore-certificate-errors',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--load-extension=' + ROOT,
      '--proxy-server=http://127.0.0.1:' + (PROXY_PORT),
      'about:blank',
    ];
    const edge = spawn(EDGE, args, { stdio: 'ignore', detached: false });
    try {
      await waitFor(`Edge CDP 端口 ${port}`, async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/json/version`);
          return r.ok;
        } catch (e) {
          return false;
        }
      }, 25000);
      cdp.port = port;
      await cdp.connect();
      return edge;
    } catch (e) {
      lastErr = e;
      step(`port ${port} failed (${e.message.slice(0, 50)}), retry next port`);
      killEdgeTree(edge);
      await sleep(1500);
      killLeftoverEdge(profileDir);
      freeCdpPorts();
      await sleep(1000);
    }
  }
  throw lastErr || new Error('Edge 启动失败');
}

async function findExtId(cdp) {
  return waitFor('扩展 service worker', async () => {
    const targets = await cdp.list();
    // 按 background.js 精确匹配本扩展的 SW：列表里可能混有 Edge 组件扩展
    const sw = targets.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url));
    return sw ? sw.url.match(/chrome-extension:\/\/([a-p]+)\//)[1] : null;
  }, 20000);
}

async function attachEval(cdp, targetId) {
  const sid = await cdp.attach(targetId);
  return {
    eval: (expr) => cdp.eval(sid, expr),
    sid,
  };
}

async function openSidepanel(cdp, extId) {
  const t = await cdp.createTarget(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  await sleep(800);
  const h = await attachEval(cdp, t);
  await waitFor('sidepanel 初始化', async () => await h.eval('window.WSA && WSA.ready ? "ready" : ""'), 8000);
  return { targetId: t, ...h };
}

async function activateAndWait(cdp, targetId) {
  await cdp.send('Target.activateTarget', { targetId });
  await sleep(600);
}

// ============ 测试 ============

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}
function step(msg) {
  console.log('·· ' + msg);
}

// 清理上一次运行残留的测试 Edge 进程（按 profile 路径匹配，绝不碰用户日常 Edge）
function killLeftoverEdge(dirPattern) {
  const ps =
    `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${dirPattern}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

function killPid(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

// 找出监听指定端口的进程并强杀：被杀 Edge 的孤儿 renderer 会继承监听 socket，
// 命令行里没有 profile 路径，按 profile 清理抓不到它们
function freeCdpPorts() {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  const pids = new Set();
  for (const line of (r.stdout || '').split('\n')) {
    for (const p of [CDP_PORT, CDP_PORT + 1, CDP_PORT + 2]) {
      if (line.includes(':' + p + ' ') && /LISTENING/i.test(line)) {
        const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
        if (pid) pids.add(pid);
      }
    }
  }
  for (const pid of pids) killPid(pid);
  return pids.size;
}

// 清理本地 mock 服务器端口残留（dev-https-server / dev-proxy 上次运行可能没退干净）
function freeServerPorts() {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  const pids = new Set();
  const lines = (r.stdout || '').split('\n');
  for (const line of lines) {
    for (const p of [HTTP_PORT, PROXY_PORT]) {
      if (line.includes(':' + p + ' ') && /LISTENING/i.test(line)) {
        const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
        if (pid) pids.add(pid);
      }
    }
  }
  for (const pid of pids) killPid(pid);
}

// Edge 浏览器进程必须树杀，否则 renderer 孤儿继续占着 CDP 端口
function killEdgeTree(edge) {
  if (edge && edge.pid) killPid(edge.pid);
}

// 等待页面真正加载完成（readyState + 页面探针函数存在），替代固定 sleep
async function waitPageReady(cdp, targetId, probeExpr, timeoutMs) {
  const h = await attachEval(cdp, targetId);
  await waitFor('page ready', async () => {
    try {
      const s = await h.eval(`JSON.stringify({r: document.readyState, p: !!(${probeExpr})})`);
      const o = JSON.parse(s);
      return o.r === 'complete' && o.p;
    } catch (e) {
      return false;
    }
  }, timeoutMs || 15000);
  return h;
}

async function cleanupProfile(dir) {
  for (let i = 0; i < 4; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      killLeftoverEdge(dir);
      await sleep(1000);
    }
  }
}
// 看门狗：整体 8 分钟强制退出，避免静默挂死
setTimeout(() => {
  console.error('看门狗超时（8 分钟），强制退出。已完成项:');
  results.forEach((r) => console.error(' - ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.name));
  process.exit(3);
}, 480000).unref();

async function main() {
  const profileDir = PROFILE_BASE;
  killLeftoverEdge(profileDir);
  await cleanupProfile(profileDir);
  freeServerPorts();
  const httpSrv = spawn('python', ['tools/dev-https-server.py', String(HTTP_PORT)], { cwd: ROOT, stdio: 'ignore' });
  const proxySrv = spawn('node', ['tools/dev-proxy.js', String(PROXY_PORT), String(HTTP_PORT)], { cwd: ROOT, stdio: 'ignore' });
  await sleep(900);

  const cdp = new CDP(CDP_PORT);
  let edge = await launchEdge(cdp, profileDir);

  try {
    // ---------- 阶段 0：扩展加载 ----------
    step('查找扩展 service worker…');
    const extId = await findExtId(cdp);
    report('阶段0: 扩展在 Edge 加载成功（发现 service worker）', !!extId, 'id=' + extId);
    if (!extId) throw new Error('扩展未加载，后续无法进行');

    const swTargets = () => cdp.list().then((l) => l.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url)));
    const swT = await waitFor('SW target', swTargets, 10000);
    const swH = await attachEval(cdp, swT.id);
    // SW 目标可能先于脚本上下文就绪出现，eval 需重试
    const ver = await waitFor('SW 上下文就绪', async () => {
      try {
        const v = await swH.eval('typeof chrome === "object" ? chrome.runtime.getManifest().version : ""');
        return /^1\./.test(v) ? v : null;
      } catch (e) {
        return null;
      }
    }, 15000);
    report('阶段0: background service worker 可执行', ver === '1.3.6', 'version=' + ver);

    // 真实侧边栏 API 此前从未被验证：确认 sidePanel 存在且 setPanelBehavior 可调用
    const spApi = await waitFor('sidePanel API', async () => {
      try {
        return await swH.eval(`new Promise((res) => {
          if (!chrome.sidePanel) return res('missing');
          chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }, () => {
            res(chrome.runtime.lastError ? 'err:' + chrome.runtime.lastError.message : 'ok');
          });
        })`);
      } catch (e) {
        return null;
      }
    }, 15000);
    report('阶段0: 真实侧边栏 API 可用（setPanelBehavior 成功）', spApi === 'ok', String(spApi));

    // ---------- 阶段 1：字段库 ----------
    step('打开侧边栏页面…');
    const sp = await openSidepanel(cdp, extId);
    report('阶段0/1: 侧边栏页面可打开并初始化', true, 'WSA.ready');

    // 图标必须能在 Chromium 里真实解码（上次 bug：PNG 合法但内容全透明）
    const iconRes = await sp.eval(`Promise.all(['16','32','48','128'].map((s) => new Promise((res) => { const im = new Image(); im.onload = () => res(s + ':' + im.naturalWidth); im.onerror = () => res(s + ':0'); im.src = '/icons/icon' + s + '.png'; })))`);
    const iconsOk = iconRes.every((x) => x.split(':')[1] === x.split(':')[0]);
    report('阶段0: 图标 PNG 在 Edge 内解码成功且尺寸正确', iconsOk, iconRes.join(' '));

    const st0 = await sp.eval('WSA.getState()');
    report('阶段1: 首次安装自动写入默认数据（p1 全字段 51 项）', st0.profiles.length === 1 && st0.profiles[0].id === 'p1' && st0.profiles[0].fields.length === 51 && st0.profiles[0].templateId === 'all',
      `profiles=${st0.profiles.length} fields=${st0.profiles[0].fields.length} tpl=${st0.profiles[0].templateId}`);

    // 填 p1 的值（虚构测试数据）
    const vals = {
      name: '王小明', phone: '13800138000', email: 'wangxm@example.com', gender: '男',
      birthDate: '2003-06', idCard: '110101200306010000', currentCity: '江城',
      school: '江城理工大学', major: '电子信息工程', degree: '硕士', graduationDate: '2027-06',
      gpa: '3.6/4.0', englishLevel: 'CET-6 520', expectedPosition: '嵌入式软件工程师',
      expectedCity: '江城', expectedSalary: '18k', availableTime: '2027-07',
      skills: 'C/C++, STM32, RT-Thread, Linux', github: 'https://github.com/example',
      selfEvaluation: '踏实肯干，动手能力强。',
    };
    await sp.eval(`(() => { const v = ${JSON.stringify(vals)}; for (const k in v) WSA.setFieldByKey(k, v[k]); return true; })()`);
    await sp.eval('WSA.save()');

    // 新建第二档案（全字段模板，不再选长短）
    const soeId = await sp.eval(`WSA.createProfile('全字段-测试')`);
    await sleep(400);
    const st1 = await sp.eval('WSA.getState()');
    const soeProf = st1.profiles.find((p) => p.id === soeId);
    report('阶段1: 新建档案默认全字段（51 字段）', soeProf && soeProf.fields.length === 51, 'fields=' + (soeProf ? soeProf.fields.length : 0));
    const groupCount = await sp.eval('document.querySelectorAll("#tab-fields details.group").length');
    report('阶段1: 面板可见全部分组（≥8 组）', groupCount >= 8, 'groups=' + groupCount);

    // 敏感字段遮挡
    await sp.eval(`WSA.switchProfile('p1')`);
    await sleep(300);
    const masked = await sp.eval(`(() => { const i=[...document.querySelectorAll('#tab-fields input')].find(x=>x.dataset.fid==='f_phone'); return i ? i.classList.contains('masked') : 'nofield'; })()`);
    report('阶段1: 手机号(敏感)默认显示 •••• 遮挡', masked === true, 'masked=' + masked);

    // ---------- 阶段 2：通用填充引擎 ----------
    step('打开 generic mock 页并检测…');
    const gT = await cdp.createTarget(`https://127.0.0.1:${HTTP_PORT}/test-pages/generic.html`);
    await activateAndWait(cdp, gT);
    await waitPageReady(cdp, gT, "typeof window.__genericProbe === 'function'");
    const det = await sp.eval('WSA.refresh()');
    report('阶段2: generic 页检测（平台=generic，可自动填 ≥8）', det && det.platform === 'generic' && det.counts.auto >= 8,
      `platform=${det && det.platform} auto=${det && det.counts.auto} manual=${det && det.counts.manual} open=${det && det.counts.open}`);

    const fb = await (await attachEval(cdp, gT)).eval(`!!document.getElementById('wsa-floatbar-host') && document.getElementById('wsa-floatbar-host').shadowRoot.textContent.includes('可自动填')`);
    report('阶段2: 页面右下角浮条出现并显示计数', fb === true, String(fb));

    const review = await sp.eval('WSA.autoFill()');
    const okN = review.filter((r) => r.ok).length;
    report('阶段2: 一键填充成功 ≥8 项短字段', okN >= 8, `ok=${okN}/${review.length}`);

    const probe = await (await attachEval(cdp, gT)).eval('window.__genericProbe()');
    const expect = { name: vals.name, phone: vals.phone, email: vals.email, gender: 'male', school: vals.school, major: vals.major, degree: '硕士', grad: vals.graduationDate, city: vals.expectedCity, salary: vals.expectedSalary, github: vals.github, selfEval: vals.selfEvaluation };
    const bad = Object.keys(expect).filter((k) => probe[k] !== expect[k]);
    report('阶段2: 短字段+有值长文本全部正确赋值', bad.length === 0, bad.length ? '错位: ' + bad.map((k) => `${k}=${JSON.stringify(probe[k])}`).join(', ') : '12/12 正确');
    report('阶段2: 开放题未被自动填（无草稿不落表）', probe.openQ === '', `openQ="${probe.openQ}"`);

    const marked = await (await attachEval(cdp, gT)).eval(`!!document.querySelector('.wsa-filled-mark')`);
    report('阶段2: 已填字段出现持续蓝色角标/高亮', marked === true, String(marked));

    const ledger0 = await sp.eval('WSA.getState().ledger');
    report('阶段2: 一键填充记入台账', ledger0.length >= 1 && ledger0[0].autoCount === okN, `rows=${ledger0.length} autoCount=${ledger0[0] && ledger0[0].autoCount}`);

    // React 受控组件模拟页
    step('React mock 页…');
    const rT = await cdp.createTarget(`https://127.0.0.1:${HTTP_PORT}/test-pages/react-mock.html`);
    await activateAndWait(cdp, rT);
    await waitPageReady(cdp, rT, "typeof window.__reactMock === 'object'");
    await sp.eval('WSA.refresh()');
    await sp.eval('WSA.autoFill()');
    await sleep(400);
    const rm = await (await attachEval(cdp, rT)).eval('window.__reactMock && JSON.stringify({state: __reactMock.state(), dom: __reactMock.dom()})');
    const rmObj = JSON.parse(rm);
    const rmOk = rmObj.state.name === vals.name && rmObj.state.phone === vals.phone && rmObj.state.city === vals.expectedCity
      && rmObj.state.name === rmObj.dom.name && rmObj.state.phone === rmObj.dom.phone;
    report('阶段2: React 受控组件赋值生效（值保留在组件 state）', rmOk, JSON.stringify(rmObj.state));

    // 误报回归：聊天页孤 textarea 不应被当成开放题（DeepSeek 首页误报修复）
    step('孤 textarea 误报回归…');
    const lT = await cdp.createTarget(`https://127.0.0.1:${HTTP_PORT}/test-pages/lonely-textarea.html`);
    await activateAndWait(cdp, lT);
    await waitPageReady(cdp, lT, "typeof window.__lonelyProbe === 'function'");
    const lDet = await sp.eval('WSA.refresh()');
    const lTotal = lDet ? lDet.counts.auto + lDet.counts.manual + lDet.counts.open : -1;
    report('阶段2: 聊天页孤 textarea 不误报（0 字段、不弹浮条）', lTotal === 0, `total=${lTotal}`);

    // 登录页回归：验证码页即使有手机号输入也应抑制全部填充（pageKind=login）
    step('登录页抑制回归…');
    const gT2 = await cdp.createTarget(`https://127.0.0.1:${HTTP_PORT}/test-pages/login-mock.html`);
    await activateAndWait(cdp, gT2);
    await waitPageReady(cdp, gT2, "typeof window.__loginProbe === 'function'");
    const gDet = await sp.eval('WSA.refresh()');
    const gTotal = gDet ? gDet.counts.auto + gDet.counts.manual + gDet.counts.open : -1;
    report('阶段2: 登录/验证页识别为 login 并抑制填充', gDet && gDet.pageKind === 'login' && gTotal === 0,
      `pageKind=${gDet && gDet.pageKind} total=${gTotal}`);

    // ---------- 阶段 3：平台适配 ----------
    step('Moka mock 页…');
    // Moka（域名映射 app.mokahr.com → 127.0.0.1）
    const mT = await cdp.createTarget(`https://app.mokahr.com:${HTTP_PORT}/test-pages/moka-mock.html`);
    await activateAndWait(cdp, mT);
    const mH = await waitPageReady(cdp, mT, "typeof window.__mokaProbe === 'function'");
    const mDet = await sp.eval('WSA.refresh()');
    report('阶段3: 域名识别 *.mokahr.com → moka', mDet && mDet.platform === 'moka', 'platform=' + (mDet && mDet.platform));
    const mReview = await sp.eval('WSA.autoFill()');
    const mOk = mReview.filter((r) => r.ok).length;
    report('阶段3: Moka mock 一键自动填全部命中', mOk === mReview.length && mOk >= 6, `ok=${mOk}/${mReview.length}`);
    const mProbe = await (await attachEval(cdp, mT)).eval('window.__mokaProbe()');
    const mBad = [];
    if (mProbe.name !== vals.name) mBad.push('name');
    if (mProbe.phone !== vals.phone) mBad.push('phone');
    if (mProbe.email !== vals.email) mBad.push('email');
    if (mProbe.degree !== '硕士') mBad.push('degree');
    if (mProbe.school !== vals.school) mBad.push('school');
    if (mProbe.major !== vals.major) mBad.push('major');
    if (mProbe.expectedCity !== vals.expectedCity) mBad.push('expectedCity');
    if (mProbe.essay !== '') mBad.push('essay(应未被自动填)');
    report('阶段3: Moka mock 字段值正确、开放题未被自动填', mBad.length === 0, mBad.join(',') || '7/7 正确');

    // 附件提醒
    const matBanner = await sp.eval(`document.getElementById('tab-fill').textContent.includes('该传的材料')`);
    report('阶段5: 检测到上传控件时附件提醒出现', matBanner === true, String(matBanner));

    // 点选填（开放题手动填入 → 台账 manualCount）
    const essayField = (await sp.eval('WSA.detection().fields')).find((f) => f.cls === 'open');
    const fillOneRes = await sp.eval(`WSA.fillOne('${essayField.id}', '我想做嵌入式是因为……（点选填测试文本）')`);
    await sleep(200);
    const mProbe2 = await (await attachEval(cdp, mT)).eval(`__mokaProbe().essay`);
    report('阶段5: 开放题点选填落入表单', fillOneRes.ok && fillOneRes.results[0].ok && mProbe2.includes('点选填测试文本'), `essay="${String(mProbe2).slice(0, 24)}…"`);
    const ledgerM = await sp.eval('WSA.getState().ledger');
    report('阶段5: 首次点选填记台账 manualCount', ledgerM.some((r) => r.manualCount >= 1), JSON.stringify(ledgerM.map((r) => ({ a: r.autoCount, m: r.manualCount }))));

    // 国聘（域名映射 www.iguopin.com → 127.0.0.1）
    step('iguopin mock page');
    await sp.eval(`WSA.switchProfile('${soeId}')`);
    await sleep(200);
    const soeVals = {
      name: vals.name, phone: vals.phone, email: vals.email, gender: '男', birthDate: vals.birthDate,
      ethnic: '汉', hometown: '江城', politicalStatus: '共青团员', school: vals.school, major: vals.major,
      cet4Score: '520', cet6Score: '480', computerLevel: '计算机二级', height: '175', weight: '65',
      familyName1: '家长一', familyRelation1: '父亲', familyUnit1: '某单位', emergencyPhone: '13900139000',
    };
    await sp.eval(`(() => { const v = ${JSON.stringify(soeVals)}; for (const k in v) WSA.setFieldByKey(k, v[k]); return true; })()`);
    await sp.eval('WSA.save()');

    const iT = await cdp.createTarget(`https://www.iguopin.com:${HTTP_PORT}/test-pages/iguopin-mock.html`);
    await activateAndWait(cdp, iT);
    const iH = await waitPageReady(cdp, iT, "typeof window.__iguopinProbe === 'function'");
    const iDet = await sp.eval('WSA.refresh()');
    report('阶段3: 域名识别 *.iguopin.com → iguopin', iDet && iDet.platform === 'iguopin', 'platform=' + (iDet && iDet.platform));
    const iReview = await sp.eval('WSA.autoFill()');
    const iOk = iReview.filter((r) => r.ok).length;
    report('阶段3: 国聘 mock 自动填命中（≥10 项）', iOk >= 10, `ok=${iOk}/${iReview.length}`);
    const iProbe = await (await attachEval(cdp, iT)).eval('window.__iguopinProbe()');
    const iBad = [];
    const iExpect = { name: vals.name, gender: '男', birth: vals.birthDate, ethnic: '汉', hometown: '江城', political: '共青团员', phone: vals.phone, email: vals.email, school: vals.school, major: vals.major, cet4: '520', cet6: '480', computer: '计算机二级' };
    for (const k of Object.keys(iExpect)) if (iProbe[k] !== iExpect[k]) iBad.push(k);
    report('阶段3: 国聘 mock 字段值正确', iBad.length === 0, iBad.join(',') || '13/13 正确');
    report('阶段3: 家庭成员表格不被误自动填（红线）',
      iProbe.fatherName === '' && iProbe.fatherWork === '' && iProbe.motherName === '' && iProbe.motherWork === '',
      `fatherName="${iProbe.fatherName}" motherName="${iProbe.motherName}"`);
    report('阶段3: textarea 未被自动填', iProbe.reward === '' && iProbe.statement === '', `reward="${iProbe.reward}" statement="${iProbe.statement}"`);

    // ---------- 阶段 1（续）：关开 Edge 后数据仍在 ----------
    step('restart Edge to verify storage persistence');
    await sp.eval('WSA.save()');
    await sleep(1200);
    killEdgeTree(edge);
    await sleep(1500);
    killLeftoverEdge(profileDir);
    freeCdpPorts();
    await sleep(800);
    cdp.ws.close();
    cdp.msgId = 0;
    cdp.pending.clear();
    edge = await launchEdge(cdp, profileDir);
    const extId2 = await findExtId(cdp);
    const sp2 = await openSidepanel(cdp, extId2);
    const st2 = await sp2.eval('(() => { const s = WSA.getState(); const p = s.profiles.find(x=>x.id==="p1"); return JSON.stringify({n: s.profiles.length, phone: p.fields.find(f=>f.key==="phone").value, soe: s.profiles.every(x=>x.templateId==="all" && x.fields.length===51)}); })()');
    const st2Obj = JSON.parse(st2);
    report('阶段1: 关开 Edge 后档案与数据仍在（storage 持久）',
      st2Obj.n === 2 && st2Obj.phone === vals.phone && st2Obj.soe,
      JSON.stringify(st2Obj));
    // ---------- 阶段 4：PDF（本地部分，AI 部分需 key） ----------
    step('打开设置页验证 PDF 管线…');
    const oT = await cdp.createTarget(`chrome-extension://${extId2}/options/options.html`);
    await sleep(800);
    const op = await attachEval(cdp, oT);
    await waitFor('options 初始化', async () => await op.eval('window.__wsaOptions ? "ok" : ""'), 8000);

    // fake-scan.pdf：经真实文件控件进入管线（DOM.setFileInputFiles）
    const doc = await cdp.send('DOM.getDocument', {}, op.sid);
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pdfFile' }, op.sid);
    await cdp.send('DOM.setFileInputFiles', { files: [path.join(ROOT, 'test-pages', 'fake-scan.pdf')], nodeId: q.nodeId }, op.sid);
    await op.eval(`document.getElementById('btnExtract').click()`);
    await sleep(2500);
    const scanInfo = await op.eval(`(() => { const i = __wsaOptions.pdfInfo(); return i ? JSON.stringify({mode: i.mode, pages: i.numPages, len: i.text.length, status: document.getElementById('pdfStatus').textContent.slice(0,80)}) : 'null'; })()`);
    const scan = JSON.parse(scanInfo);
    report('阶段4: fake-scan.pdf 判定为扫描件并走视觉模式', scan.mode === 'vision' && scan.pages === 1 && scan.len < 200,
      `mode=${scan.mode} pages=${scan.pages} textLen=${scan.len}`);

    // 校对/导入链路（用样例数据代替 AI 返回，验证人工校对→确认→入库）
    const sample = {
      name: vals.name, phone: vals.phone, email: vals.email, school: vals.school, major: vals.major,
      degree: '硕士', graduation: '2027-06', gpa: '3.6/4.0',
      languages: ['CET-6', '普通话二级甲等'], skills: ['C/C++', 'STM32', 'RT-Thread'],
      experiences: [{ company: '某科技', role: '固件实习生', start: '2026-03', end: '2026-08', bullets: ['负责电机驱动固件', '排查 DMA 硬件冲突'] }],
      projects: [{ name: '四轴飞控', role: '负责人', start: '2025-09', end: '2026-02', bullets: ['自研姿态解算'] }],
      customs: { '政治面貌': '共青团员', '获奖情况': '全国大学生电子设计竞赛省一等奖' },
    };
    const rvN = await op.eval(`__wsaOptions.dryRunReview(${JSON.stringify(sample)})`);
    report('阶段4: 校对界面渲染（样例提取结果 → 可编辑勾选）', rvN >= 10, 'items=' + rvN);
    await op.eval(`document.getElementById('targetProfile').value = '${soeId}'; __wsaOptions.doImport()`);
    await sleep(300);
    const imported = await sp2.eval(`(() => { const s = WSA.getState(); const p = s.profiles.find(x=>x.id==='${soeId}'); return JSON.stringify({
      name: (p.fields.find(f=>f.key==='name')||{}).value,
      exp: p.fields.filter(f=>f.group==='经历描述').length,
      proj: p.fields.filter(f=>f.group==='项目描述').length,
      customPolitics: (p.fields.find(f=>f.label==='政治面貌')||{}).value }); })()`);
    const impObj = JSON.parse(imported);
    report('阶段4: 确认导入后写入档案（含经历/项目/自定义字段）',
      impObj.name === vals.name && impObj.exp === 1 && impObj.proj === 1 && impObj.customPolitics === '共青团员',
      JSON.stringify(impObj));

    // 真实简历：仅本地 pdf.js 文本抽取（不联网）。设置 WSA_RESUME 环境变量指向任意 PDF 即可启用
    if (RESUME_FILE && fs.existsSync(RESUME_FILE)) {
      const doc2 = await cdp.send('DOM.getDocument', {}, op.sid);
      const q2 = await cdp.send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#pdfFile' }, op.sid);
      await cdp.send('DOM.setFileInputFiles', { files: [RESUME_FILE], nodeId: q2.nodeId }, op.sid);
      await op.eval(`document.getElementById('btnExtract').click()`);
      await sleep(3500);
      const rInfo = await op.eval(`(() => { const i = __wsaOptions.pdfInfo(); return i ? JSON.stringify({mode: i.mode, pages: i.numPages, len: i.text.length}) : 'null'; })()`);
      const ri = JSON.parse(rInfo);
      report('阶段4: 真实简历 PDF 解析成功（pdf.js 抽取文本/页数）', ri.pages >= 1 && (ri.len >= 200 || ri.mode === 'vision'),
        `pages=${ri.pages} textLen=${ri.len} mode=${ri.mode}`);
    } else {
      console.log('SKIP | 阶段4: 真实简历 PDF 解析 | 未设置 WSA_RESUME 环境变量（指向任意本地 PDF 可启用），跳过');
    }

    // ---------- 阶段 6/5：AI 错误路径（无 key）+ CSV ----------
    const aiErr = await sp2.eval(`sendMessage('wsa:aiChat', {payload:{messages:[{role:'user',content:'hi'}]}})`);
    report('阶段6: 未配置 key 时 AI 调用返回可读错误', aiErr && aiErr.ok === false && /尚未配置/.test(aiErr.error || ''), String(aiErr.error).slice(0, 50));

    const swT2 = await waitFor('SW target (CSV)', () => cdp.list().then((l) => l.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url))), 10000);
    const sw2 = await attachEval(cdp, swT2.id);
    const csvOk = await sw2.eval(`(() => {
      const csv = buildCsv([{ts: Date.now(), company: '测试公司', system: 'moka', url: 'http://app.mokahr.com/x', autoCount: 3, manualCount: 1}]);
      return JSON.stringify({ bom: csv.charCodeAt(0) === 0xFEFF, cn: csv.includes('测试公司'), rows: csv.split('\\r\\n').length });
    })()`);
    const csvObj = JSON.parse(csvOk);
    report('阶段5: CSV 导出格式（UTF-8 BOM + 中文可读）', csvOk && csvObj.bom && csvObj.cn, JSON.stringify(csvObj));

    // 安全红线静态检查：filler/detector 不允许出现提交类点击
    const fillerSrc = fs.readFileSync(path.join(ROOT, 'content', 'filler.js'), 'utf8');
    const redline = !/querySelectorAll\(\s*['"]button|type=.?=.?['"]?submit|\.click\(\)[^;]*submit/i.test(fillerSrc) && fillerSrc.includes('决策 #11');
    report('阶段6: 安全红线——填充代码无提交类点击（静态检查）', redline, 'filler.js 静态检查');
  } finally {
    if (!KEEP) {
      killEdgeTree(edge);
      try { httpSrv.kill(); } catch (e) {}
      try { proxySrv.kill(); } catch (e) {}
      await sleep(800);
      killLeftoverEdge(PROFILE_BASE);
      freeCdpPorts();
      await sleep(800);
      await cleanupProfile(PROFILE_BASE);
    } else {
      console.log('\n[--keep] Edge 与本地服务保持运行：CDP=http://127.0.0.1:' + CDP_PORT + '  https=http://127.0.0.1:' + HTTP_PORT + '  proxy=127.0.0.1:' + PROXY_PORT);
    }
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n========== 结果: ${results.length - fails.length}/${results.length} 通过 ==========`);
  if (fails.length) {
    console.log('未通过项:');
    fails.forEach((f) => console.log(' - ' + f.name));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('验收脚本异常:', e.message);
  process.exitCode = 2;
});
