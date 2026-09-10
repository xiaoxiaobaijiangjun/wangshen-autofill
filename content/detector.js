// 平台识别 + 字段发现 + 与侧边栏的消息中枢。
// 依赖 data/templates.js（先加载），填充执行在 content/filler.js（WangshenFiller）。
(function () {
  'use strict';

  const T = globalThis.WangshenTemplates;
  const ROOT_KEY = 'wangshenAutofill';

  const state = {
    platform: 'generic',
    generation: 0, // 每次重新检测自增
    fields: [], // {id,label,key,score,cls,inputType,radioEls?,options?,value?}
    fileInputs: [], // {id,label}
    hasCaptcha: false,
    pageKind: 'form', // form | login（登录/验证页已抑制填充）
    registry: new Map(), // id -> element（跨代持久；元素仍在文档里就还能填）
  };

  let settings = { autoThreshold: 0.85, autoFloatbar: true };
  let filling = false; // 填充批次进行中：暂停自动重检测，避免自己的填充把自己的引用作废

  // ============ 平台识别 ============

  function detectPlatform() {
    const h = location.hostname.toLowerCase();
    if (/(^|\.)mokahr\.com$/.test(h)) return 'moka';
    if (/(^|\.)iguopin\.com$/.test(h)) return 'iguopin';
    return 'generic';
  }

  // ============ 可见性 ============

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function inOurUi(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n.id && String(n.id).indexOf('wsa-') === 0) return true;
      n = n.parentElement;
    }
    return false;
  }

  // ============ label 查找 ============

  const OPEN_QUESTION_RE = /为什么|谈谈|描述|介绍|规划|看法|建议|体会|理解|认识|原因|优势|劣势|职业|收获|困难|挑战|印象|评价|自荐|期望|目标|爱好|趣事|评价一下|怎么样|如何看/;

  function labelForId(el) {
    if (!el.id) return '';
    const lb = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return lb ? lb.textContent : '';
  }

  function labelTextOf(container, excludeEl) {
    if (!container) return '';
    // 容器内第一个非"包裹 excludeEl"的 label/类 label 元素（排除单选/多选自己的选项文本）
    const cands = container.querySelectorAll('label, [class*="label" i], [class*="title" i], th, dt');
    for (const c of cands) {
      if (excludeEl && c.contains(excludeEl)) continue;
      const t = (c.textContent || '').trim();
      if (t) return t;
    }
    return '';
  }

  function findLabelText(el) {
    const parts = [];
    const push = (s) => {
      const t = (s || '').trim();
      if (t) parts.push(t);
    };
    push(labelForId(el));
    push(el.getAttribute('aria-label'));
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const lb = document.getElementById(labelledby);
      if (lb) push(lb.textContent);
    }
    // 平台增强：国聘(element-ui) 的 el-form-item / Moka 的 form-item
    const formItem =
      el.closest('.el-form-item') ||
      el.closest('[class*="form-item" i]') ||
      el.closest('[class*="field-item" i]') ||
      el.closest('[class*="form-group" i]');
    if (formItem) push(labelTextOf(formItem, el));
    // 同行表格头 / 前一单元格
    const cell = el.closest('td,th');
    if (cell) {
      const row = cell.parentElement;
      const idx = Array.prototype.indexOf.call(row.children, cell);
      const headRow = row.parentElement.querySelector('tr');
      if (headRow && headRow !== row && headRow.children[idx]) push(headRow.children[idx].textContent);
      let prev = cell.previousElementSibling;
      for (let i = 0; i < 2 && prev; i++) {
        push(prev.textContent);
        prev = prev.previousElementSibling;
      }
    }
    push(el.getAttribute('placeholder'));
    // 单选/多选自己的包裹 label（"男/女"这类选项文本）放最后，避免当成字段名
    const wrapLabel = el.closest('label');
    if (wrapLabel) push(wrapLabel.textContent.replace(el.value || '', ''));
    // 向上找最近容器内的短文本 label（最多 4 层）
    let p = el.parentElement;
    for (let i = 0; i < 4 && p && p !== document.body; i++) {
      const t = labelTextOf(p, el);
      if (t && t.length <= 30) {
        push(t);
        break;
      }
      p = p.parentElement;
    }
    push(el.getAttribute('name'));
    for (const t of parts) {
      if (t && t.length <= 40) return t;
    }
    return parts[0] || '';
  }

  // ============ 字段发现 ============

  function collectFormControls() {
    const all = document.querySelectorAll('input, textarea, select');
    const out = [];
    for (const el of all) {
      if (inOurUi(el)) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName === 'INPUT') {
        if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      }
      if (el.disabled) continue;
      if (!isVisible(el)) continue;
      out.push(el);
    }
    return out;
  }

  function findFileInputs() {
    const out = [];
    for (const el of document.querySelectorAll('input[type="file"]')) {
      if (inOurUi(el) || !isVisible(el)) continue;
      out.push({ id: null, label: findLabelText(el) || '附件上传' });
    }
    // 上传类文案兜底（有的站点是点击区域触发）
    if (!out.length) {
      const uploadText = document.body.innerText.match(/上传(简历|附件|成绩单|作品|材料)/);
      if (uploadText) out.push({ id: null, label: '检测到「' + uploadText[0] + '」入口' });
    }
    return out;
  }

  function assignId(el) {
    // ID 与元素绑定、终身稳定：填充动作触发的重检测不会让已填引用失效
    if (!el.dataset.wsaId) {
      el.dataset.wsaId = 'e' + Math.random().toString(36).slice(2, 10);
    }
    return el.dataset.wsaId;
  }

  // radio/checkbox 按	name 分组合并成一条逻辑字段
  function groupRadios(controls) {
    const groups = new Map();
    const singles = [];
    for (const el of controls) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if ((type === 'radio' || type === 'checkbox') && el.name) {
        const gk = type + '::' + el.name;
        if (!groups.has(gk)) {
          groups.set(gk, { type, els: [] });
          singles.push({ group: groups.get(gk) });
        }
        groups.get(gk).els.push(el);
      } else {
        singles.push({ el });
      }
    }
    return singles;
  }

  function detect() {
    state.platform = detectPlatform();
    state.generation += 1;
    state.hasCaptcha = false;

    const controls = collectFormControls();
    const entries = [];

    for (const item of groupRadios(controls)) {
      const el = item.el || item.group.els[0];
      const isRadioGroup = !!item.group;
      const label = findLabelText(el);
      const norm = T.normalizeLabel(label);

      if (/验证码|captcha|滑动滑块|拖动滑块|图形验证/.test(norm)) {
        state.hasCaptcha = true;
        continue; // 验证码一律跳过
      }

      const match = T.matchLabel(label);
      const inputType = isRadioGroup
        ? item.group.type
        : el.tagName === 'SELECT'
          ? 'select'
          : el.tagName === 'TEXTAREA'
            ? 'textarea'
            : (el.getAttribute('type') || 'text').toLowerCase();
      const isContentEditable = !isRadioGroup && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA' && el.isContentEditable;

      // 手机号国际区号下拉框（选项全是 "+86"/"中国大陆 (+86)" 之类）→ 不是填号码的地方，跳过
      if (inputType === 'select') {
        const texts = Array.from(el.options).map((o) => (o.textContent || '').trim());
        const codeLike = texts.filter((t) => /^\+\d{1,5}$/.test(t) || /\(\s*\+\d{1,5}\s*\)/.test(t));
        // 区号下拉：哪怕只有 1 个选项（如北森的单独 +86 框）也跳过
        if (texts.length >= 1 && codeLike.length / texts.length >= 0.6) continue;
        if (/区号|国际区号|国家地区|国家\/地区/.test(norm)) continue;
      }

      // 家庭成员/紧急联系人上下文：即使列头写着"姓名"，也绝不自动填（防止把申请人姓名填进家人栏）
      let ctxLabel = '';
      try {
        const legend = el.closest('fieldset') && el.closest('fieldset').querySelector('legend');
        const tableWrap = el.closest('table') && el.closest('table').closest('fieldset');
        const legendText = (tableWrap && tableWrap.querySelector('legend') ? tableWrap.querySelector('legend').textContent : legend ? legend.textContent : '') || '';
        if (/家庭|成员|家长|紧急/.test(legendText)) ctxLabel = legendText.trim().slice(0, 14) + '·';
      } catch (e) { /* 无 fieldset 上下文 */ }

      let cls = null; // auto | manual | open | skip
      let weakOpen = false; // 孤儿 textarea：无任何词典/关键词信号，靠页面上下文决定去留
      let key = match ? match.key : null;

      if (ctxLabel) {
        cls = 'manual'; // 家庭/紧急联系字段一律走点选，敏感且歧义大
      } else {
        const textProbe = (label || '') + ' ' + (el.getAttribute('placeholder') || '');
        const looksOpen = inputType === 'textarea' && OPEN_QUESTION_RE.test(textProbe);
        const exactDict = match && match.score >= 1.0; // 字典精确命中（如"自我评价"）不算开放题
        if (looksOpen && !exactDict) {
          cls = 'open';
        } else if (match && match.score >= settings.autoThreshold) {
          const def = T.FIELD_INDEX[match.key];
          cls = def && def.autoFill === false ? 'manual' : 'auto';
        } else if (match && match.score >= 0.5) {
          cls = 'manual';
        } else if (isRadioGroup && item.group.type === 'checkbox') {
          cls = 'manual';
        } else if (inputType === 'textarea') {
          // 孤儿 textarea（聊天框/评论框）：先标记为"弱开放题"，
          // 只有页面同时存在其他网申字段信号时才保留，否则丢弃（否则 DeepSeek 首页都会误报）
          cls = 'open';
          weakOpen = true;
        } else {
          continue; // 匹配不上的单行输入不展示，避免噪音
        }
      }

      const entry = {
        id: assignId(el),
        label: (ctxLabel + label || key || '').slice(0, 40),
        key: ctxLabel ? null : key, // 家庭/紧急字段不预映射档案字段，避免误填
        score: match ? Math.round(match.score * 100) / 100 : 0,
        cls,
        inputType: isContentEditable ? 'contenteditable' : inputType,
      };
      if (isRadioGroup) {
        entry.radioEls = item.group.els.map((r) => r);
        entry.options = item.group.els.map((r) => {
          const optLabel = (r.closest('label') && r.closest('label').textContent) || (r.parentElement && r.parentElement.textContent) || r.value || '';
          return { value: r.value, text: optLabel.trim().slice(0, 20) || r.value };
        });
        entry.radioGroupName = item.group.els[0].name;
      }
      if (inputType === 'select') {
        entry.options = Array.from(el.options).map((o) => ({ value: o.value, text: o.textContent.trim() }));
      }
      entries.push(entry);
      entry.weakOpen = weakOpen;
      state.registry.set(entry.id, isRadioGroup ? item.group.els[0] : el);
      if (isRadioGroup) {
        state.registry.set('__radios__' + entry.id, item.group.els);
      }
    }

    // 弱开放题过滤：页面没有其他网申字段信号（可自动填/点选）时，孤儿 textarea 视为
    // 聊天框/评论框而非开放题，避免在无关网站误报"检测到网申表单"
    const jobSignal = entries.filter((e) => e.cls === 'auto' || e.cls === 'manual').length;
    let kept = jobSignal >= 1 ? entries : entries.filter((e) => !e.weakOpen);

    // 登录/验证页判定：有验证码控件、且几乎没有其他网申字段（≤2 个自动填、无点选/开放题）
    // => 这是登录/绑定手机号页而非申请表，停止一切填充（避免在陌生登录页自动填手机号）
    state.pageKind = 'form';
    if (state.hasCaptcha) {
      const a = kept.filter((e) => e.cls === 'auto').length;
      const m = kept.filter((e) => e.cls === 'manual').length;
      const o = kept.filter((e) => e.cls === 'open').length;
      if (a <= 2 && m === 0 && o === 0) {
        kept = [];
        state.pageKind = 'login';
      }
    }

    // 排序按 DOM 顺序（collect 顺序即文档顺序）
    state.fields = kept;
    state.fileInputs = findFileInputs();
    if (globalThis.WangshenFloatbar) globalThis.WangshenFloatbar.onDetection(state);
    return state;
  }

  // ============ 供 filler / 消息层使用 ============

  function getEl(id) {
    const el = state.registry.get(String(id));
    return el && el.isConnected ? el : null;
  }

  function getRadioEls(id) {
    const els = state.registry.get('__radios__' + id);
    return els && els[0] && els[0].isConnected ? els : null;
  }

  function publicState() {
    return {
      platform: state.platform,
      url: location.href,
      title: document.title,
      generation: state.generation,
      hasCaptcha: state.hasCaptcha,
      pageKind: state.pageKind || 'form',
      fields: state.fields.map((f) => ({
        id: f.id,
        label: f.label,
        key: f.key,
        score: f.score,
        cls: f.cls,
        inputType: f.inputType,
        options: f.options,
      })),
      fileInputs: state.fileInputs,
      counts: {
        auto: state.fields.filter((f) => f.cls === 'auto').length,
        manual: state.fields.filter((f) => f.cls === 'manual').length,
        open: state.fields.filter((f) => f.cls === 'open').length,
      },
    };
  }

  // ============ 消息处理（侧边栏 ⇄ 页面） ============

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case 'wsa:getState': {
            sendResponse({ ok: true, state: publicState() });
            return;
          }
          case 'wsa:redetect': {
            detect();
            sendResponse({ ok: true, state: publicState() });
            return;
          }
          case 'wsa:autofill':
          case 'wsa:fillOne': {
            filling = true; // 批次期间不自动重检测，防止引用失效
            const items = msg.type === 'wsa:autofill' ? msg.items : [msg.item];
            const results = [];
            for (const it of items || []) {
              const el = getEl(it.id);
              if (!el) {
                results.push({ id: it.id, label: it.label, ok: false, reason: '该输入框已不在页面上' });
                continue;
              }
              const radios = getRadioEls(it.id);
              const r = globalThis.WangshenFiller.fillElement(el, it.value, {
                inputType: it.inputType,
                options: it.options,
                radios,
              });
              if (r.ok) {
                globalThis.WangshenFiller.markFilled(el, r.actualValue != null ? r.actualValue : it.value);
              }
              results.push({ id: it.id, label: it.label || (state.fields.find((f) => f.id === it.id) || {}).label, ok: r.ok, reason: r.reason, actualValue: r.ok ? r.actualValue : undefined, masked: !!it.masked });
            }
            const anyOk = results.some((r) => r.ok);
            sendResponse({ ok: true, results, manualFirst: msg.type === 'wsa:fillOne' && anyOk && !manualFillRecorded });
            if (msg.type === 'wsa:fillOne' && anyOk) manualFillRecorded = true;
            setTimeout(() => { filling = false; }, 1500); // 批次结束后稍作缓冲再恢复自动检测
            return;
          }
          default:
            sendResponse({ ok: false, error: '未知消息: ' + (msg && msg.type) });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  });

  let manualFillRecorded = false; // 每个页面会话只记一次"首次点选"

  // ============ 启动与 SPA 监听 ============

  let detectTimer = null;
  function scheduleDetect(delay) {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      try {
        detect();
      } catch (e) {
        console.warn('[wangshen-autofill] detect error', e);
      }
    }, delay || 0);
  }

  async function loadSettings() {
    try {
      const obj = await chrome.storage.local.get(ROOT_KEY);
      const s = obj[ROOT_KEY] && obj[ROOT_KEY].settings;
      if (s) {
        settings.autoThreshold = typeof s.autoThreshold === 'number' ? s.autoThreshold : 0.85;
        settings.autoFloatbar = s.autoFloatbar !== false;
      }
    } catch (e) {
      /* 用默认值 */
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[ROOT_KEY] && !filling) scheduleDetect(300);
  });

  loadSettings().then(() => {
    scheduleDetect(300);
    scheduleDetect(1800); // SPA 晚渲染兜底
    const mo = new MutationObserver(() => {
      if (!filling) scheduleDetect(900);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });

  globalThis.WangshenDetector = { state, detect, publicState, getEl, getRadioEls, settings };
})();
