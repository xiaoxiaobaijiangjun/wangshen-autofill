// 设置页：API 设置 / 填充设置 / 简历 PDF 导入（文本→视觉双路 + 人工校对）/ 模板管理
'use strict';

let state = null;
let pdfInfo = null; // {text, numPages, pages, mode}
let extracted = null; // AI 提取结果（待校对）
let reviewItems = []; // {section,label,value,checked,multi,map}

const $ = (s) => document.querySelector(s);

// ============ 初始化 ============

async function init() {
  state = await getState();
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdfjs/pdf.worker.min.js');

  // —— AI 服务商区（可选功能） ——
  const PROV = WangshenTemplates.PROVIDERS;
  const provSel = $('#provider');
  for (const [id, p] of Object.entries(PROV)) provSel.appendChild(new Option(p.name, id));
  provSel.value = state.settings.provider || 'zhipu';
  refreshProviderUI();
  provSel.addEventListener('change', () => {
    state.settings.provider = provSel.value;
    save();
    refreshProviderUI();
  });
  $('#customBase').addEventListener('change', () => {
    state.settings.customBase = $('#customBase').value.trim();
    save();
    requestCustomPermission();
  });
  $('#apiKey').value = (state.settings.apiKeys || {})[state.settings.provider] || '';
  $('#apiKey').addEventListener('change', () => {
    state.settings.apiKeys = state.settings.apiKeys || {};
    state.settings.apiKeys[state.settings.provider] = $('#apiKey').value.trim();
    save();
  });
  $('#model').value = state.settings.model || '';
  $('#model').addEventListener('change', () => {
    state.settings.model = $('#model').value.trim();
    save();
  });
  $('#visionModel').value = state.settings.visionModel || '';
  $('#visionModel').addEventListener('change', () => {
    state.settings.visionModel = $('#visionModel').value.trim();
    save();
  });

  $('#autoThreshold').value = state.settings.autoThreshold;
  $('#thresholdVal').textContent = Number(state.settings.autoThreshold).toFixed(2);
  $('#privacyMask').checked = state.settings.privacyMask !== false;
  $('#autoFloatbar').checked = state.settings.autoFloatbar !== false;

  $('#btnRevealKey').addEventListener('click', () => {
    const k = $('#apiKey');
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    $('#btnRevealKey').textContent = show ? '隐藏' : '显示';
  });
  $('#btnTestKey').addEventListener('click', testConnection);
  $('#autoThreshold').addEventListener('input', () => {
    state.settings.autoThreshold = Number($('#autoThreshold').value);
    $('#thresholdVal').textContent = Number($('#autoThreshold').value).toFixed(2);
    save();
  });
  $('#privacyMask').addEventListener('change', () => {
    state.settings.privacyMask = $('#privacyMask').checked;
    save();
  });
  $('#autoFloatbar').addEventListener('change', () => {
    state.settings.autoFloatbar = $('#autoFloatbar').checked;
    save();
  });

  $('#btnExtract').addEventListener('click', () => {
    const file = $('#pdfFile').files[0];
    if (!file) return toastMsg('请先选择 PDF 文件', 'err');
    runExtract(file);
  });
  $('#btnImport').addEventListener('click', doImport);
  $('#btnBackup').addEventListener('click', doBackup);
  $('#btnRestore').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', doRestore);

  renderTemplates();
  renderTargetProfiles();
}

// 服务商切换后：刷新 Key/模型/提示，并在自定义服务商时请求域名授权
function refreshProviderUI() {
  const providerId = state.settings.provider || 'zhipu';
  const p = WangshenTemplates.PROVIDERS[providerId] || WangshenTemplates.PROVIDERS.zhipu;
  $('#apiKey').value = (state.settings.apiKeys || {})[providerId] || '';
  const modelInput = $('#model');
  modelInput.value = state.settings.model || '';
  modelInput.placeholder = p.models[0] || '服务商模型 ID';
  const vmInput = $('#visionModel');
  vmInput.value = state.settings.visionModel || '';
  vmInput.placeholder = p.visionModels[0] ? '如 ' + p.visionModels[0] + '（留空=用主模型）' : '留空 = 用主模型';
  const ml = $('#modelList');
  ml.innerHTML = '';
  (p.models || []).forEach((m) => ml.appendChild(new Option(m, m)));
  const vl = $('#visionList');
  vl.innerHTML = '';
  (p.visionModels || []).forEach((m) => vl.appendChild(new Option(m, m)));
  $('#providerNote').textContent = p.note || '';
  $('#customBaseRow').style.display = providerId === 'custom' ? '' : 'none';
  $('#customBase').value = state.settings.customBase || '';
}

function requestCustomPermission() {
  const base = (state.settings.customBase || '').trim();
  if (!base) return;
  let origin;
  try {
    origin = new URL(base).origin + '/*';
  } catch (e) {
    return toastMsg('接口地址格式不对，请填完整 URL', 'err');
  }
  chrome.permissions.request({ origins: [origin] }, (granted) => {
    if (granted) toastMsg('已授权访问 ' + origin, 'ok');
    else toastMsg('未授权该域名，AI 请求会被浏览器拦截', 'err');
  });
}

function save() {
  chrome.storage.local.set({ [ROOT_KEY]: state });
}

async function testConnection() {
  const el = $('#testResult');
  el.textContent = '⏳ 测试中…';
  el.className = 'muted';
  const res = await sendMessage('wsa:aiChat', {
    payload: { messages: [{ role: 'user', content: '请只回复两个字：正常' }], maxTokens: 16, temperature: 0.1 },
  });
  if (res.ok) {
    el.textContent = '✓ 连接正常（' + res.model + '）';
    el.className = 'ok';
  } else {
    el.textContent = '✗ ' + res.error;
    el.className = 'err';
  }
}

// ============ 模板管理 ============

function renderTemplates() {
  const root = $('#tplList');
  root.innerHTML = '';
  for (const t of WangshenTemplates.TEMPLATES) {
    const groups = new Map();
    for (const f of t.fields) groups.set(f.group, (groups.get(f.group) || 0) + 1);
    const div = document.createElement('div');
    div.className = 'tpl';
    div.innerHTML = `<b>${t.name}</b> <span class="badge">${t.fields.length} 字段</span> <span class="muted">${[...groups.entries()].map(([g, n]) => `${g}×${n}`).join(' · ')}</span>`;
    root.appendChild(div);
  }
}

function renderTargetProfiles() {
  const sel = $('#targetProfile');
  sel.innerHTML = '';
  for (const p of state.profiles) sel.appendChild(new Option(p.name, p.id));
  // 默认选中当前活跃档案，减少误导入
  if (state.profiles.some((p) => p.id === state.activeProfileId)) {
    sel.value = state.activeProfileId;
  }
}

// ============ PDF 提取管线 ============

async function runExtract(file) {
  const st = $('#pdfStatus');
  try {
    st.textContent = '读取文件…';
    const buf = await file.arrayBuffer();
    await extractFromBytes(new Uint8Array(buf));
  } catch (e) {
    st.innerHTML = '<span class="err">✗ ' + escapeHtml(e.message) + '</span>';
  }
}

async function extractFromBytes(bytes) {
  const st = $('#pdfStatus');
  const btn = $('#btnExtract');
  btn.disabled = true;
  try {
    st.textContent = 'pdf.js 解析中…';
    pdfInfo = await extractPdfText(bytes);
    const mode = decideMode(pdfInfo);
    pdfInfo.mode = mode;

    if (mode === 'vision') {
      st.innerHTML = `判定为扫描件/文本过少（全文 ${pdfInfo.text.length} 字符），走 <b>视觉模式</b>：共 ${pdfInfo.numPages} 页，将按页调用 ${escapeHtml(state.settings.model)}（每页一次请求，注意费用）。`;
    } else {
      st.innerHTML = `文本模式：全文 ${pdfInfo.text.length} 字符 / ${pdfInfo.numPages} 页，调用 1 次请求。`;
    }
    st.innerHTML += '<br>⏳ AI 提取中…（最长 2 分钟）';

    let raw;
    if (mode === 'vision') {
      const pages = await renderPages(bytes);
      st.innerHTML = st.innerHTML.replace('⏳ AI 提取中…（最长 2 分钟）', `⏳ AI 逐页提取中（0/${pages.length}）…`);
      const res = await sendMessage('wsa:aiExtractResume', { payload: { pages } });
      if (!res.ok) throw new Error(res.error);
      raw = res.data;
    } else {
      const sys = resumeSchemaPrompt();
      const res = await sendMessage('wsa:aiExtractResume', {
        payload: {
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: '以下是一份简历的全文，请提取为 JSON：\n\n' + pdfInfo.text },
          ],
        },
      });
      if (!res.ok) throw new Error(res.error);
      raw = res.data;
    }
    extracted = raw;
    buildReviewItems(extracted);
    renderReview();
    st.innerHTML += ' <span class="ok">✓ 提取完成，请在下方校对。</span>';
    $('#importRow').style.display = '';
    renderTargetProfiles();
  } finally {
    btn.disabled = false;
  }
}

function resumeSchemaPrompt() {
  return (
    '你是简历信息抽取助手。请从简历全文中提取信息，只输出一个 JSON 对象，不要输出任何其他文字。' +
    'JSON 字段：name(姓名), phone(手机号), email(邮箱), school(毕业院校), major(专业), degree(学历), graduation(毕业时间), ' +
    'gpa(绩点或排名), languages(数组,语言/证书), skills(数组,技能), ' +
    'experiences(数组,每项{company,role,start,end,bullets:[字符串数组]}), ' +
    'projects(数组,每项{name,role,start,end,bullets:[字符串数组]}), ' +
    'customs(对象,其他所有能识别到的字段,如政治面貌/籍贯/四六级/获奖等,键用中文标签)。' +
    '没有的字段省略或留空，不要编造。'
  );
}

async function extractPdfText(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  let full = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str).join(' ').replace(/[ \t]+/g, ' ').trim();
    pages.push(text);
    full += text + '\n';
  }
  return { text: full.trim(), numPages: doc.numPages, pages };
}

function garbleRatio(text) {
  const chars = [...String(text || '')].filter((c) => !/\s/.test(c));
  if (!chars.length) return 1;
  const okChars = chars.filter(
    (c) => /[\u4e00-\u9fa5\u3000-\u303fA-Za-z0-9]/.test(c) || '.,:;!?()[]{}<>/@#$%&*+=_-|\'"、。，；：！？（）《》“”‘’·…—％／'.includes(c)
  );
  return 1 - okChars.length / chars.length;
}

function decideMode(info) {
  if (info.text.length < 200) return 'vision';
  if (garbleRatio(info.text) > 0.3) return 'vision';
  return 'text';
}

async function renderPages(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1600 / vp0.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    out.push({ dataUrl: canvas.toDataURL('image/png'), hint: i });
  }
  return out;
}

// ============ 校对界面 ============

const SCALAR_LABELS = {
  name: '姓名', phone: '手机号', email: '邮箱', school: '毕业院校',
  major: '专业', degree: '学历', graduation: '毕业时间', gpa: 'GPA/排名',
};

function buildReviewItems(data) {
  reviewItems = [];
  for (const key of Object.keys(SCALAR_LABELS)) {
    if (data[key]) {
      reviewItems.push({
        section: '基本信息',
        label: SCALAR_LABELS[key],
        value: String(data[key]),
        checked: true,
        multi: false,
        map: { kind: 'field', key },
      });
    }
  }
  const joinArr = (v) => (Array.isArray(v) ? v.join('、') : String(v || ''));
  if (data.skills && (Array.isArray(data.skills) ? data.skills.length : String(data.skills).trim())) {
    reviewItems.push({ section: '技能与语言', label: '技能特长', value: joinArr(data.skills), checked: true, multi: false, map: { kind: 'field', key: 'skills' } });
  }
  if (data.languages && (Array.isArray(data.languages) ? data.languages.length : String(data.languages).trim())) {
    reviewItems.push({ section: '技能与语言', label: '语言/证书', value: joinArr(data.languages), checked: true, multi: false, map: { kind: 'customField', label: '语言证书', group: '教育背景', inputType: 'text' } });
  }
  for (const [i, e] of (data.experiences || []).entries()) {
    const val = expToText(e);
    if (!val.trim()) continue;
    reviewItems.push({
      section: '经历',
      label: `经历${i + 1}·${e.company || e.role || ''}`,
      value: val,
      checked: true,
      multi: true,
      map: { kind: 'exp', label: `经历${i + 1}：${e.company || ''}${e.role ? '·' + e.role : ''}`, group: '经历描述' },
    });
  }
  for (const [i, p] of (data.projects || []).entries()) {
    const val = expToText(p);
    if (!val.trim()) continue;
    reviewItems.push({
      section: '项目',
      label: `项目${i + 1}·${p.name || p.role || ''}`,
      value: val,
      checked: true,
      multi: true,
      map: { kind: 'exp', label: `项目${i + 1}：${p.name || ''}${p.role ? '·' + p.role : ''}`, group: '项目描述' },
    });
  }
  for (const [k, v] of Object.entries(data.customs || {})) {
    if (v == null || String(v).trim() === '') continue;
    reviewItems.push({
      section: '其他',
      label: k,
      value: typeof v === 'object' ? JSON.stringify(v) : String(v),
      checked: true,
      multi: String(v).length > 40,
      map: { kind: 'customField', label: k, group: '其他', inputType: String(v).length > 40 ? 'textarea' : 'text' },
    });
  }
}

function expToText(e) {
  const period = [e.start, e.end].filter(Boolean).join(' ~ ');
  const bullets = (e.bullets || []).map((b) => '· ' + b);
  return [period, bullets.join('\n')].filter(Boolean).join('\n');
}

function renderReview() {
  const root = $('#pdfReview');
  root.innerHTML = '';
  if (!reviewItems.length) {
    root.innerHTML = '<p class="warn">没有提取到可导入的字段。</p>';
    return;
  }
  const warn = document.createElement('div');
  warn.className = 'banner warn';
  warn.style.cssText = 'background:#fff7e6;border:1px solid #ffe1a6;border-radius:8px;padding:8px 10px;margin-bottom:10px';
  warn.textContent = '校对区：请逐项核对 AI 提取结果，取消勾选即不导入；确认无误后点底部「确认导入」。';
  root.appendChild(warn);

  let lastSec = '';
  for (const [idx, it] of reviewItems.entries()) {
    if (it.section !== lastSec) {
      lastSec = it.section;
      const h = document.createElement('div');
      h.className = 'rv-section';
      h.innerHTML = `<h3>${it.section}</h3>`;
      root.appendChild(h);
    }
    const secBox = root.lastElementChild;
    const row = document.createElement('div');
    row.className = 'rv';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.checked;
    cb.addEventListener('change', () => {
      it.checked = cb.checked;
      input.classList.toggle('unchecked', !cb.checked);
    });
    const lb = document.createElement('span');
    lb.className = 'rl';
    lb.textContent = it.label;
    let input;
    if (it.multi) {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = 'text';
    }
    input.value = it.value;
    input.addEventListener('input', () => (it.value = input.value));
    row.appendChild(cb);
    row.appendChild(lb);
    row.appendChild(input);
    secBox.appendChild(row);
  }
}

// ============ 导入（确认后才写档案） ============

function doImport() {
  const targetId = $('#targetProfile').value;
  const prof = state.profiles.find((p) => p.id === targetId);
  if (!prof) return toastMsg('找不到目标档案', 'err');
  const picked = reviewItems.filter((i) => i.checked);
  if (!picked.length) return toastMsg('没有勾选任何字段', 'err');
  let created = 0;
  for (const it of picked) {
    if (it.map.kind === 'field') {
      let f = prof.fields.find((x) => x.key === it.map.key);
      if (!f) {
        f = newCustomField(prof, it.label, '其他', 'text');
        created++;
      }
      f.value = it.value;
      if (it.map.key === 'phone' || it.map.key === 'idCard') f.sensitive = true;
    } else if (it.map.kind === 'exp' || it.map.kind === 'customField') {
      const label = it.map.label;
      const exist = prof.fields.find((x) => x.custom && x.label === label);
      if (exist) {
        exist.value = it.value;
      } else {
        newCustomField(prof, label, it.map.group, it.map.inputType || 'text', it.value);
        created++;
      }
    }
  }
  save();
  toastMsg(`已导入 ${picked.length} 项到「${prof.name}」（新增 ${created} 个自定义字段），可在侧边栏字段库查看`, 'ok');
  $('#pdfReview').innerHTML = '<p class="ok">✓ 已导入。如需重新导入请再次提取。</p>';
  $('#importRow').style.display = 'none';
  extracted = null;
  reviewItems = [];
}

function newCustomField(prof, label, group, inputType, value) {
  const f = {
    fid: makeId('fc'),
    key: 'c_' + makeId(''),
    label,
    value: value || '',
    group,
    inputType: inputType || 'text',
    sensitive: false,
    autoFill: inputType !== 'textarea',
    material: false,
    custom: true,
  };
  prof.fields.push(f);
  return f;
}

// ============ 档案备份导出 / 恢复（不含 API Key） ============

function backupMsg(text) {
  $('#backupMsg').innerHTML = text;
}

function doBackup() {
  const payload = {
    kind: 'wangshen-autofill-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  a.href = url;
  a.download = `网申助手档案备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  backupMsg(`✓ 已导出 ${state.profiles.length} 个档案（不含 API Key）。文件在浏览器默认下载目录。`);
}

async function doRestore(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.kind !== 'wangshen-autofill-backup' || !Array.isArray(data.profiles) || !data.profiles.length) {
      throw new Error('不是本插件导出的备份文件');
    }
    const valid = data.profiles.filter((p) => p && p.id && p.name && Array.isArray(p.fields));
    if (!valid.length) throw new Error('备份里没有可用档案');
    if (!confirm(`将用备份里的 ${valid.length} 个档案替换当前全部档案（共 ${state.profiles.length} 个）。设置和 API Key 不变，继续？`)) return;
    state.profiles = valid.map((p) => WangshenTemplates.upgradeProfile(p)); // 兼容老备份，顺手升级全字段
    state.activeProfileId = valid.some((p) => p.id === data.activeProfileId) ? data.activeProfileId : valid[0].id;
    save();
    backupMsg(`✓ 已恢复 ${valid.length} 个档案（${new Date(data.exportedAt).toLocaleString()} 导出）。`);
    renderTargetProfiles();
    toastMsg('档案恢复完成', 'ok');
  } catch (e) {
    backupMsg('<span class="err">✗ 恢复失败：' + escapeHtml(e.message) + '</span>');
  }
}

// ============ 调试钩子（自动化验收用） ============

window.__wsaOptions = {
  extractPdfText,
  garbleRatio,
  decideMode,
  extractFromBytes,
  dryRunReview: (data) => {
    extracted = data;
    buildReviewItems(data);
    renderReview();
    return reviewItems.length;
  },
  doImport,
  pdfInfo: () => pdfInfo,
  reviewItems: () => reviewItems,
  state: () => state,
};

init();
