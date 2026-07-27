const REMOTE_URL = 'https://api.hwaxy.cn/api/redirect-rules';

let cachedRules = [];

chrome.runtime.onInstalled.addListener(() => {
  fetchRemoteRules();
}); 

// Fetch remote rules on startup
fetchRemoteRules();

// Auto refresh every 5 minutes
chrome.alarms.create('refreshRemote', { periodInMinutes: 5 });
// Cookie 同步频率更高（每 30 秒），保证 cookie 新鲜
chrome.alarms.create('syncCookies', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refreshRemote') fetchRemoteRules();
  if (alarm.name === 'syncCookies') syncCookiesForRedirects();
});

// Fetch rules from remote API
function fetchRemoteRules() {
  fetch(REMOTE_URL)
    .then((res) => res.json())
    .then((json) => {
      const remoteRules = parseRemoteRules(json);
      chrome.storage.local.set({ remoteRules });
      mergeAndApply();
    })
    .catch((err) => {
      console.error('Failed to fetch remote rules:', err);
      mergeAndApply();
    });
}

// Parse remote API response into rules
// Supports formats:
//   [{ from: "...", to: "..." }]
//   [{ source: "...", target: "..." }]
//   { rules: [...] }
function parseRemoteRules(json) {
  let list = [];
  if (Array.isArray(json)) {
    list = json;
  } else if (json && Array.isArray(json.rules)) {
    list = json.rules;
  } else if (json && Array.isArray(json.data)) {
    list = json.data;
  }

  return list
    .filter((item) => item.from || item.source)
    .map((item) => ({
      id: 'remote_' + (item.id || Math.random().toString(36).slice(2)),
      from: item.from || item.source,
      to: item.to || item.target,
      enabled: item.enabled !== false,
    }));
}

// Apply remote rules
function mergeAndApply() {
  chrome.storage.local.get(['remoteRules', 'customRules', 'variables'], (data) => {
    const remoteRules = filterRules(data.remoteRules);
    const customRules = filterRules(data.customRules);
    // 合并远程规则和自定义规则
    cachedRules = [...remoteRules, ...customRules];
    applyAllRules(data.variables || {});
  });
}

function filterRules(rules) {
  return (rules || []).filter((r) => r.enabled && r.from && r.to);
}

// Apply both declarativeNetRequest + inject content script
function applyAllRules(variables) {
  applyRedirectRules(variables);
  injectToActiveTabs();
  syncCookiesForRedirects();
}

// declarativeNetRequest: network level redirect
function applyRedirectRules(variables) {
  const addRules = cachedRules.map((r, i) => {
    // 将通配符转为正则，捕获参数部分（组2）
    const regexFilter = wildcardToRegexFilter(r.from);
    // 替换：to + 参数引用（\\2 引用第2个捕获组，即 ?params）
    const escapedTo = (r.to || '').replace(/\\/g, '\\\\');
    const substitution = escapedTo + '\\2';

    return {
      id: i + 1,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: substitution },
      },
      condition: {
        regexFilter: regexFilter,
        resourceTypes: [
          'main_frame', 'sub_frame', 'stylesheet', 'script',
          'image', 'font', 'xmlhttprequest', 'other',
        ],
      },
    };
  });

  // 本地 OCR HTTPS→HTTP 降级规则
  try {
    var myConfig = (variables || {}).MY_CONFIG;
    if (typeof myConfig === 'string') { try { myConfig = JSON.parse(myConfig); } catch(e) {} }
    var ocrUrl = (myConfig || {}).localOcr || '';
    if (ocrUrl && ocrUrl.startsWith('https://')) {
      var escaped = ocrUrl.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      var regexFilter = '^(' + escaped + ')((?:\\?.*)?)$';
      // 替换 https:// → http://，保留 query 参数
      var httpUrl = 'http://' + ocrUrl.slice(8);
      var escapedTo = httpUrl.replace(/\\/g, '\\\\');
      var substitution = escapedTo + '\\2';
      addRules.push({
        id: 9999,
        priority: 2,
        action: { type: 'redirect', redirect: { regexSubstitution: substitution } },
        condition: {
          regexFilter: regexFilter,
          resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'xmlhttprequest', 'other'],
        },
      });
    }
  } catch(e) {}

  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    const removeIds = existing.map((r) => r.id);
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: removeIds, addRules },
      () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
      }
    );
  });
}

// 通配符转 declarativeNetRequest regexFilter
// 捕获组1：路径部分，捕获组2：参数部分（含 ?，可选）
function wildcardToRegexFilter(pattern) {
  const escaped = (pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const starReplaced = escaped.replace(/\*/g, '.*?');
  return '^(' + starReplaced + ')((?:\\?.*)?)$';
}

// 通配符转匹配 to URL 的 regex（用于 modifyHeaders，不需要捕获组）
function wildcardToRegexMatch(pattern) {
  const escaped = (pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const starReplaced = escaped.replace(/\*/g, '.*');
  return '^' + starReplaced + '(\\?.*)?$';
}

// 从通配符 URL 提取域名
function getDomainFromPattern(pattern) {
  try {
    // 替换通配符为占位符以便 URL 解析
    const cleanUrl = (pattern || '').replace(/\*/g, 'placeholder');
    return new URL(cleanUrl).hostname;
  } catch (e) {
    return '';
  }
}

// 同步请求头：读取 from 域名的 cookie 和 JS 捕获的 Authorization，注入到 to URL 的请求头
function syncCookiesForRedirects() {
  chrome.storage.local.get(['remoteRules', 'customRules', 'capturedAuth'], (data) => {
    const allRules = [
      ...filterRules(data.remoteRules),
      ...filterRules(data.customRules),
    ];
    const auths = data.capturedAuth || {};

    const tasks = allRules.map((r) => {
      const domain = getDomainFromPattern(r.from);
      if (!domain) return Promise.resolve(null);
      return new Promise((resolve) => {
        chrome.cookies.getAll({ domain }, (cookies) => {
          resolve({ rule: r, cookies: cookies || [] });
        });
      });
    });

    Promise.all(tasks).then((results) => {
      const headerRules = [];
      let ruleId = 10000; // header 规则 id 从 10000 开始，避免和 redirect 规则冲突

      results.forEach((item) => {
        if (!item) return;
        const requestHeaders = [];

        // Cookie（通过 chrome.cookies API 读取）
        if (item.cookies.length) {
          const cookieStr = item.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookieStr });
        }

        // Authorization（JS 层捕获，存储在 capturedAuth）
        const fromDomain = getDomainFromPattern(item.rule.from);
        if (auths[fromDomain]) {
          requestHeaders.push({ header: 'Authorization', operation: 'set', value: auths[fromDomain] });
        }

        if (!requestHeaders.length) return;

        headerRules.push({
          id: ruleId++,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: requestHeaders,
          },
          condition: {
            regexFilter: wildcardToRegexMatch(item.rule.to),
            resourceTypes: [
              'main_frame', 'sub_frame', 'stylesheet', 'script',
              'image', 'font', 'xmlhttprequest', 'other',
            ],
          },
        });
      });

      // 只更新 header 规则（id >= 10000）
      chrome.declarativeNetRequest.getDynamicRules((existing) => {
        const headerRuleIds = existing.filter((r) => r.id >= 10000).map((r) => r.id);
        chrome.declarativeNetRequest.updateDynamicRules(
          { removeRuleIds: headerRuleIds, addRules: headerRules },
          () => {
            if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
          }
        );
      });
    });
  });
}

// Content script: intercept fetch/XHR + inject variables
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!cachedRules.length) return;
  // 注入 Authorization 中转脚本到 ISOLATED world（用于和 background 通信）
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    world: 'ISOLATED',
    injectImmediately: true,
    func: authRelayFn,
  }).catch(() => {});
  chrome.storage.local.get('variables', (data) => {
    const variables = data.variables || {};
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      world: 'MAIN',
      injectImmediately: true,
      func: interceptorFn,
      args: [
        cachedRules.map((r) => ({ from: r.from, to: r.to })),
        variables,
      ],
    }).catch(() => {});
  });
});

function injectToActiveTabs() {
  chrome.storage.local.get('variables', (data) => {
    const variables = data.variables || {};
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.url || !tab.url.startsWith('http')) continue;
        // 注入 Authorization 中转脚本
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: authRelayFn,
        }).catch(() => {});
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: updateRules,
          args: [
            cachedRules.map((r) => ({ from: r.from, to: r.to })),
            variables,
          ],
        }).catch(() => {});
      }
    });
  });
}

function updateRules(rules, variables) {
  window.__REDIRECT_RULES__ = rules;
  var parsed = {};
  for (var key in variables) {
    var raw = variables[key];
    try { parsed[key] = JSON.parse(raw); } catch (e) { parsed[key] = raw; }
  }
  window.__REDIRECT_VARS__ = parsed;
  for (var k in parsed) {
    try { window[k] = parsed[k]; } catch (e) {}
  }
}

function interceptorFn(rules, variables) {
  var parsed = {};
  for (var key in variables) {
    var raw = variables[key];
    try { parsed[key] = JSON.parse(raw); } catch (e) { parsed[key] = raw; }
  }
  window.__REDIRECT_VARS__ = parsed;
  for (var k in parsed) {
    try { window[k] = parsed[k]; } catch (e) {}
  }

  window.__REDIRECT_RULES__ = rules;

  function matchUrl(url, pattern) {
    try {
      url = new URL(url, location.href).href;
    } catch (e) {}
    var escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    // 检查是否是以 * 结尾的路径匹配（用于匹配带参数的 URL）
    var pathOnlyMatch = false;
    var finalPattern = escaped;
    if (pattern.endsWith('*') && !pattern.includes('?*')) {
      // 如果 pattern 以 * 结尾且不包含 ?*，则视为路径匹配，自动加上 (\\?.*)? 匹配参数（可选）
      finalPattern = escaped.replace(/\*$/, '(\\?.*)?');
      pathOnlyMatch = true;
    }

    var regex = new RegExp('^' + finalPattern.replace(/\*/g, '.*') + '$');
    return regex.test(url);
  }

  function findRedirect(url) {
    var list = window.__REDIRECT_RULES__ || [];
    for (var i = 0; i < list.length; i++) {
      if (matchUrl(url, list[i].from)) return list[i].to;
    }
    return null;
  }

  // 合并原 URL 的参数到重定向 URL
  function mergeParams(originalUrl, targetUrl) {
    try {
      var origUrlObj = new URL(originalUrl);
      var targetUrlObj = new URL(targetUrl);
      // 将原 URL 的所有参数添加到目标 URL
      origUrlObj.searchParams.forEach(function(value, key) {
        targetUrlObj.searchParams.set(key, value);
      });
      return targetUrlObj.href;
    } catch (e) {
      return targetUrl;
    }
  }

  // 捕获 Authorization 头，通过 postMessage 发送给 ISOLATED world 的中转脚本
  function captureAuth(url, headers) {
    try {
      var auth = null;
      if (!headers) return;
      if (typeof headers.get === 'function') {
        // Headers 对象
        auth = headers.get('Authorization') || headers.get('authorization');
      } else if (Array.isArray(headers)) {
        // 数组形式 [ [name, value], ... ]
        for (var i = 0; i < headers.length; i++) {
          if (String(headers[i][0]).toLowerCase() === 'authorization') {
            auth = headers[i][1];
            break;
          }
        }
      } else if (typeof headers === 'object') {
        // 对象形式 { name: value }
        for (var k in headers) {
          if (k.toLowerCase() === 'authorization') {
            auth = headers[k];
            break;
          }
        }
      }
      if (auth) {
        var domain = new URL(url, location.href).hostname;
        window.postMessage({ type: '__REDIRECT_AUTH__', domain: domain, auth: auth }, '*');
      }
    } catch (e) {}
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string'
      ? input
      : input instanceof Request
        ? input.url
        : String(input);
    var target = findRedirect(url);
    if (target) {
      // 捕获 Authorization（优先从 init.headers，其次从 Request.headers）
      var headerSrc = (init && init.headers) ? init.headers
        : (input instanceof Request ? input.headers : null);
      captureAuth(url, headerSrc);

      var finalUrl = mergeParams(url, target);
      if (input instanceof Request) {
        // 用原 Request 作为 init 来源，保留 method/headers/body/credentials 等所有属性
        // 只替换 URL，其他完全不变
        input = new Request(finalUrl, input);
      } else {
        input = finalUrl;
      }
    }
    return origFetch.call(this, input, init);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    // 记录原始 url，用于后续捕获 Authorization
    this.__redirectFromUrl = url;
    this.__redirectTarget = findRedirect(url);
    if (this.__redirectTarget) {
      arguments[1] = mergeParams(url, this.__redirectTarget);
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // 拦截 setRequestHeader，捕获 Authorization
    if (this.__redirectTarget && String(name).toLowerCase() === 'authorization') {
      captureAuth(this.__redirectFromUrl, [[name, value]]);
    }
    return origSetHeader.apply(this, arguments);
  };
}

// ISOLATED world 中转脚本：监听 MAIN world 的 postMessage，转发给 background
function authRelayFn() {
  window.addEventListener('message', function (event) {
    if (event.source === window && event.data && event.data.type === '__REDIRECT_AUTH__') {
      try {
        chrome.runtime.sendMessage({
          type: 'authCaptured',
          domain: event.data.domain,
          auth: event.data.auth
        });
      } catch (e) {}
    }
  });
}

// Listen for storage changes (rules changed)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.remoteRules || changes.customRules) {
    mergeAndApply();
  }
});

// Listen for messages from popup/content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === 'refreshRemote') fetchRemoteRules();
  if (msg === 'refreshRules') mergeAndApply();
  // JS 层捕获到 Authorization，存储并更新 modifyHeaders 规则
  if (msg && msg.type === 'authCaptured') {
    chrome.storage.local.get('capturedAuth', (data) => {
      const auths = data.capturedAuth || {};
      // 只在新值或值变化时更新，避免频繁同步
      if (auths[msg.domain] !== msg.auth) {
        auths[msg.domain] = msg.auth;
        chrome.storage.local.set({ capturedAuth: auths }, () => {
          syncCookiesForRedirects();
        });
      }
    });
  }
});

// ============================================================
// 火山平台（Huoshan）独立逻辑
// 与上方智谱逻辑完全平行、互不干扰。复用纯工具函数：
//   parseRemoteRules / filterRules / wildcardToRegexFilter /
//   wildcardToRegexMatch / getDomainFromPattern / authRelayFn
// 规则 ID 段：重定向 20000~29999，请求头 30000~39999
// ============================================================

const REMOTE_URL_HUOSHAN = 'https://api.hwaxy.cn/api/redirect-rules-huoshan';
let cachedHuoshanRules = [];

// 读取当前平台（默认 zhipu；支持 huoshan / bailian）
function getPlatform(cb) {
  chrome.storage.local.get('variables', (data) => {
    const p = (data.variables && data.variables.MY_CONFIG && data.variables.MY_CONFIG.Platform);
    if (p === 'huoshan') cb('huoshan');
    else if (p === 'bailian') cb('bailian');
    else cb('zhipu');
  });
}

// 拉取火山远程规则（仅火山模式下生效）
function fetchHuoshanRules() {
  getPlatform((platform) => {
    if (platform !== 'huoshan') return;
    fetch(REMOTE_URL_HUOSHAN)
      .then((res) => res.json())
      .then((json) => {
        const remoteRules = parseRemoteRules(json);
        chrome.storage.local.set({ huoshanRules: remoteRules });
        mergeAndApplyHuoshan();
      })
      .catch((err) => {
        console.error('Failed to fetch huoshan rules:', err);
        mergeAndApplyHuoshan();
      });
  });
}

// 合并火山远程规则与自定义规则并应用
function mergeAndApplyHuoshan() {
  getPlatform((platform) => {
    if (platform !== 'huoshan') return;
    chrome.storage.local.get(['huoshanRules', 'customHuoshanRules', 'huoshanVariables'], (data) => {
      const remoteRules = filterRules(data.huoshanRules);
      const customRules = filterRules(data.customHuoshanRules);
      cachedHuoshanRules = [...remoteRules, ...customRules];
      applyHuoshanRules();
      injectHuoshanToActiveTabs(data.huoshanVariables || {});
      syncHuoshanCookies();
    });
  });
}

// 火山网络层重定向（declarativeNetRequest，ID 20000+，无 OCR 块）
function applyHuoshanRules() {
  const addRules = cachedHuoshanRules.map((r, i) => {
    const regexFilter = wildcardToRegexFilter(r.from);
    const escapedTo = (r.to || '').replace(/\\/g, '\\\\');
    const substitution = escapedTo + '\\2';
    return {
      id: 20000 + i,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: substitution },
      },
      condition: {
        regexFilter: regexFilter,
        resourceTypes: [
          'main_frame', 'sub_frame', 'stylesheet', 'script',
          'image', 'font', 'xmlhttprequest', 'other',
        ],
      },
    };
  });

  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    // 只移除火山重定向规则（20000~29999），不触碰智谱
    const removeIds = existing
      .filter((r) => r.id >= 20000 && r.id < 30000)
      .map((r) => r.id);
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: removeIds, addRules },
      () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
      }
    );
  });
}

// 火山请求头同步（Cookie + Authorization，modifyHeaders ID 30000+）
function syncHuoshanCookies() {
  getPlatform((platform) => {
    if (platform !== 'huoshan') return;
    chrome.storage.local.get(['huoshanRules', 'customHuoshanRules', 'capturedAuth'], (data) => {
      const allRules = [
        ...filterRules(data.huoshanRules),
        ...filterRules(data.customHuoshanRules),
      ];
      const auths = data.capturedAuth || {};

      const tasks = allRules.map((r) => {
        const domain = getDomainFromPattern(r.from);
        if (!domain) return Promise.resolve(null);
        return new Promise((resolve) => {
          chrome.cookies.getAll({ domain }, (cookies) => {
            resolve({ rule: r, cookies: cookies || [] });
          });
        });
      });

      Promise.all(tasks).then((results) => {
        const headerRules = [];
        let ruleId = 30000; // 火山 header 规则从 30000 起，避免与智谱(10000+)冲突

        results.forEach((item) => {
          if (!item) return;
          const requestHeaders = [];

          if (item.cookies.length) {
            const cookieStr = item.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
            requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookieStr });
          }

          const fromDomain = getDomainFromPattern(item.rule.from);
          if (auths[fromDomain]) {
            requestHeaders.push({ header: 'Authorization', operation: 'set', value: auths[fromDomain] });
          }

          if (!requestHeaders.length) return;

          headerRules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: requestHeaders,
            },
            condition: {
              regexFilter: wildcardToRegexMatch(item.rule.to),
              resourceTypes: [
                'main_frame', 'sub_frame', 'stylesheet', 'script',
                'image', 'font', 'xmlhttprequest', 'other',
              ],
            },
          });
        });

        chrome.declarativeNetRequest.getDynamicRules((existing) => {
          // 只移除火山 header 规则（30000~39999）
          const headerRuleIds = existing
            .filter((r) => r.id >= 30000 && r.id < 40000)
            .map((r) => r.id);
          chrome.declarativeNetRequest.updateDynamicRules(
            { removeRuleIds: headerRuleIds, addRules: headerRules },
            () => {
              if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
            }
          );
        });
      });
    });
  });
}

// 火山 Content script 注入：更新已有标签页的规则（与 updateRules 镜像，写入 __HUOSHAN_RULES__）
function injectHuoshanToActiveTabs(variables) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.url || !tab.url.startsWith('http')) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: authRelayFn,
      }).catch(() => {});
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: updateHuoshanRules,
        args: [
          cachedHuoshanRules.map((r) => ({ from: r.from, to: r.to })),
          variables,
        ],
      }).catch(() => {});
    }
  });
}

function updateHuoshanRules(rules, variables) {
  window.__HUOSHAN_RULES__ = rules;
  var parsed = {};
  for (var key in variables) {
    var raw = variables[key];
    try { parsed[key] = JSON.parse(raw); } catch (e) { parsed[key] = raw; }
  }
  window.__REDIRECT_VARS__ = parsed;
  for (var k in parsed) {
    try { window[k] = parsed[k]; } catch (e) {}
  }
}

// 火山 JS 层拦截器（与 interceptorFn 镜像，使用 __HUOSHAN_RULES__）
function interceptorFnHuoshan(rules, variables) {
  var parsed = {};
  for (var key in variables) {
    var raw = variables[key];
    try { parsed[key] = JSON.parse(raw); } catch (e) { parsed[key] = raw; }
  }
  window.__REDIRECT_VARS__ = parsed;
  for (var k in parsed) {
    try { window[k] = parsed[k]; } catch (e) {}
  }

  window.__HUOSHAN_RULES__ = rules;

  function matchUrl(url, pattern) {
    try {
      url = new URL(url, location.href).href;
    } catch (e) {}
    var escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    var pathOnlyMatch = false;
    var finalPattern = escaped;
    if (pattern.endsWith('*') && !pattern.includes('?*')) {
      finalPattern = escaped.replace(/\*$/, '(\\?.*)?');
      pathOnlyMatch = true;
    }
    var regex = new RegExp('^' + finalPattern.replace(/\*/g, '.*') + '$');
    return regex.test(url);
  }

  function findRedirect(url) {
    var list = window.__HUOSHAN_RULES__ || [];
    for (var i = 0; i < list.length; i++) {
      if (matchUrl(url, list[i].from)) return list[i].to;
    }
    return null;
  }

  function mergeParams(originalUrl, targetUrl) {
    try {
      var origUrlObj = new URL(originalUrl);
      var targetUrlObj = new URL(targetUrl);
      origUrlObj.searchParams.forEach(function(value, key) {
        targetUrlObj.searchParams.set(key, value);
      });
      return targetUrlObj.href;
    } catch (e) {
      return targetUrl;
    }
  }

  function captureAuth(url, headers) {
    try {
      var auth = null;
      if (!headers) return;
      if (typeof headers.get === 'function') {
        auth = headers.get('Authorization') || headers.get('authorization');
      } else if (Array.isArray(headers)) {
        for (var i = 0; i < headers.length; i++) {
          if (String(headers[i][0]).toLowerCase() === 'authorization') {
            auth = headers[i][1];
            break;
          }
        }
      } else if (typeof headers === 'object') {
        for (var k in headers) {
          if (k.toLowerCase() === 'authorization') {
            auth = headers[k];
            break;
          }
        }
      }
      if (auth) {
        var domain = new URL(url, location.href).hostname;
        window.postMessage({ type: '__REDIRECT_AUTH__', domain: domain, auth: auth }, '*');
      }
    } catch (e) {}
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string'
      ? input
      : input instanceof Request
        ? input.url
        : String(input);
    var target = findRedirect(url);
    if (target) {
      var headerSrc = (init && init.headers) ? init.headers
        : (input instanceof Request ? input.headers : null);
      captureAuth(url, headerSrc);

      var finalUrl = mergeParams(url, target);
      if (input instanceof Request) {
        input = new Request(finalUrl, input);
      } else {
        input = finalUrl;
      }
    }
    return origFetch.call(this, input, init);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__huoshanFromUrl = url;
    this.__huoshanTarget = findRedirect(url);
    if (this.__huoshanTarget) {
      arguments[1] = mergeParams(url, this.__huoshanTarget);
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__huoshanTarget && String(name).toLowerCase() === 'authorization') {
      captureAuth(this.__huoshanFromUrl, [[name, value]]);
    }
    return origSetHeader.apply(this, arguments);
  };
}

// 切回智谱时清空火山 DNR 规则（20000~39999）
function clearHuoshanRules() {
  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    const removeIds = existing
      .filter((r) => r.id >= 20000 && r.id < 40000)
      .map((r) => r.id);
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: removeIds },
      () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
      }
    );
  });
  cachedHuoshanRules = [];
}

// 火山 webNavigation 注入（独立监听器，不编辑上方智谱 onCommitted）
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!cachedHuoshanRules.length) return;
  getPlatform((platform) => {
    if (platform !== 'huoshan') return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      world: 'ISOLATED',
      injectImmediately: true,
      func: authRelayFn,
    }).catch(() => {});
    chrome.storage.local.get('huoshanVariables', (data) => {
      const variables = data.huoshanVariables || {};
      chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        world: 'MAIN',
        injectImmediately: true,
        func: interceptorFnHuoshan,
        args: [
          cachedHuoshanRules.map((r) => ({ from: r.from, to: r.to })),
          variables,
        ],
      }).catch(() => {});
    });
  });
});

// 火山定时任务（独立 alarm，不编辑上方智谱 alarm）
chrome.alarms.create('refreshHuoshan', { periodInMinutes: 5 });
chrome.alarms.create('syncHuoshanCookies', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refreshHuoshan') fetchHuoshanRules();
  if (alarm.name === 'syncHuoshanCookies') syncHuoshanCookies();
});

// 火山 storage 变更监听（独立监听器，不编辑上方智谱 onChanged）
chrome.storage.onChanged.addListener((changes) => {
  if (changes.huoshanRules || changes.customHuoshanRules) {
    mergeAndApplyHuoshan();
  }
});

// 火山消息监听（独立监听器，不编辑上方智谱 onMessage）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'platformChanged') {
    getPlatform((platform) => {
      if (platform === 'huoshan') {
        fetchHuoshanRules();
      } else {
        clearHuoshanRules();
      }
    });
  }
  if (msg === 'refreshHuoshan') fetchHuoshanRules();
});

// 启动时尝试拉取火山规则（智谱模式下内部 no-op）
fetchHuoshanRules();

// ============================================================
// 百炼 Coding Plan 平台（Bailian）独立逻辑
// 与智谱/火山完全平行、互不干扰。复用纯工具函数：
//   parseRemoteRules / filterRules / wildcardToRegexFilter /
//   wildcardToRegexMatch / getDomainFromPattern / authRelayFn
// 规则 ID 段：重定向 40000~49999，请求头 50000~59999
// ============================================================

const REMOTE_URL_BAILIAN = 'https://api.hwaxy.cn/api/redirect-rules-bailian';
let cachedBailianRules = [];

// 拉取百炼远程规则（仅百炼模式下生效）
function fetchBailianRules() {
  getPlatform((platform) => {
    if (platform !== 'bailian') return;
    fetch(REMOTE_URL_BAILIAN)
      .then((res) => res.json())
      .then((json) => {
        const remoteRules = parseRemoteRules(json);
        chrome.storage.local.set({ bailianRules: remoteRules });
        mergeAndApplyBailian();
      })
      .catch((err) => {
        console.error('Failed to fetch bailian rules:', err);
        mergeAndApplyBailian();
      });
  });
}

// 合并百炼远程规则与自定义规则并应用
function mergeAndApplyBailian() {
  getPlatform((platform) => {
    if (platform !== 'bailian') return;
    chrome.storage.local.get(['bailianRules', 'customBailianRules', 'bailianVariables'], (data) => {
      const remoteRules = filterRules(data.bailianRules);
      const customRules = filterRules(data.customBailianRules);
      cachedBailianRules = [...remoteRules, ...customRules];
      applyBailianRules();
      injectBailianToActiveTabs(data.bailianVariables || {});
      syncBailianCookies();
    });
  });
}

// 百炼网络层重定向（declarativeNetRequest，ID 40000+，无 OCR 块）
function applyBailianRules() {
  const addRules = cachedBailianRules.map((r, i) => {
    const regexFilter = wildcardToRegexFilter(r.from);
    const escapedTo = (r.to || '').replace(/\\/g, '\\\\');
    const substitution = escapedTo + '\\2';
    return {
      id: 40000 + i,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: substitution },
      },
      condition: {
        regexFilter: regexFilter,
        resourceTypes: [
          'main_frame', 'sub_frame', 'stylesheet', 'script',
          'image', 'font', 'xmlhttprequest', 'other',
        ],
      },
    };
  });

  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    // 只移除百炼重定向规则（40000~49999），不触碰智谱/火山
    const removeIds = existing
      .filter((r) => r.id >= 40000 && r.id < 50000)
      .map((r) => r.id);
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: removeIds, addRules },
      () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
      }
    );
  });
}

// 百炼请求头同步（Cookie + Authorization，modifyHeaders ID 50000+）
function syncBailianCookies() {
  getPlatform((platform) => {
    if (platform !== 'bailian') return;
    chrome.storage.local.get(['bailianRules', 'customBailianRules', 'capturedAuth'], (data) => {
      const allRules = [
        ...filterRules(data.bailianRules),
        ...filterRules(data.customBailianRules),
      ];
      const auths = data.capturedAuth || {};

      const tasks = allRules.map((r) => {
        const domain = getDomainFromPattern(r.from);
        if (!domain) return Promise.resolve(null);
        return new Promise((resolve) => {
          chrome.cookies.getAll({ domain }, (cookies) => {
            resolve({ rule: r, cookies: cookies || [] });
          });
        });
      });

      Promise.all(tasks).then((results) => {
        const headerRules = [];
        let ruleId = 50000; // 百炼 header 规则从 50000 起，避免与智谱(10000+)/火山(30000+)冲突

        results.forEach((item) => {
          if (!item) return;
          const requestHeaders = [];

          if (item.cookies.length) {
            const cookieStr = item.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
            requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookieStr });
          }

          const fromDomain = getDomainFromPattern(item.rule.from);
          if (auths[fromDomain]) {
            requestHeaders.push({ header: 'Authorization', operation: 'set', value: auths[fromDomain] });
          }

          if (!requestHeaders.length) return;

          headerRules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: requestHeaders,
            },
            condition: {
              regexFilter: wildcardToRegexMatch(item.rule.to),
              resourceTypes: [
                'main_frame', 'sub_frame', 'stylesheet', 'script',
                'image', 'font', 'xmlhttprequest', 'other',
              ],
            },
          });
        });

        chrome.declarativeNetRequest.getDynamicRules((existing) => {
          // 只移除百炼 header 规则（50000~59999）
          const headerRuleIds = existing
            .filter((r) => r.id >= 50000 && r.id < 60000)
            .map((r) => r.id);
          chrome.declarativeNetRequest.updateDynamicRules(
            { removeRuleIds: headerRuleIds, addRules: headerRules },
            () => {
              if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
            }
          );
        });
      });
    });
  });
}

// 百炼 Content script 注入：更新已有标签页的规则（写入 __BAILIAN_RULES__）
function injectBailianToActiveTabs(variables) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.url || !tab.url.startsWith('http')) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: authRelayFn,
      }).catch(() => {});
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: updateBailianRules,
        args: [
          cachedBailianRules.map((r) => ({ from: r.from, to: r.to })),
          variables,
        ],
      }).catch(() => {});
    }
  });
}

function updateBailianRules(rules, variables) {
  window.__BAILIAN_RULES__ = rules;
  var parsed = {};
  for (var key in variables) {
    var raw = variables[key];
    try { parsed[key] = JSON.parse(raw); } catch (e) { parsed[key] = raw; }
  }
  window.__REDIRECT_VARS__ = parsed;
  for (var k in parsed) {
    try { window[k] = parsed[k]; } catch (e) {}
  }
}

// 百炼 JS 层拦截器（与 interceptorFn 镜像，使用 __BAILIAN_RULES__）
function interceptorFnBailian(rules, variables) {
  var parsed = {};
  for (var key in variables) {
    var raw = variables[key];
    try { parsed[key] = JSON.parse(raw); } catch (e) { parsed[key] = raw; }
  }
  window.__REDIRECT_VARS__ = parsed;
  for (var k in parsed) {
    try { window[k] = parsed[k]; } catch (e) {}
  }

  window.__BAILIAN_RULES__ = rules;

  function matchUrl(url, pattern) {
    try {
      url = new URL(url, location.href).href;
    } catch (e) {}
    var escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    var pathOnlyMatch = false;
    var finalPattern = escaped;
    if (pattern.endsWith('*') && !pattern.includes('?*')) {
      finalPattern = escaped.replace(/\*$/, '(\\?.*)?');
      pathOnlyMatch = true;
    }
    var regex = new RegExp('^' + finalPattern.replace(/\*/g, '.*') + '$');
    return regex.test(url);
  }

  function findRedirect(url) {
    var list = window.__BAILIAN_RULES__ || [];
    for (var i = 0; i < list.length; i++) {
      if (matchUrl(url, list[i].from)) return list[i].to;
    }
    return null;
  }

  function mergeParams(originalUrl, targetUrl) {
    try {
      var origUrlObj = new URL(originalUrl);
      var targetUrlObj = new URL(targetUrl);
      origUrlObj.searchParams.forEach(function(value, key) {
        targetUrlObj.searchParams.set(key, value);
      });
      return targetUrlObj.href;
    } catch (e) {
      return targetUrl;
    }
  }

  function captureAuth(url, headers) {
    try {
      var auth = null;
      if (!headers) return;
      if (typeof headers.get === 'function') {
        auth = headers.get('Authorization') || headers.get('authorization');
      } else if (Array.isArray(headers)) {
        for (var i = 0; i < headers.length; i++) {
          if (String(headers[i][0]).toLowerCase() === 'authorization') {
            auth = headers[i][1];
            break;
          }
        }
      } else if (typeof headers === 'object') {
        for (var k in headers) {
          if (k.toLowerCase() === 'authorization') {
            auth = headers[k];
            break;
          }
        }
      }
      if (auth) {
        var domain = new URL(url, location.href).hostname;
        window.postMessage({ type: '__REDIRECT_AUTH__', domain: domain, auth: auth }, '*');
      }
    } catch (e) {}
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string'
      ? input
      : input instanceof Request
        ? input.url
        : String(input);
    var target = findRedirect(url);
    if (target) {
      var headerSrc = (init && init.headers) ? init.headers
        : (input instanceof Request ? input.headers : null);
      captureAuth(url, headerSrc);

      var finalUrl = mergeParams(url, target);
      if (input instanceof Request) {
        input = new Request(finalUrl, input);
      } else {
        input = finalUrl;
      }
    }
    return origFetch.call(this, input, init);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__bailianFromUrl = url;
    this.__bailianTarget = findRedirect(url);
    if (this.__bailianTarget) {
      arguments[1] = mergeParams(url, this.__bailianTarget);
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__bailianTarget && String(name).toLowerCase() === 'authorization') {
      captureAuth(this.__bailianFromUrl, [[name, value]]);
    }
    return origSetHeader.apply(this, arguments);
  };
}

// 切换到其他平台时清空百炼 DNR 规则（40000~59999）
function clearBailianRules() {
  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    const removeIds = existing
      .filter((r) => r.id >= 40000 && r.id < 60000)
      .map((r) => r.id);
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: removeIds },
      () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
      }
    );
  });
  cachedBailianRules = [];
}

// 百炼 webNavigation 注入（独立监听器，不编辑上方智谱/火山 onCommitted）
// 注意：MV3 Service Worker 休眠重启后内存变量 cachedBailianRules 会丢失，
// 因此这里直接从 storage 读取规则注入，不依赖内存缓存，避免重启后漏注入。
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  getPlatform((platform) => {
    if (platform !== 'bailian') return;
    chrome.storage.local.get(['bailianRules', 'customBailianRules', 'bailianVariables'], (data) => {
      const rules = [...filterRules(data.bailianRules), ...filterRules(data.customBailianRules)];
      if (!rules.length) return;
      // 顺带恢复内存缓存，供 injectBailianToActiveTabs 等路径使用
      cachedBailianRules = rules;
      const variables = data.bailianVariables || {};
      chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        world: 'ISOLATED',
        injectImmediately: true,
        func: authRelayFn,
      }).catch(() => {});
      chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        world: 'MAIN',
        injectImmediately: true,
        func: interceptorFnBailian,
        args: [
          rules.map((r) => ({ from: r.from, to: r.to })),
          variables,
        ],
      }).catch(() => {});
    });
  });
});

// 百炼定时任务（独立 alarm，不编辑上方智谱/火山 alarm）
chrome.alarms.create('refreshBailian', { periodInMinutes: 5 });
chrome.alarms.create('syncBailianCookies', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refreshBailian') fetchBailianRules();
  if (alarm.name === 'syncBailianCookies') syncBailianCookies();
});

// 百炼 storage 变更监听（独立监听器，不编辑上方智谱/火山 onChanged）
chrome.storage.onChanged.addListener((changes) => {
  if (changes.bailianRules || changes.customBailianRules) {
    mergeAndApplyBailian();
  }
});

// 百炼消息监听（独立监听器，不编辑上方智谱/火山 onMessage）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'platformChanged') {
    getPlatform((platform) => {
      if (platform === 'bailian') {
        fetchBailianRules();
      } else {
        clearBailianRules();
      }
    });
  }
  if (msg === 'refreshBailian') fetchBailianRules();
});

// 启动时恢复百炼状态：MV3 Service Worker 重启后内存变量会丢失，
// 需先从 storage 恢复 cachedBailianRules 并重建 DNR 规则，再异步刷新远程规则。
// （非百炼模式下内部 no-op）
(function bootstrapBailian() {
  getPlatform((platform) => {
    if (platform !== 'bailian') return;
    chrome.storage.local.get(['bailianRules', 'customBailianRules'], (data) => {
      const rules = [...filterRules(data.bailianRules), ...filterRules(data.customBailianRules)];
      cachedBailianRules = rules;
      applyBailianRules();
      syncBailianCookies();
      // 再异步拉取最新远程规则
      fetchBailianRules();
    });
  });
})();
