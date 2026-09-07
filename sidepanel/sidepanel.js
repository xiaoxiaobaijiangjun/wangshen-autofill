// 侧边栏主逻辑：字段库 / 档案切换 / 检测与填充 / AI 起草 / 台账 / 附件提醒
'use strict';

let state = null; // 最近一次 storage 快照
let expectedJson = ''; // 自己写入的预期值，onChanged 时用于忽略自身写入
let revealed = new Set(); // 本会话点按显示过的敏感字段 fid
let revealAll = false;
let detection = null; // 当前活动标签页的检测结果（publicState）
let detectionTabId = null;
let detectionError = '';
let review = []; // 一键填充后的复查清单
let openPreviews = {}; // qId -> 起草的预览文本（可编辑）
let lastDetectionUrl = ''; // 换页面时清空旧复查记录和草稿预览

const $ = (sel) => document.querySelector(sel);
const main = {
  fields: $('#tab-fields'),
  fill: $('#tab-fill'),
  ledger: $('#tab-ledger'),
  materials: $('#tab-materials'),
};

// ============ 保存 ============

function scheduleSave() {
  expectedJson = JSON.stringify(state);
  chrome.storage.local.set({ [ROOT_KEY]: state });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[ROOT_KEY]) return;
  const next = JSON.stringify(changes[ROOT_KEY].newValue);
  if (next === expectedJson) return; // 自己写入
  getState().then((s) => {
    state = s;
    renderAll();
  });
});

// ============ 初始化 ============

async function init() {
  state = await getState();
  renderAll();
  await refreshDetection();
  renderFillTab();

  chrome.tabs.onActivated.addListener(() => scheduleRefresh(250));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (detectionTabId === tabId && (info.status === 'complete' || info.url)) scheduleRefresh(600);
  });

  $('#profileSel').addEventListener('change', (e) => {
    state.activeProfileId = e.target.value;
    scheduleSave();
    renderAll();
  });
  $('#btnNewProfile').addEventListener('click', onNewProfile);
  $('#btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // ⋯ 菜单：重命名 / 删除 / 敏感信息显示
  const moreMenu = $('#moreMenu');
  $('#btnMore').addEventListener('click', (e) => {
    e.stopPropagation();
    updateMenuReveal();
    moreMenu.hidden = !moreMenu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!moreMenu.hidden && !e.target.closest('.menu-wrap')) moreMenu.hidden = true;
  });
  moreMenu.addEventListener('click', (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    if (!act) return;
    moreMenu.hidden = true;
    if (act === 'rename') onRenameProfile();
    if (act === 'delete') onDeleteProfile();
    if (act === 'reveal') {
      revealAll = !revealAll;
      renderFieldsTab();
    }
  });

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      Object.entries(main).forEach(([k, sec]) => (sec.hidden = k !== b.dataset.tab));
      if (b.dataset.tab === 'fill') {
        renderFillTab();
        scheduleRefresh(0);
      }
    });
  });
}

let refreshTimer = null;
function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshDetection();
    renderFillTab();
  }, delay);
}

// ============ 检测 ============

async function refreshDetection() {
  detectionError = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
      detection = null;
      detectionError = '当前页面不是普通网页（如浏览器内页），无法检测表单。';
      return;
    }
    const res = await sendToTab(tab.id, 'wsa:getState');
    if (!res.ok) {
      detection = null;
      detectionError = '本页未注入检测脚本（刷新页面后重试）。';
      return;
    }
    if (res.state.url !== lastDetectionUrl) {
      review = [];
      openPreviews = {};
      lastDetectionUrl = res.state.url;
    }
    detection = res.state;
    detectionTabId = tab.id;
  } catch (e) {
    detection = null;
    detectionError = '检测失败：' + e.message;
  }
}

// ============ 渲染总入口 ============

function renderAll() {
  renderProfileBar();
  renderFieldsTab();
  renderFillTab();
  renderLedgerTab();
  renderMaterialsTab();
}

function renderProfileBar() {
  const sel = $('#profileSel');
  sel.innerHTML = '';
  for (const p of state.profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    if (p.id === state.activeProfileId) o.selected = true;
    sel.appendChild(o);
  }
}

// ============ 字段库 ============

function renderFieldsTab() {
  const prof = getActiveProfile(state);
  const { groups, map } = groupProfileFields(prof);
  const root = main.fields;
  root.innerHTML = '';

  // 首次使用引导：讲清"不用 AI 也能用"
  if (!state.onboardingDone) {
    const b = document.createElement('div');
    b.className = 'card';
    b.style.borderColor = '#c7d5ff';
    b.innerHTML = `
      <b>👋 两种用法，选适合你的：</b>
      <div class="muted" style="margin:6px 0 2px">① <b>不用 AI（零配置）</b>：直接在下面分组里把信息填好 → 打开网申页 → 「填充」页点一键填充。</div>
      <div class="muted" style="margin:0 0 8px">② 用 AI（可选）：右上角 ⚙ 配置任一家 API Key，解锁 PDF 自动提取和开放题起草。</div>`;
    const ok = document.createElement('button');
    ok.className = 'btn plain';
    ok.textContent = '知道了，开始填写';
    ok.addEventListener('click', () => {
      state.onboardingDone = true;
      scheduleSave();
      renderFieldsTab();
    });
    b.appendChild(ok);
    root.appendChild(b);
  }

  for (const g of groups) {
    const det = document.createElement('details');
    det.className = 'group';
    if (g !== '开放题素材') det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = `${escapeHtml(g)} <span class="muted">${map.get(g).length}</span>`;
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'gbody';

    for (const f of map.get(g)) body.appendChild(fieldRow(f));
    body.appendChild(addForm(g));
    det.appendChild(body);
    root.appendChild(det);
  }

  const tip = document.createElement('div');
  tip.className = 'hint';
  tip.textContent = '提示：一键填充只填档案里有值的字段（勾掉「自动」可排除某个字段）；开放题素材供 AI 起草引用；PDF 导入在设置页 ⚙。';
  root.appendChild(tip);
}

function fieldRow(f) {
  const row = document.createElement('div');
  row.className = 'frow';

  const lb = document.createElement('span');
  lb.className = 'flabel';
  lb.title = f.label + (f.custom ? '（自定义）' : '');
  lb.innerHTML = `${escapeHtml(f.label)}${f.sensitive ? ' <span class="lock">🔒</span>' : ''}`;
  row.appendChild(lb);

  let input;
  if (f.inputType === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 3;
  } else if (f.inputType === 'select') {
    input = document.createElement('select');
    input.appendChild(new Option('（未选择）', ''));
    for (const o of f.options || []) input.appendChild(new Option(o, o));
    input.value = f.value || '';
  } else {
    input = document.createElement('input');
    input.type = 'text';
  }
  if (f.inputType !== 'select') input.value = f.value || '';
  input.dataset.fid = f.fid;
  if (f.sensitive && state.settings.privacyMask && !revealAll && !revealed.has(f.fid) && f.inputType === 'text') {
    input.classList.add('masked');
    input.placeholder = '••••（点眼睛可见）';
  } else if (f.sensitive && f.inputType === 'text') {
    input.placeholder = '敏感字段';
  }
  const onEdit = () => {
    f.value = input.value;
    scheduleSave();
  };
  input.addEventListener(f.inputType === 'select' ? 'change' : 'input', onEdit);
  row.appendChild(input);

  if (f.sensitive) {
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.textContent = '👁';
    eye.title = '显示/隐藏';
    eye.addEventListener('click', () => {
      if (revealed.has(f.fid)) revealed.delete(f.fid);
      else revealed.add(f.fid);
      renderFieldsTab();
    });
    row.appendChild(eye);
  }

  const at = document.createElement('label');
  at.className = 'autotoggle';
  at.title = '参与一键自动填充';
  const acb = document.createElement('input');
  acb.type = 'checkbox';
  acb.checked = !!f.autoFill;
  acb.addEventListener('change', () => {
    f.autoFill = acb.checked;
    scheduleSave();
  });
  at.appendChild(acb);
  at.appendChild(document.createTextNode('自动'));
  row.appendChild(at);

  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '✕';
  del.title = '删除字段';
  del.addEventListener('click', () => {
    if (!confirm(`删除字段「${f.label}」？`)) return;
    const prof = getActiveProfile(state);
    prof.fields = prof.fields.filter((x) => x.fid !== f.fid);
    scheduleSave();
    renderFieldsTab();
  });
  row.appendChild(del);
  return row;
}

function addForm(groupName) {
  const form = document.createElement('div');
  form.className = 'addform';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = '新字段名称…';
  const type = document.createElement('select');
  type.appendChild(new Option('文本', 'text'));
  type.appendChild(new Option('多行文本', 'textarea'));
  const btn = document.createElement('button');
  btn.className = 'btn plain';
  btn.textContent = '＋添加';
  btn.addEventListener('click', () => {
    const label = name.value.trim();
    if (!label) return;
    const prof = getActiveProfile(state);
    prof.fields.push({
      fid: makeId('fc'),
      key: 'c_' + makeId(''),
      label,
      value: '',
      group: groupName,
      inputType: type.value,
      sensitive: false,
      autoFill: type.value !== 'textarea',
      material: groupName === '开放题素材',
      custom: true,
    });
    scheduleSave();
    renderFieldsTab();
  });
  form.appendChild(name);
  form.appendChild(type);
  form.appendChild(btn);
  return form;
}

// ============ 填充页 ============

function renderFillTab() {
  const root = main.fill;
  root.innerHTML = '';
  const prof = getActiveProfile(state);

  const info = document.createElement('div');
  info.className = 'card';
  if (detectionError) {
    info.innerHTML = `<div class="muted">${escapeHtml(detectionError)}</div>`;
  } else if (detection) {
    const c = detection.counts;
    info.innerHTML = `
      <div class="pageinfo">
        <span class="badge">${escapeHtml(PLATFORM_NAMES[detection.platform] || detection.platform)}</span>
        <span class="pageurl" title="${escapeHtml(detection.url)}">${escapeHtml(detection.title || detection.url)}</span>
        <button class="btn ghost" id="btnRedetect">↻重新检测</button>
      </div>
      <div class="muted">可自动填 <b>${c.auto}</b> 项 · 点选 <b>${c.manual}</b> 项 · 开放题 <b>${c.open}</b> 题</div>
    `;
  } else {
    info.innerHTML = '<div class="muted">尚未检测到页面，打开一个网申页试试。</div>';
  }
  root.appendChild(info);
  const bd = info.querySelector('#btnRedetect');
  if (bd) bd.addEventListener('click', () => scheduleRefresh(0));

  if (detection && detection.hasCaptcha) {
    const b = document.createElement('div');
    b.className = 'banner red';
    b.textContent = '⚠ 检测到验证码类控件，已自动跳过，请手动完成。';
    root.appendChild(b);
  }

  if (detection && detection.fileInputs.length) {
    const b = document.createElement('div');
    b.className = 'banner';
    const mats = (prof.materials || []).map((m) => m.name).join('、') || '（当前档案尚未登记材料，去「附件」页添加）';
    b.innerHTML = `📎 本页有上传控件（${escapeHtml(detection.fileInputs.map((f) => f.label).join('、'))}）。<br>该传的材料：${escapeHtml(mats)}`;
    root.appendChild(b);
  }

  if (!detection) return;

  // —— 自动区 ——
  const autos = detection.fields.filter((f) => f.cls === 'auto');
  const fillable = autos.filter((f) => {
    const pf = findProfileFieldByKey(prof, f.key);
    return pf && pf.autoFill !== false && (pf.value || '').trim();
  });
  const autoCard = document.createElement('div');
  autoCard.className = 'card';
  autoCard.innerHTML = `<div class="subhead">⚡ 可自动填 <span class="n">${autos.length}</span> 项</div>`;
  if (autos.length) {
    const btn = document.createElement('button');
    btn.className = 'btn big';
    btn.id = 'btnAutoFill';
    btn.textContent = fillable.length ? `一键填充 ${fillable.length} 项` : '一键填充（档案里暂无可填的值）';
    btn.disabled = !fillable.length;
    btn.addEventListener('click', onAutoFill);
    autoCard.appendChild(btn);
    const list = document.createElement('div');
    list.style.marginTop = '8px';
    for (const f of autos) {
      const pf = findProfileFieldByKey(prof, f.key);
      const row = document.createElement('div');
      row.className = 'rrow';
      const status = pf && (pf.value || '').trim() ? '✓' : '—';
      row.innerHTML = `<span class="k" title="${escapeHtml(f.label)}">${escapeHtml(f.label)}</span><span class="arrow">←</span><span class="v muted">${escapeHtml(pf ? pf.label : '未匹配档案字段')} ${status}</span>`;
      list.appendChild(row);
    }
    autoCard.appendChild(list);
    if (!fillable.length) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.style.marginTop = '8px';
      hint.textContent = '档案里还没有可填的值。把信息填进「字段库」后回来点一键填充；AI 相关功能不配置也完全不影响这一步。';
      const go = document.createElement('button');
      go.className = 'btn ghost';
      go.style.marginTop = '6px';
      go.textContent = '去字段库填写 →';
      go.addEventListener('click', () => document.querySelector('.tabs button[data-tab="fields"]').click());
      hint.appendChild(document.createElement('br'));
      hint.appendChild(go);
      autoCard.appendChild(hint);
    }
  } else {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '本页没有可自动填充的短字段。';
    autoCard.appendChild(d);
  }
  root.appendChild(autoCard);

  // —— 点选区 ——
  const manuals = detection.fields.filter((f) => f.cls === 'manual');
  if (manuals.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="subhead">👆 点选区 <span class="n">${manuals.length}</span> 项</div>`;
    for (const f of manuals) card.appendChild(manualItem(f, prof));
    root.appendChild(card);
  }

  // —— 开放题 ——
  const opens = detection.fields.filter((f) => f.cls === 'open');
  if (opens.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="subhead">✨ 开放题 <span class="n">${opens.length}</span> 题</div>`;
    for (const f of opens) card.appendChild(openItem(f, prof));
    root.appendChild(card);
  }

  // —— 复查清单（同名字段去重，✓ 优先；×n 表示该字段命中了多处输入框） ——
  if (review.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="subhead">📋 复查清单</div>';
    const merged = new Map();
    for (const r of review) {
      const e = merged.get(r.label);
      if (!e) {
        merged.set(r.label, { ...r, n: 1 });
      } else {
        e.n++;
        if (r.ok) {
          e.ok = true;
          e.reason = undefined;
          if (r.actualValue != null) e.value = r.actualValue;
        }
      }
    }
    for (const r of merged.values()) {
      const row = document.createElement('div');
      row.className = 'rrow';
      const tag = r.n > 1 ? `（×${r.n}）` : '';
      const pf = r.pfSensitive && state.settings.privacyMask && !revealAll ? '••••' : r.value;
      row.innerHTML = r.ok
        ? `<span class="k">${escapeHtml(r.label)}${tag}</span><span class="v ok">✓</span><span class="v">${escapeHtml(pf)}</span>`
        : `<span class="k">${escapeHtml(r.label)}${tag}</span><span class="v err">✗ ${escapeHtml(r.reason || '失败')}</span>`;
      card.appendChild(row);
    }
    root.appendChild(card);
  }
}

function findProfileFieldByKey(prof, key) {
  if (!key) return null;
  return prof.fields.find((f) => f.key === key) || null;
}

function manualItem(f, prof) {
  const div = document.createElement('div');
  div.className = 'fitem';
  const l1 = document.createElement('div');
  l1.className = 'l1';
  l1.innerHTML = `<span class="name" title="${escapeHtml(f.label)}">${escapeHtml(f.label)}</span><span class="score">${f.score}</span>`;

  const l2 = document.createElement('div');
  l2.className = 'l2';
  const sel = document.createElement('select');
  sel.className = 'map';
  sel.appendChild(new Option('选择档案字段…', ''));
  const nonMaterial = prof.fields.filter((x) => !x.material);
  for (const pf of nonMaterial) sel.appendChild(new Option(pf.label + (pf.value ? '' : '（空）'), pf.fid));
  const matched = findProfileFieldByKey(prof, f.key);
  if (matched) sel.value = matched.fid;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = '填入';
  btn.addEventListener('click', async () => {
    const pf = prof.fields.find((x) => x.fid === sel.value);
    if (!pf) return toastMsg('请先选择要填入的档案字段', 'err');
    if (!pf.value.trim()) return toastMsg(`「${pf.label}」在档案里是空的`, 'err');
    await doFillOne(f, pf, btn);
  });
  l2.appendChild(sel);
  l2.appendChild(btn);
  div.appendChild(l1);
  div.appendChild(l2);
  return div;
}

function openItem(f, prof) {
  const div = document.createElement('div');
  div.className = 'fitem';
  div.dataset.qid = f.id;
  const l1 = document.createElement('div');
  l1.className = 'l1';
  l1.innerHTML = `<span class="name" title="${escapeHtml(f.label)}">✨ ${escapeHtml(f.label)}</span>`;
  const bDraft = document.createElement('button');
  bDraft.className = 'btn plain';
  bDraft.textContent = '✨起草';
  bDraft.addEventListener('click', () => draftOpen(f, bDraft));
  l1.appendChild(bDraft);
  div.appendChild(l1);

  const preview = document.createElement('textarea');
  preview.className = 'preview';
  preview.placeholder = '点「✨起草」用档案素材生成草稿，也可直接在这里写。';
  preview.value = openPreviews[f.id] || '';
  preview.addEventListener('input', () => (openPreviews[f.id] = preview.value));
  div.appendChild(preview);

  const l2 = document.createElement('div');
  l2.className = 'l2';
  const bFill = document.createElement('button');
  bFill.className = 'btn';
  bFill.textContent = '填入';
  bFill.addEventListener('click', async () => {
    const text = (openPreviews[f.id] || '').trim();
    if (!text) return toastMsg('草稿为空', 'err');
    bFill.disabled = true;
    const res = await sendToTab(detectionTabId, 'wsa:fillOne', {
      item: { id: f.id, label: f.label, value: text, inputType: f.inputType },
    });
    bFill.disabled = false;
    handleFillResponse(res, { label: f.label, value: text, pfSensitive: false });
  });
  const bAgain = document.createElement('button');
  bAgain.className = 'btn ghost';
  bAgain.textContent = '换一版';
  bAgain.addEventListener('click', () => draftOpen(f, bAgain));
  l2.appendChild(bFill);
  l2.appendChild(bAgain);
  div.appendChild(l2);

  // 历史（最多 3 版，按档案持久化）
  const hist = ((state.drafts || {})[prof.id] || {})[f.id] || [];
  if (hist.length) {
    const det = document.createElement('details');
    det.className = 'muted';
    const sum = document.createElement('summary');
    sum.textContent = `历史草稿 ${hist.length} 版`;
    det.appendChild(sum);
    hist.forEach((h, i) => {
      const item = document.createElement('div');
      item.className = 'rrow';
      item.style.cursor = 'pointer';
      item.title = '点击载入到预览';
      item.innerHTML = `<span class="k">${i === 0 ? '上一版' : '第' + (hist.length - i) + '版'} ${fmtTs(h.ts)}</span><span class="v">${escapeHtml(h.text.slice(0, 60))}…</span>`;
      item.addEventListener('click', () => {
        openPreviews[f.id] = h.text;
        preview.value = h.text;
      });
      det.appendChild(item);
    });
    div.appendChild(det);
  }
  return div;
}

async function draftOpen(f, btn) {
  // 未配置 Key：引导而不是报错。不用 AI 的用户直接在预览框手写即可。
  const curKey = ((state.settings.apiKeys || {})[state.settings.provider || 'zhipu']) || '';
  if (!curKey) {
    if (confirm('开放题 AI 起草需要先配置任一家 AI 服务的 Key。\n不配置也完全可以：直接在下方输入框手写答案。\n\n现在去设置页配置吗？')) {
      chrome.runtime.openOptionsPage();
    }
    return;
  }
  btn.disabled = true;
  btn.textContent = '⏳生成中';
  try {
    const prof = getActiveProfile(state);
    const mats = prof.fields.filter((x) => x.material && (x.value || '').trim());
    const matText = mats.map((x) => `【${x.label.replace(/（素材）$/, '')}】\n${x.value}`).join('\n\n');
    const m = f.label.match(/(\d+)\s*字/);
    const wordLimit = m ? Math.max(50, Math.min(Number(m[1]), 500)) : 300;
    const sys =
      '你是帮中国应届毕业生起草招聘网申开放题答案的助手。要求：中文，第一人称，语气真诚自然、具体不空洞，' +
      '紧密结合给出的个人素材，不堆砌辞藻、不喊口号；直接输出答案正文，不要标题、不要解释、不要任何markdown符号。';
    const user =
      `题目：${f.label}\n字数要求：不超过${wordLimit}字。\n` +
      `个人素材：\n${matText || '（素材为空：请写一个通用但真诚的版本，避免编造具体经历。）'}\n` +
      `请直接输出答案正文。`;
    const res = await sendMessage('wsa:aiChat', {
      payload: {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        maxTokens: 1024,
        temperature: 0.7,
      },
    });
    if (!res.ok) throw new Error(res.error || 'AI 调用失败');
    let text = (res.content || '').trim();
    if (text.length > wordLimit + 50) text = text.slice(0, wordLimit + 50);
    if (!text) throw new Error('AI 返回为空');
    openPreviews[f.id] = text;
    // 持久化草稿历史（每题最多 3 版）
    state.drafts = state.drafts || {};
    state.drafts[prof.id] = state.drafts[prof.id] || {};
    const arr = state.drafts[prof.id][f.id] || [];
    arr.unshift({ ts: Date.now(), text });
    state.drafts[prof.id][f.id] = arr.slice(0, 3);
    scheduleSave();
    renderFillTab();
  } catch (e) {
    toastMsg(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨起草';
  }
}

// ============ 填充执行 ============

async function onAutoFill() {
  const btn = $('#btnAutoFill');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 填充中…';
  }
  try {
    const prof = getActiveProfile(state);
    const items = [];
    for (const f of detection.fields.filter((x) => x.cls === 'auto')) {
      const pf = findProfileFieldByKey(prof, f.key);
      if (!pf || pf.autoFill === false) continue;
      if (!(pf.value || '').trim()) continue; // 没值就跳过，不进复查清单制造噪音
      items.push({
        id: f.id,
        label: pf.label,
        value: pf.value,
        inputType: f.inputType,
        options: f.options,
        masked: pf.sensitive,
      });
    }
    if (!items.length) {
      toastMsg('档案里没有可自动填的值；长文本请在下方点选区手动填', 'err');
      return;
    }
    const res = await sendToTab(detectionTabId, 'wsa:autofill', { items });
    review = (res.results || []).map((r) => ({ ...r, pfSensitive: !!items.find((i) => i.id === r.id && i.masked) }));
    const okCount = review.filter((r) => r.ok).length;
    addLedger({ autoCount: okCount, manualCount: 0 });
    toastMsg(`自动填充完成：成功 ${okCount}/${items.length}`, okCount ? 'ok' : 'err');
  } catch (e) {
    toastMsg('填充失败：' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      const prof = getActiveProfile(state);
      const n = detection
        ? detection.fields.filter((x) => {
            if (x.cls !== 'auto') return false;
            const pf = findProfileFieldByKey(prof, x.key);
            return pf && pf.autoFill !== false && (pf.value || '').trim();
          }).length
        : 0;
      btn.textContent = `一键填充 ${n} 项`;
    }
    renderFillTab();
  }
}

async function doFillOne(f, pf, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await sendToTab(detectionTabId, 'wsa:fillOne', {
      item: {
        id: f.id,
        label: pf.label,
        value: pf.value,
        inputType: f.inputType,
        options: f.options,
        masked: pf.sensitive,
      },
    });
    handleFillResponse(res, { label: pf.label, value: pf.value, pfSensitive: pf.sensitive });
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleFillResponse(res, info) {
  if (!res.ok) return toastMsg(res.error || '填充失败', 'err');
  const r = res.results && res.results[0];
  if (!r) return;
  review = review.filter((x) => x.id !== r.id);
  review.push({ ...r, label: info.label || r.label, value: r.actualValue != null ? r.actualValue : info.value, pfSensitive: info.pfSensitive });
  if (r.ok) {
    // 台账：首次点选记一行，后续同页点选累加
    if (res.manualFirst) {
      addLedger({ autoCount: 0, manualCount: 1 });
    } else {
      bumpManualLedger();
    }
    toastMsg(`已填入「${info.label}」`, 'ok');
  } else {
    toastMsg(r.reason || '填充失败', 'err');
  }
  renderFillTab();
}

// ============ 台账 ============

function ledgerRowUrl() {
  return detection ? detection.url : '';
}

function inferCompany() {
  if (!detection) return '';
  try {
    return new URL(detection.url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function addLedger({ autoCount, manualCount }) {
  state.ledger.unshift({
    ts: Date.now(),
    company: inferCompany(),
    system: detection ? detection.platform : '',
    url: ledgerRowUrl(),
    autoCount,
    manualCount,
  });
  scheduleSave();
  renderLedgerTab();
}

function bumpManualLedger() {
  const url = ledgerRowUrl();
  const row = state.ledger.find((r) => r.url === url);
  if (row) {
    row.manualCount = (row.manualCount || 0) + 1;
  } else {
    state.ledger.unshift({ ts: Date.now(), company: inferCompany(), system: detection ? detection.platform : '', url, autoCount: 0, manualCount: 1 });
  }
  scheduleSave();
  renderLedgerTab();
}

function renderLedgerTab() {
  const root = main.ledger;
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'subhead';
  head.innerHTML = `📖 投递台账 <span class="n">${state.ledger.length}</span> 条`;
  const bExport = document.createElement('button');
  bExport.className = 'btn';
  bExport.textContent = '导出 CSV';
  bExport.addEventListener('click', exportCsv);
  const bClear = document.createElement('button');
  bClear.className = 'btn danger';
  bClear.textContent = '清空';
  bClear.addEventListener('click', () => {
    if (!confirm('清空全部台账记录？')) return;
    state.ledger = [];
    scheduleSave();
    renderLedgerTab();
  });
  head.appendChild(bExport);
  head.appendChild(bClear);
  card.appendChild(head);

  if (!state.ledger.length) {
    card.insertAdjacentHTML('beforeend', '<div class="muted">还没有记录。每次一键填充或首次点选填充都会记一行。</div>');
  }
  for (const r of state.ledger) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTs(r.ts);
    const co = document.createElement('input');
    co.className = 'co';
    co.type = 'text';
    co.value = r.company || '';
    co.title = '公司名（可修改）';
    co.addEventListener('input', () => {
      r.company = co.value;
      scheduleSave();
    });
    const sys = document.createElement('span');
    sys.className = 'sys badge';
    sys.textContent = PLATFORM_NAMES[r.system] || r.system || '-';
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = `自动${r.autoCount || 0}·点选${r.manualCount || 0}`;
    cnt.title = r.url || '';
    row.appendChild(t);
    row.appendChild(co);
    row.appendChild(sys);
    row.appendChild(cnt);
    card.appendChild(row);
  }
  root.appendChild(card);
}

async function exportCsv() {
  const res = await sendMessage('wsa:exportCsv', { rows: state.ledger });
  if (res.ok) toastMsg(`已导出 ${res.filename}`, 'ok');
  else toastMsg('导出失败：' + res.error, 'err');
}

// ============ 附件 ============

function renderMaterialsTab() {
  const root = main.materials;
  root.innerHTML = '';
  const prof = getActiveProfile(state);

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<div class="subhead">📎 材料清单</div><div class="muted" style="margin-bottom:6px">只登记名字和备注（不存文件本体）。检测到上传控件时会在这里提醒你该传什么。</div>';
  (prof.materials || []).forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'mrow';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = m.name;
    name.placeholder = '材料名，如：简历-嵌入式固件版.pdf';
    name.addEventListener('input', () => {
      m.name = name.value;
      scheduleSave();
    });
    const note = document.createElement('input');
    note.className = 'note';
    note.type = 'text';
    note.value = m.note || '';
    note.placeholder = '备注';
    note.style.flex = '0 0 110px';
    note.addEventListener('input', () => {
      m.note = note.value;
      scheduleSave();
    });
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      prof.materials.splice(i, 1);
      scheduleSave();
      renderMaterialsTab();
    });
    row.appendChild(name);
    row.appendChild(note);
    row.appendChild(del);
    card.appendChild(row);
  });
  const add = document.createElement('button');
  add.className = 'btn plain';
  add.textContent = '＋添加材料';
  add.addEventListener('click', () => {
    prof.materials = prof.materials || [];
    prof.materials.push({ name: '', note: '' });
    scheduleSave();
    renderMaterialsTab();
  });
  card.appendChild(add);
  root.appendChild(card);
}

// ============ 档案操作 ============

function updateMenuReveal() {
  const item = document.querySelector('#moreMenu [data-act="reveal"]');
  if (item) item.textContent = (revealAll ? '✓ ' : '') + '👁 显示全部敏感字段';
}

function onNewProfile() {
  const name = prompt('新档案名称：', '新档案');
  if (!name) return;
  const prof = WangshenTemplates.makeProfile(name.trim(), 'all');
  state.profiles.push(prof);
  state.activeProfileId = prof.id;
  scheduleSave();
  renderAll();
  toastMsg(`已创建「${prof.name}」（全字段 ${prof.fields.length} 项）`, 'ok');
}

function onRenameProfile() {
  const prof = getActiveProfile(state);
  const name = prompt('重命名为：', prof.name);
  if (!name) return;
  prof.name = name.trim();
  scheduleSave();
  renderProfileBar();
}

function onDeleteProfile() {
  if (state.profiles.length <= 1) return toastMsg('至少保留一个档案', 'err');
  const prof = getActiveProfile(state);
  if (!confirm(`删除档案「${prof.name}」及其全部字段数据？此操作不可恢复。`)) return;
  state.profiles = state.profiles.filter((p) => p.id !== prof.id);
  state.activeProfileId = state.profiles[0].id;
  scheduleSave();
  renderAll();
}

// ============ 供自动化验收使用的调试钩子（不影响正常使用） ============

window.WSA = {
  ready: true,
  getState: () => state,
  detection: () => detection,
  detectionError: () => detectionError,
  async refresh() {
    await refreshDetection();
    // 检测为空时重试一次（SPA 晚渲染兜底）
    if (detection && detection.counts.auto + detection.counts.manual + detection.counts.open === 0) {
      const res = await sendToTab(detectionTabId, 'wsa:redetect');
      if (res.ok) {
        detection = res.state;
      }
    }
    renderFillTab();
    return detection;
  },
  async autoFill() {
    await onAutoFill();
    return review;
  },
  async fillOne(id, value) {
    const f = detection.fields.find((x) => x.id === id);
    const prof = getActiveProfile(state);
    const pf = findProfileFieldByKey(prof, f && f.key);
    const res = await sendToTab(detectionTabId, 'wsa:fillOne', {
      item: { id, label: pf ? pf.label : (f ? f.label : id), value, inputType: f ? f.inputType : 'text', options: f ? f.options : undefined, masked: pf ? pf.sensitive : false },
    });
    // 与真实 UI 路径（handleFillResponse）一致的台账与复查逻辑
    const r = res && res.results && res.results[0];
    if (r && r.ok) {
      review = review.filter((x) => x.id !== r.id);
      review.push({ ...r, label: pf ? pf.label : id, value: r.actualValue != null ? r.actualValue : value, pfSensitive: pf ? pf.sensitive : false });
      if (res.manualFirst) addLedger({ autoCount: 0, manualCount: 1 });
      else bumpManualLedger();
      renderFillTab();
    }
    return res;
  },
  setFieldByKey(key, value) {
    const prof = getActiveProfile(state);
    const pf = findProfileFieldByKey(prof, key);
    if (!pf) throw new Error('no field ' + key);
    pf.value = value;
    scheduleSave();
    return true;
  },
  async save() {
    scheduleSave();
    await new Promise((r) => setTimeout(r, 500));
    return true;
  },
  createProfile: onNewProfileWrapper,
  switchProfile(id) {
    state.activeProfileId = id;
    scheduleSave();
    renderAll();
    return true;
  },
  review: () => review,
};

function onNewProfileWrapper(name) {
  const prof = WangshenTemplates.makeProfile(name, 'all');
  state.profiles.push(prof);
  state.activeProfileId = prof.id;
  scheduleSave();
  renderAll();
  return prof.id;
}

init();
