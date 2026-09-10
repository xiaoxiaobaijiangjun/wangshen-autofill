// 填充执行：React/Vue 兼容赋值、select/radio/checkbox/contenteditable、高亮标记。
// 安全红线（决策 #11）：本文件永远不查询、不点击任何按钮，尤其不允许出现对
// type=submit 或文案含"提交/发送/投递/confirm"的按钮的任何 click 调用。最后一步永远留给人。
(function () {
  'use strict';

  function dispatch(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 框架兼容赋值：绕过 React 受控组件的 value tracker，再派发 input/change。
  // 同时补 focus/blur：不少真实站点只在 blur 时做格式校验或写入组件 state，
  // 缺了它会出现"看起来填了、提交时报格式错误"。
  function setValue(el, value) {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    dispatch(el, 'focus');
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    dispatch(el, 'input');
    dispatch(el, 'change');
    dispatch(el, 'blur');
  }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s\u3000：:：]+/g, '');
  }

  // 更彻底的归一化：去掉所有符号，只留字母数字汉字（用于同义别名比对）
  function norm2(s) {
    return norm(s).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  }

  // 同义别名组：下拉框/单选选项写法不同但含义相同（CET-4 ↔ 四级）
  const EQUIV = [
    ['cet4', '四级', '英语四级'],
    ['cet6', '六级', '英语六级'],
    ['雅思', 'ielts'],
    ['托福', 'toefl'],
    ['中共党员', '党员', '正式党员'],
    ['中共预备党员', '预备党员'],
    ['共青团员', '团员'],
    ['硕士研究生', '硕士', '研究生'],
    ['大学本科', '本科', '学士'],
    ['大专', '专科'],
  ];

  // want 与 opt 是否属于同一同义组（各自命中同组任一词即算）
  function aliasHit(want, opt) {
    const w = norm2(want), o = norm2(opt);
    if (!w || !o) return false;
    for (const group of EQUIV) {
      const terms = group.map(norm2);
      if (terms.some((t) => w.includes(t)) && terms.some((t) => o.includes(t))) return true;
    }
    return false;
  }

  function fillText(el, value) {
    const before = el.value;
    setValue(el, value);
    if (el.value !== String(value)) {
      // 兜底：个别框架吞事件后直接赋值再补事件
      el.value = value;
      dispatch(el, 'input');
      dispatch(el, 'change');
    }
    return { ok: el.value === String(value) || before === String(value), actualValue: value };
  }

  function fillContentEditable(el, value) {
    el.focus();
    // 优先 beforeinput 兼容路径，execCommand 虽标记废弃但仍是兼容面最广的方案
    let ok = false;
    try {
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      sel.deleteFromDocument();
      ok = document.execCommand('insertText', false, value);
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      el.textContent = value;
    }
    dispatch(el, 'input');
    dispatch(el, 'change');
    dispatch(el, 'blur');
    return { ok: true, actualValue: el.textContent };
  }

  function fillSelect(el, value, options) {
    const want = norm(value);
    if (!want) return { ok: false, reason: '档案中该字段为空' };
    // 1) value 精确
    for (const o of el.options) {
      if (norm(o.value) === want) {
        return selectOption(el, o);
      }
    }
    // 2) 文本精确
    for (const o of el.options) {
      if (norm(o.textContent) === want) {
        return selectOption(el, o);
      }
    }
    // 3) 同义别名（"英语 CET-4" ↔ 选项"大学英语四级"）
    for (const o of el.options) {
      if (aliasHit(value, o.textContent) || aliasHit(value, o.value)) {
        return selectOption(el, o);
      }
    }
    // 4) 模糊：选项文本包含目标或目标包含选项
    for (const o of el.options) {
      const t = norm(o.textContent);
      if (t && (t.includes(want) || want.includes(t))) {
        return selectOption(el, o);
      }
    }
    // 4) 借助 detector 提供的 options（radio 组信息等）做提示
    if (options && options.length) {
      for (const o of options) {
        if (norm(o.value) === want || norm(o.text).includes(want) || want.includes(norm(o.text))) {
          const target = Array.from(el.options).find((x) => norm(x.value) === norm(o.value) || norm(x.textContent) === norm(o.text));
          if (target) return selectOption(el, target);
        }
      }
    }
    return { ok: false, reason: `下拉框没有匹配项（想填“${value}”）` };
  }

  function selectOption(el, option) {
    el.value = option.value;
    dispatch(el, 'focus');
    dispatch(el, 'input');
    dispatch(el, 'change');
    dispatch(el, 'blur');
    return { ok: true, actualValue: option.textContent.trim() || option.value };
  }

  const POSITIVE = ['是', '有', '对', 'true', '1', 'yes', '已', '勾选', '愿意', '服从', '同意'];
  function isTruthyText(v) {
    const n = norm(v);
    return POSITIVE.map(norm).includes(n) || (n && n !== '否' && n !== '无' && n !== '0' && n !== 'false');
  }

  function fillRadioGroup(radios, value, options) {
    const want = norm(value);
    if (!want) return { ok: false, reason: '档案中该字段为空' };
    for (const r of radios) {
      const labelText = norm(r.parentElement ? r.parentElement.textContent : '');
      if (norm(r.value) === want || labelText.includes(want) || want.includes(norm(r.value)) || aliasHit(value, labelText) || aliasHit(value, r.value)) {
        r.click(); // 原生 click 会置位并派发 input/click/change
        return { ok: r.checked, actualValue: (r.parentElement ? r.parentElement.textContent : r.value).trim().slice(0, 20) || r.value };
      }
    }
    if (options) {
      for (const o of options) {
        if (norm(o.text).includes(want) || want.includes(norm(o.text))) {
          const target = radios.find((r) => norm(r.value) === norm(o.value));
          if (target) {
            target.click();
            return { ok: target.checked, actualValue: o.text };
          }
        }
      }
    }
    return { ok: false, reason: `单选组没有匹配项（想填“${value}”）` };
  }

  function fillCheckbox(checkboxes, value) {
    const target = checkboxes[0];
    const checked = isTruthyText(value);
    if (target.checked !== checked) {
      target.click(); // 原生 click 完成切换并派发 input/click/change
    }
    return { ok: target.checked === checked, actualValue: checked ? '勾选' : '取消勾选' };
  }

  // 自动补全组件适配（Moka 等）：民族/籍贯/学校/专业是"输入+下拉选择"组合，
  // 只打字不点选项时站点 state 不更新，提交时仍报必填未填。
  // 策略：填入文本后等下拉选项渲染，自动匹配并点击正确选项；无下拉则快速跳过。
  async function pickDropdownOption(el, value) {
    const want = norm(value);
    if (!want) return { picked: false };
    for (let i = 0; i < 5; i++) {
      await sleep(90);
      const opts = findOptions(el, want);
      if (opts.length) {
        const opt = opts[0];
        const text = (opt.textContent || '').trim();
        ['mousedown', 'mouseup', 'click'].forEach((type) => {
          opt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
        return { picked: true, text };
      }
    }
    return { picked: false };
  }

  function findOptions(el, want) {
    const scopes = [];
    const item = el.closest('[class*="form-item"], [class*="form-group"], [class*="field"], [class*="select"], li, td');
    if (item) scopes.push(item);
    scopes.push(document.body); // 不少组件把下拉面板挂在 body 末尾（portal）
    const seen = new Set();
    const out = [];
    for (const scope of scopes) {
      scope.querySelectorAll('li, [class*="option"], [class*="Option"], [class*="menu-item"], [class*="item"]').forEach((o) => {
        if (seen.has(o) || o.contains(el) || el.contains(o)) return;
        if (!isVisible(o)) return;
        const text = (o.textContent || '').trim();
        if (!text || text.length > 30) return;
        const n = norm(text);
        if (n === want || (n && (n.includes(want) || want.includes(n)))) {
          seen.add(o);
          out.push(o);
        }
      });
      if (out.length) return out; // 就近优先：字段附近找到就不再扫 body
    }
    return out;
  }

  async function fillElement(el, value, ctx) {
    ctx = ctx || {};
    if (!el) return { ok: false, reason: '元素不存在' };
    const kind = ctx.inputType || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : (el.getAttribute('type') || 'text').toLowerCase());
    if (value == null || value === '') return { ok: false, reason: '档案中该字段为空' };
    if (!ctx.radios && (kind === 'radio' || kind === 'checkbox')) {
      return { ok: false, reason: '找不到该组选项' };
    }
    if (kind === 'radio') return fillRadioGroup(ctx.radios, value, ctx.options);
    if (kind === 'checkbox') return fillCheckbox(ctx.radios, value);
    if (kind === 'select' || el.tagName === 'SELECT') return fillSelect(el, value, ctx.options);
    if (el.isContentEditable) return fillContentEditable(el, value);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const r = fillText(el, value);
      if (!r.ok) return r;
      const pick = await pickDropdownOption(el, value);
      if (pick.picked) return { ok: true, actualValue: pick.text };
      return r;
    }
    return { ok: false, reason: '不支持的控件类型' };
  }

  // ============ 高亮标记 ============

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.id = 'wsa-style';
    st.textContent = `
      .wsa-flash { transition: background-color 1.6s ease !important; }
      .wsa-filled-mark { outline: 2px solid rgba(47,84,235,.65) !important; outline-offset: -2px !important; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  function markFilled(el, actualValue) {
    injectStyle();
    el.classList.add('wsa-flash');
    el.style.backgroundColor = '#ffe58f';
    setTimeout(() => {
      el.style.backgroundColor = '';
      setTimeout(() => el.classList.remove('wsa-flash'), 1800);
    }, 300);
    el.classList.add('wsa-filled-mark');
    el.dataset.wsaFilled = '1';
  }

  globalThis.WangshenFiller = { fillElement, markFilled, setValue };
})();
