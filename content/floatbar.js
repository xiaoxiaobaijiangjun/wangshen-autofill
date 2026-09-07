// 页面内浮条：「检测到网申表单 · 打开侧边栏」。Shadow DOM 隔离，避免被宿主页面样式污染。
(function () {
  'use strict';

  const ROOT_KEY = 'wangshenAutofill';
  let host = null;
  let autoFloatbar = true;
  let dismissed = false;

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = 'wsa-floatbar-host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          position: fixed; right: 18px; bottom: 78px; z-index: 2147483646;
          display: flex; align-items: center; gap: 8px;
          background: #1c2333; color: #e8ecf6; font: 13px/1.4 system-ui, "Microsoft YaHei", sans-serif;
          border-radius: 10px; padding: 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25);
          border: 1px solid rgba(255,255,255,.12);
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #35d07f; }
        .counts { color: #9fb0d0; }
        button {
          all: unset; cursor: pointer; background: #2f54eb; color: #fff;
          border-radius: 7px; padding: 5px 10px; font-size: 12px;
        }
        button:hover { background: #2450d8; }
        .x { cursor: pointer; color: #6d7c99; padding: 2px 4px; font-size: 14px; }
        .x:hover { color: #fff; }
      </style>
      <div class="bar" part="bar">
        <span class="dot"></span>
        <span>检测到网申表单</span>
        <span class="counts"></span>
        <button type="button">打开侧边栏</button>
        <span class="x" title="本次浏览不再提示">✕</span>
      </div>
    `;
    const btn = shadow.querySelector('button');
    const close = shadow.querySelector('.x');
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'wsa:openPanel' }, () => void chrome.runtime.lastError);
    });
    close.addEventListener('click', () => {
      dismissed = true;
      hide();
    });
  }

  function hide() {
    if (host) host.style.display = 'none';
  }

  function onDetection(detected) {
    if (!autoFloatbar || dismissed) {
      hide();
      return;
    }
    const fields = detected.fields || [];
    const c = detected.counts || {
      auto: fields.filter((f) => f.cls === 'auto').length,
      manual: fields.filter((f) => f.cls === 'manual').length,
      open: fields.filter((f) => f.cls === 'open').length,
    };
    const total = c.auto + c.manual + c.open;
    if (!total) {
      hide();
      return;
    }
    ensureHost();
    host.style.display = '';
    const counts = host.shadowRoot.querySelector('.counts');
    counts.textContent = `可自动填 ${c.auto} · 点选 ${c.manual} · 开放题 ${c.open}`;
  }

  // 读设置
  try {
    chrome.storage.local.get(ROOT_KEY, (obj) => {
      const s = obj && obj[ROOT_KEY] && obj[ROOT_KEY].settings;
      if (s) autoFloatbar = s.autoFloatbar !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[ROOT_KEY]) {
        const s = changes[ROOT_KEY].newValue && changes[ROOT_KEY].newValue.settings;
        if (s) autoFloatbar = s.autoFloatbar !== false;
      }
    });
  } catch (e) {
    /* storage 不可用时保持默认 */
  }

  globalThis.WangshenFloatbar = { onDetection };
})();
