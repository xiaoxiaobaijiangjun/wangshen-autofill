// 侧边栏 / 设置页共用的工具（依赖先加载的 data/templates.js）
'use strict';

const ROOT_KEY = 'wangshenAutofill';

async function getState() {
  const obj = await chrome.storage.local.get(ROOT_KEY);
  if (!obj[ROOT_KEY]) {
    // 自愈：任何页面先于 onInstalled 读到空数据时，用共享工厂种子并写回
    const fresh = WangshenTemplates.defaultState();
    await chrome.storage.local.set({ [ROOT_KEY]: fresh });
    return fresh;
  }
  const state = obj[ROOT_KEY];
  if (!state.migratedFullFields) {
    // 老数据升级：合并长短表单为全字段，幂等
    (state.profiles || []).forEach((p) => WangshenTemplates.upgradeProfile(p));
    state.migratedFullFields = true;
    await chrome.storage.local.set({ [ROOT_KEY]: state });
  }
  return state;
}

async function saveState(state) {
  await chrome.storage.local.set({ [ROOT_KEY]: state });
}

// 整读整改整写：mutator 同步修改 state，返回后写回
async function mutateState(mutator) {
  const state = await getState();
  const out = mutator(state);
  await saveState(out === undefined ? state : out);
  return state;
}

function getActiveProfile(state) {
  return state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
}

function makeId(prefix) {
  return WangshenTemplates.makeId(prefix);
}

// 隐私遮挡：sensitive 且开启隐私模式 → ••••
function maskValue(value, sensitive, privacyMask, revealed) {
  if (!sensitive || !privacyMask || revealed) return value == null ? '' : String(value);
  return '••••';
}

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: '无响应' });
    });
  });
}

function sendToTab(tabId, type, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type, ...(payload || {}) }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: '无响应' });
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTs(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 按模板分组顺序输出 {group: fields[]}；自定义字段组排在最后
function groupProfileFields(profile) {
  const ordered = [];
  const map = new Map();
  for (const f of profile.fields) {
    if (!map.has(f.group)) {
      map.set(f.group, []);
      ordered.push(f.group);
    }
    map.get(f.group).push(f);
  }
  return { groups: ordered, map };
}

const PLATFORM_NAMES = { moka: 'Moka', iguopin: '国聘', generic: '通用' };

function toastMsg(text, kind) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show ' + (kind || 'info');
  clearTimeout(toastMsg._t);
  toastMsg._t = setTimeout(() => {
    el.className = 'toast';
  }, 2600);
}
