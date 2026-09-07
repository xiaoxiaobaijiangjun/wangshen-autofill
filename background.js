// Service Worker：AI 请求代理（只允许智谱一家）、CSV 导出、初始数据、侧边栏开关。
'use strict';

importScripts('data/templates.js'); // 模板与档案工厂依赖 WangshenTemplates

const ROOT_KEY = 'wangshenAutofill';
const DEFAULT_TIMEOUT_MS = 30000;

// ============ Provider 抽象（只实现智谱，不做多厂商切换 UI） ============
const PROVIDERS = {
  zhipu: {
    name: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    buildHeaders(key) {
      return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
    },
    buildBody(req) {
      return {
        model: req.model,
        messages: req.messages,
        temperature: req.temperature != null ? req.temperature : 0.6,
        max_tokens: req.maxTokens,
        stream: false,
      };
    },
  },
};

// ============ 初始数据（工厂在 data/templates.js） ============

function defaultState() {
  return WangshenTemplates.defaultState();
}

async function getState() {
  const obj = await chrome.storage.local.get(ROOT_KEY);
  let state = obj[ROOT_KEY];
  if (!state) {
    state = defaultState();
    await chrome.storage.local.set({ [ROOT_KEY]: state });
    return state;
  }
  if (!state.migratedFullFields) {
    // 老数据升级：合并长短表单为全字段（幂等，与 common.js 同一策略）
    (state.profiles || []).forEach((p) => WangshenTemplates.upgradeProfile(p));
    state.migratedFullFields = true;
    await chrome.storage.local.set({ [ROOT_KEY]: state });
  }
  return state;
}

// ============ AI 调用 ============

function aiError(message, detail) {
  const e = new Error(message);
  e.detail = detail;
  return e;
}

async function callGLM(req) {
  const state = await getState();
  const settings = state.settings || {};
  const provider = PROVIDERS[settings.provider] || PROVIDERS.zhipu;
  if (!settings.apiKey) {
    throw aiError('尚未配置智谱 API Key，请打开设置页填写（模型默认 glm-5.3-flash）。');
  }
  const model = req.model || settings.model || 'glm-5.3-flash';
  const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: provider.buildHeaders(settings.apiKey),
      body: JSON.stringify(provider.buildBody({ ...req, model })),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw aiError(`AI 请求超时（${Math.round(timeoutMs / 1000)} 秒），请重试或检查网络。`);
    }
    throw aiError('网络请求失败：' + (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* 保留 data=null，走下面的状态码分支 */
  }
  if (!res.ok) {
    const apiMsg = data && data.error && data.error.message ? data.error.message : '';
    if (res.status === 401) throw aiError('API Key 无效（401），请到设置页检查是否复制完整。', apiMsg);
    if (res.status === 429) throw aiError('调用频率/额度受限（429），请稍后再试或检查智谱账户余额。', apiMsg);
    throw aiError(`智谱接口返回 ${res.status}：${apiMsg || res.statusText}`, apiMsg);
  }
  if (data && data.error) {
    throw aiError('智谱接口报错：' + (data.error.message || JSON.stringify(data.error)));
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') {
    throw aiError('AI 返回格式异常，未找到回复内容。原始返回：' + JSON.stringify(data).slice(0, 300));
  }
  return { content, usage: data.usage || null, model };
}

// 从模型回复里稳健地抠出 JSON（容忍 ```json 围栏与前后杂文字）
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

// ============ CSV 导出（UTF-8 BOM，Excel 打开不乱码） ============

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function buildCsv(rows) {
  const header = ['时间', '公司', '系统', '链接', '自动填', '点选填'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows || []) {
    lines.push(
      [
        formatTs(r.ts),
        r.company || '',
        r.system || '',
        r.url || '',
        r.autoCount != null ? r.autoCount : 0,
        r.manualCount != null ? r.manualCount : 0,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return '\uFEFF' + lines.join('\r\n');
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatTs(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ============ 消息路由 ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'wsa:ping':
          sendResponse({ ok: true, pong: true });
          return;
        case 'wsa:openPanel': {
          const tabId = sender.tab && sender.tab.id;
          try {
            if (tabId != null) {
              await chrome.sidePanel.open({ tabId });
            } else {
              const win = await chrome.windows.getLastFocused();
              await chrome.sidePanel.open({ windowId: win.id });
            }
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: '无法自动打开侧边栏，请点击浏览器工具栏上的插件图标。' });
          }
          return;
        }
        case 'wsa:getState': {
          sendResponse({ ok: true, state: await getState() });
          return;
        }
        case 'wsa:aiChat': {
          const out = await callGLM(msg.payload || {});
          sendResponse({ ok: true, ...out });
          return;
        }
        case 'wsa:aiExtractResume': {
          // PDF 提取：文本模式传 messages；视觉模式传 pages[{dataUrl, hint}]
          const payload = msg.payload || {};
          let content;
          if (Array.isArray(payload.pages) && payload.pages.length) {
            content = await visionExtract(payload.pages);
          } else {
            const out = await callGLM({ messages: payload.messages, temperature: 0.2, timeoutMs: 120000, maxTokens: 4096 });
            content = out.content;
          }
          const parsed = extractJson(content);
          if (!parsed) {
            throw aiError('AI 返回的内容无法解析为 JSON，请重试一次。原文开头：' + String(content).slice(0, 120));
          }
          sendResponse({ ok: true, data: parsed, raw: content });
          return;
        }
        case 'wsa:exportCsv': {
          const csv = buildCsv(msg.rows || []);
          const d = new Date();
          const name = `网申台账-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.csv`;
          const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
          chrome.downloads.download({ url, filename: name, saveAs: false }, (dlId) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ ok: true, id: dlId, filename: name });
            }
          });
          return true; // 异步 sendResponse
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型: ' + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e), detail: e.detail });
    }
  })();
  return true; // 所有分支都异步回复
});

// 视觉模式：每页一条消息（含 PNG base64），顺序调用后合并
async function visionExtract(pages) {
  const merged = {};
  const schemaPrompt =
    '你是简历信息抽取助手。请从这一页简历图片中提取信息，只输出一个 JSON 对象，不要输出任何其他文字。' +
    'JSON 字段：name(姓名), phone(手机号), email(邮箱), school(毕业院校), major(专业), degree(学历), graduation(毕业时间), ' +
    'gpa(绩点或排名), languages(数组,语言/证书), skills(数组,技能), ' +
    'experiences(数组,每项{company,role,start,end,bullets:[字符串数组]}), ' +
    'projects(数组,每项{name,role,start,end,bullets:[字符串数组]}), ' +
    'customs(对象,其他所有能识别到的字段,如政治面貌/籍贯/四六级/获奖等,键用中文标签)。' +
    '本页没有的字段省略或留空，不要编造。';
  for (const page of pages) {
    const out = await callGLM({
      messages: [
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: page.dataUrl } },
          { type: 'text', text: schemaPrompt + (page.hint ? `\n（这是第 ${page.hint} 页）` : '') },
        ] },
      ],
      temperature: 0.2,
      timeoutMs: 120000,
      maxTokens: 4096,
    });
    const part = extractJson(out.content);
    if (part) mergeResumePart(merged, part);
  }
  return JSON.stringify(merged);
}

function mergeResumePart(dst, part) {
  for (const k of Object.keys(part)) {
    const v = part[k];
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (!Array.isArray(dst[k])) dst[k] = [];
      for (const item of v) {
        if (item && typeof item === 'object') dst[k].push(item);
        else if (!dst[k].includes(item)) dst[k].push(item);
      }
    } else if (typeof v === 'object') {
      dst[k] = { ...(dst[k] || {}), ...v };
    } else if (!dst[k]) {
      dst[k] = v;
    }
  }
}

// ============ 生命周期 ============

chrome.runtime.onInstalled.addListener(async () => {
  await getState(); // 首次安装写入默认数据
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    // 老版本不支持时退化：由 floatbar 的消息触发 open
  }
});

chrome.runtime.onStartup.addListener(() => {});
