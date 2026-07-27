const REMOTE_URL = 'https://api.hwaxy.cn/api/redirect-rules';

// 默认配置模板
const DEFAULT_CONFIG = {
  "StartTime": {
    "HOUR": 10,
    "MINUTE": 0,
    "SECOND": 0
  },
  "EndTime": {
    "HOUR": 10,
    "MINUTE": 15,
    "SECOND": 0
  },
  "IsCollectCodeLength": 1,
  "AutoVertifyRunning": false,
  "useQrCodeType": 2,
  "YING": {
    "USER": "",
    "PASS2": "",
    "SOFTID": "",
    "CODETYPE": "9800"
  },
  "BingKuo": {
    "USER": "",
    "PASS2": "",
    "CODETYPE": "1324"
  },
  "ClickIndex": 2,
  "CancelDelay": false,
  "qrCodeTimeOut": 1000,
  "localOcr": "",
  "Platform": "zhipu",
  "HuoshanStartTime": {
    "HOUR": 23,
    "MINUTE": 59,
    "SECOND": 59
  },
  "HuoshanEndTime": {
    "HOUR": 0,
    "MINUTE": 15,
    "SECOND": 0
  },
  "HuoshanSelector": ".operations-bMmsfJ button:last-child",
  "BailianStartTime": {
    "HOUR": 9,
    "MINUTE": 30,
    "SECOND": 0
  },
  "BailianEndTime": {
    "HOUR": 10,
    "MINUTE": 0,
    "SECOND": 0
  },
  "BailianSelector": ".submit-btn-glow"
};

document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage('refreshRemote');
  initUI();
});

// 火山平台默认配置（与智谱完全独立的变量集，存于 storage 'huoshanVariables'）
const HUOSHAN_DEFAULT_CONFIG = {
  "HuoshanStartTime": {
    "HOUR": 23,
    "MINUTE": 59,
    "SECOND": 59
  },
  "HuoshanEndTime": {
    "HOUR": 0,
    "MINUTE": 15,
    "SECOND": 0
  },
  "HuoshanSelector": ".operations-bMmsfJ button:last-child"
};

// 百炼 Coding Plan 平台默认配置（与智谱/火山完全独立的变量集，存于 storage 'bailianVariables'）
const BAILIAN_DEFAULT_CONFIG = {
  "BailianStartTime": {
    "HOUR": 9,
    "MINUTE": 30,
    "SECOND": 0
  },
  "BailianEndTime": {
    "HOUR": 10,
    "MINUTE": 0,
    "SECOND": 0
  },
  "BailianSelector": ".submit-btn-glow"
};

function initUI() {
  chrome.storage.local.get(['variables', 'customRules', 'huoshanVariables', 'bailianVariables'], (data) => {
    let vars = data.variables || {};
    let huoshanVars = data.huoshanVariables || {};
    let bailianVars = data.bailianVariables || {};

    // 清理旧的 var_* 键
    Object.keys(vars).forEach(k => {
      if (k.startsWith('var_')) delete vars[k];
    });

    // 确保默认配置存在
    if (!vars.MY_CONFIG) {
      try {
        // 如果已有值但格式不对，尝试解析
        if (typeof vars.MY_CONFIG === 'string') {
          vars.MY_CONFIG = JSON.parse(vars.MY_CONFIG);
        }
      } catch (e) {
        vars.MY_CONFIG = { ...DEFAULT_CONFIG };
      }
    } else {
      // 确保 MY_CONFIG 是对象
      if (typeof vars.MY_CONFIG === 'string') {
        try {
          vars.MY_CONFIG = JSON.parse(vars.MY_CONFIG);
        } catch (e) {
          vars.MY_CONFIG = { ...DEFAULT_CONFIG };
        }
      }
    }

    // 合并默认值，防止缺少字段
    vars.MY_CONFIG = mergeConfig(vars.MY_CONFIG, DEFAULT_CONFIG);

    // 火山独立配置：确保 huoshanVariables.MY_CONFIG 存在且字段齐全
    if (typeof huoshanVars.MY_CONFIG === 'string') {
      try { huoshanVars.MY_CONFIG = JSON.parse(huoshanVars.MY_CONFIG); }
      catch (e) { huoshanVars.MY_CONFIG = {}; }
    }
    huoshanVars.MY_CONFIG = mergeConfig(huoshanVars.MY_CONFIG || {}, HUOSHAN_DEFAULT_CONFIG);

    // 百炼独立配置：确保 bailianVariables.MY_CONFIG 存在且字段齐全
    if (typeof bailianVars.MY_CONFIG === 'string') {
      try { bailianVars.MY_CONFIG = JSON.parse(bailianVars.MY_CONFIG); }
      catch (e) { bailianVars.MY_CONFIG = {}; }
    }
    bailianVars.MY_CONFIG = mergeConfig(bailianVars.MY_CONFIG || {}, BAILIAN_DEFAULT_CONFIG);

    chrome.storage.local.set({ variables: vars, huoshanVariables: huoshanVars, bailianVariables: bailianVars }, () => {
      renderConfigUI();
      renderCustomRules();
      renderVariables();
    });
  });
}

// 深度合并配置，确保所有字段都存在
function mergeConfig(current, defaults) {
  const result = { ...defaults };
  for (const key in current) {
    if (current[key] !== null && typeof current[key] === 'object' && !Array.isArray(current[key])) {
      result[key] = mergeConfig(current[key], defaults[key] || {});
    } else {
      result[key] = current[key];
    }
  }
  return result;
}

// 渲染配置界面
function renderConfigUI() {
  chrome.storage.local.get('variables', (data) => {
    const config = (data.variables?.MY_CONFIG && typeof data.variables.MY_CONFIG === 'object')
      ? data.variables.MY_CONFIG
      : DEFAULT_CONFIG;

    const container = document.getElementById('config-ui');
    container.innerHTML = `
      <!-- 平台选择 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">平台选择</div>
          <div class="desc">智谱走现有逻辑；火山/百炼走各自独立拦截逻辑</div>
        </div>
        <div class="config-value">
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" name="platform" value="zhipu" ${(config.Platform || 'zhipu') === 'zhipu' ? 'checked' : ''}>
              <span>智谱</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="platform" value="huoshan" ${config.Platform === 'huoshan' ? 'checked' : ''}>
              <span>火山</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="platform" value="bailian" ${config.Platform === 'bailian' ? 'checked' : ''}>
              <span>百炼 Coding Plan</span>
            </label>
          </div>
        </div>
      </div>

      <div id="zhipu-config" class="${(config.Platform || 'zhipu') === 'zhipu' ? '' : 'hidden'}">
      <!-- 开始时间 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">开始时间</div>
          <div class="desc">开始点击订阅按钮的时间</div>
        </div>
        <div class="config-value">
          <div class="time-inputs">
            <input type="number" id="start-hour" min="0" max="23" value="${config.StartTime?.HOUR ?? 10}">
            <span>时</span>
            <input type="number" id="start-minute" min="0" max="59" value="${config.StartTime?.MINUTE ?? 0}">
            <span>分</span>
            <input type="number" id="start-second" min="0" max="59" value="${config.StartTime?.SECOND ?? 0}">
            <span>秒</span>
          </div>
        </div>
      </div>

      <!-- 结束时间 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">结束时间</div>
          <div class="desc">验证码自动打开的结束时间</div>
        </div>
        <div class="config-value">
          <div class="time-inputs">
            <input type="number" id="end-hour" min="0" max="23" value="${config.EndTime?.HOUR ?? 10}">
            <span>时</span>
            <input type="number" id="end-minute" min="0" max="59" value="${config.EndTime?.MINUTE ?? 5}">
            <span>分</span>
            <input type="number" id="end-second" min="0" max="59" value="${config.EndTime?.SECOND ?? 0}">
            <span>秒</span>
          </div>
        </div>
      </div>

      <!-- 自动验证开关 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">自动点击验证码</div>
          <div class="desc">开启后将自动处理验证码</div>
        </div>
        <div class="config-value">
          <label class="toggle-switch">
            <input type="checkbox" id="auto-verify" ${config.AutoVertifyRunning ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- 下单次数 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">下单接口次数</div>
          <div class="desc">每次发送下单接口的次数（1-10）</div>
        </div>
        <div class="config-value">
          <input type="number" id="code-length" min="1" max="10" value="${config.IsCollectCodeLength ?? 1}">
        </div>
      </div>

      <!-- 套餐选择 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">选择套餐</div>
          <div class="desc">点击订阅时使用的套餐类型</div>
        </div>
        <div class="config-value">
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" name="plan" value="1" ${config.ClickIndex === 1 ? 'checked' : ''}>
              <span>Lite</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="plan" value="2" ${config.ClickIndex === 2 ? 'checked' : ''}>
              <span>Pro</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="plan" value="3" ${config.ClickIndex === 3 ? 'checked' : ''}>
              <span>Max</span>
            </label>
          </div>
        </div>
      </div>

      <!-- 取消延时 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">取消延时</div>
          <div class="desc">开启后取消订阅前的延时等待</div>
        </div>
        <div class="config-value">
          <label class="toggle-switch">
            <input type="checkbox" id="cancel-delay" ${config.CancelDelay ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- 验证码超时 -->
      <div class="config-row">
        <div class="config-label">
          <div class="title">验证码超时</div>
          <div class="desc">验证码加载等待时间（毫秒），0表示不等待</div>
        </div>
        <div class="config-value">
          <input type="number" id="qr-timeout" min="0" step="100" value="${config.qrCodeTimeOut ?? 1000}" style="width: 80px;">
        </div>
      </div>

      <!-- 验证码平台配置 -->
      <div class="platform-section ${!config.AutoVertifyRunning ? 'hidden' : ''}" id="platform-section">
        <div class="platform-title">验证码平台配置</div>

        <!-- 平台选择 -->
        <div class="config-row" style="border-bottom: none; padding-bottom: 0;">
          <div class="config-label">
            <div class="title">验证码平台</div>
            <div class="desc">选择自动验证使用的服务平台</div>
          </div>
          <div class="config-value">
            <select id="platform-select" class="platform-select">
              <option value="1" ${config.useQrCodeType === 1 ? 'selected' : ''}>超级鹰</option>
              <option value="2" ${config.useQrCodeType === 2 ? 'selected' : ''}>冰拓</option>
              <option value="3" ${config.useQrCodeType === 3 ? 'selected' : ''}>本地OCR</option>
            </select>
          </div>
        </div>

        <!-- 超级鹰配置 -->
        <div class="platform-config ${config.useQrCodeType === 1 ? 'active' : ''}" id="ying-config">
          <div class="config-row">
            <div class="config-label">
              <div class="title">超级鹰账号</div>
            </div>
            <div class="config-value">
              <input type="text" id="ying-user" value="${config.YING?.USER ?? ''}">
            </div>
          </div>
          <div class="config-row">
            <div class="config-label">
              <div class="title">超级鹰密码</div>
            </div>
            <div class="config-value">
              <input type="password" id="ying-pass" value="${config.YING?.PASS2 ?? ''}">
            </div>
          </div>
          <div class="config-row">
            <div class="config-label">
              <div class="title">软件 ID</div>
            </div>
            <div class="config-value">
              <input type="text" id="ying-softid" value="${config.YING?.SOFTID ?? ''}">
            </div>
          </div>
          <div class="config-row">
            <div class="config-label">
              <div class="title">码类型</div>
            </div>
            <div class="config-value">
              <input type="text" id="ying-codetype" value="${config.YING?.CODETYPE ?? '9800'}">
            </div>
          </div>
        </div>

        <!-- 冰拓配置 -->
        <div class="platform-config ${config.useQrCodeType === 2 ? 'active' : ''}" id="bingkuo-config">
          <div class="config-row">
            <div class="config-label">
              <div class="title">冰拓账号</div>
            </div>
            <div class="config-value">
              <input type="text" id="bingkuo-user" value="${config.BingKuo?.USER ?? ''}">
            </div>
          </div>
          <div class="config-row">
            <div class="config-label">
              <div class="title">冰拓密码</div>
            </div>
            <div class="config-value">
              <input type="password" id="bingkuo-pass" value="${config.BingKuo?.PASS2 ?? ''}">
            </div>
          </div>
          <div class="config-row">
            <div class="config-label">
              <div class="title">码类型</div>
            </div>
            <div class="config-value">
              <input type="text" id="bingkuo-codetype" value="${config.BingKuo?.CODETYPE ?? '1324'}">
            </div>
          </div>
        </div>

        <!-- 本地OCR配置 -->
        <div class="platform-config ${config.useQrCodeType === 3 ? 'active' : ''}" id="localocr-config">
          <div class="config-row">
            <div class="config-label">
              <div class="title">本地OCR地址</div>
            </div>
            <div class="config-value">
              <input type="text" id="localocr-url" value="${config.localOcr ?? ''}" style="width: 200px;">
            </div>
          </div>
          <div class="config-row" id="local-ip-row">
            <div class="config-label">
              <div class="title">本机局域网 IP</div>
              <div class="desc" id="local-ip-hint">正在检测...</div>
            </div>
          </div>
        </div>
      </div>
      </div><!-- /zhipu-config -->

      <!-- 火山配置 -->
      <div id="huoshan-config" class="${config.Platform === 'huoshan' ? '' : 'hidden'}">
        <!-- 火山开始时间 -->
        <div class="config-row">
          <div class="config-label">
            <div class="title">开始时间</div>
            <div class="desc">火山：开始时间</div>
          </div>
          <div class="config-value">
            <div class="time-inputs">
              <input type="number" id="huoshan-start-hour" min="0" max="23" value="${config.HuoshanStartTime?.HOUR ?? 23}">
              <span>时</span>
              <input type="number" id="huoshan-start-minute" min="0" max="59" value="${config.HuoshanStartTime?.MINUTE ?? 59}">
              <span>分</span>
              <input type="number" id="huoshan-start-second" min="0" max="59" value="${config.HuoshanStartTime?.SECOND ?? 59}">
              <span>秒</span>
            </div>
          </div>
        </div>

        <!-- 火山结束时间 -->
        <div class="config-row">
          <div class="config-label">
            <div class="title">结束时间</div>
            <div class="desc">火山：结束时间</div>
          </div>
          <div class="config-value">
            <div class="time-inputs">
              <input type="number" id="huoshan-end-hour" min="0" max="23" value="${config.HuoshanEndTime?.HOUR ?? 0}">
              <span>时</span>
              <input type="number" id="huoshan-end-minute" min="0" max="59" value="${config.HuoshanEndTime?.MINUTE ?? 15}">
              <span>分</span>
              <input type="number" id="huoshan-end-second" min="0" max="59" value="${config.HuoshanEndTime?.SECOND ?? 0}">
              <span>秒</span>
            </div>
          </div>
        </div>

        <!-- 火山选择器 -->
        <div class="config-row">
          <div class="config-label">
            <div class="title">选择器</div>
            <div class="desc">火山页面元素 CSS 选择器</div>
          </div>
          <div class="config-value">
            <input type="text" id="huoshan-selector" value="${config.HuoshanSelector ?? '.operations-bMmsfJ button:last-child'}" style="width: 280px; text-align: left;">
          </div>
        </div>
      </div><!-- /huoshan-config -->

      <!-- 百炼配置 -->
      <div id="bailian-config" class="${config.Platform === 'bailian' ? '' : 'hidden'}">
        <!-- 百炼开始时间 -->
        <div class="config-row">
          <div class="config-label">
            <div class="title">开始时间</div>
            <div class="desc">百炼：开始时间</div>
          </div>
          <div class="config-value">
            <div class="time-inputs">
              <input type="number" id="bailian-start-hour" min="0" max="23" value="${config.BailianStartTime?.HOUR ?? 9}">
              <span>时</span>
              <input type="number" id="bailian-start-minute" min="0" max="59" value="${config.BailianStartTime?.MINUTE ?? 30}">
              <span>分</span>
              <input type="number" id="bailian-start-second" min="0" max="59" value="${config.BailianStartTime?.SECOND ?? 0}">
              <span>秒</span>
            </div>
          </div>
        </div>

        <!-- 百炼结束时间 -->
        <div class="config-row">
          <div class="config-label">
            <div class="title">结束时间</div>
            <div class="desc">百炼：结束时间</div>
          </div>
          <div class="config-value">
            <div class="time-inputs">
              <input type="number" id="bailian-end-hour" min="0" max="23" value="${config.BailianEndTime?.HOUR ?? 10}">
              <span>时</span>
              <input type="number" id="bailian-end-minute" min="0" max="59" value="${config.BailianEndTime?.MINUTE ?? 0}">
              <span>分</span>
              <input type="number" id="bailian-end-second" min="0" max="59" value="${config.BailianEndTime?.SECOND ?? 0}">
              <span>秒</span>
            </div>
          </div>
        </div>

        <!-- 百炼选择器 -->
        <div class="config-row">
          <div class="config-label">
            <div class="title">选择器</div>
            <div class="desc">百炼页面元素 CSS 选择器</div>
          </div>
          <div class="config-value">
            <input type="text" id="bailian-selector" value="${config.BailianSelector ?? '.submit-btn-glow'}" style="width: 280px; text-align: left;">
          </div>
        </div>
      </div><!-- /bailian-config -->
    `;

    // 绑定事件
    bindConfigEvents();
    // 检测本机局域网 IP（仅作为本地OCR地址填写的参考）
    detectLocalIP();
  });
}

// 通过 WebRTC ICE 候选获取本机局域网 IPv4
// 注意：Chrome 默认开启 mDNS 混淆时拿不到真实 IP，会返回 .local 主机名，此时无法自动获取
function detectLocalIP() {
  const hint = document.getElementById('local-ip-hint');
  if (!hint) return;

  let done = false;
  const ips = new Set();
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: [] });
  } catch (e) {
    hint.textContent = '当前浏览器不支持自动检测，请手动查看本机 IP';
    hint.style.color = '#d93025';
    return;
  }
  try { pc.createDataChannel(''); } catch (e) {}

  const finish = () => {
    if (done) return;
    done = true;
    try { pc.close(); } catch (e) {}
    // 过滤回环和链路本地地址
    const filtered = [...ips].filter(ip =>
      ip !== '127.0.0.1' && !ip.startsWith('169.254.')
    );
    if (filtered.length) {
      hint.innerHTML = '检测到：' + filtered.map(escapeHtml).join('、') +
        '<br>参考地址：https://' + escapeHtml(filtered[0]) + ':9898/click';
      hint.style.color = '#1a73e8';
    } else {
      hint.textContent = '未能自动获取（浏览器可能开启了 mDNS 混淆），请手动查看本机 IP';
      hint.style.color = '#d93025';
    }
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) {
      finish();
      return;
    }
    const line = e.candidate.candidate || '';
    const parts = line.split(/\s+/);
    if (parts.length >= 5) {
      const ip = parts[4];
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        ips.add(ip);
      }
    }
  };

  pc.createOffer().then(o => pc.setLocalDescription(o)).catch(finish);
  // 兜底超时，避免一直停在"正在检测..."
  setTimeout(finish, 1000);
}

// 根据平台显隐相关区块：智谱模式下显示全部；
// 火山/百炼模式下隐藏智谱配置区和自定义重定向规则，只显示该平台专属的配置区，
// 但保留「变量注入」（显示的是该平台独立的变量集 huoshanVariables / bailianVariables）
function applyPlatformVisibility(val) {
  const isZhipu = val !== 'huoshan' && val !== 'bailian';
  const zhipuConfig = document.getElementById('zhipu-config');
  const huoshanConfig = document.getElementById('huoshan-config');
  const bailianConfig = document.getElementById('bailian-config');
  const customRulesSection = document.getElementById('custom-rules-section');
  const variablesSection = document.getElementById('variables-section');

  if (zhipuConfig) zhipuConfig.classList.toggle('hidden', !isZhipu);
  if (huoshanConfig) huoshanConfig.classList.toggle('hidden', val !== 'huoshan');
  if (bailianConfig) bailianConfig.classList.toggle('hidden', val !== 'bailian');
  // 火山/百炼模式下隐藏智谱专属的「自定义重定向规则」
  if (customRulesSection) customRulesSection.classList.toggle('hidden', !isZhipu);
  // 变量注入区始终保留，切换平台时重新渲染对应平台的变量集
  if (variablesSection) variablesSection.classList.remove('hidden');
  renderVariables();
}

function bindConfigEvents() {
  // 平台选择切换：智谱/火山配置区互斥显示
  const platformRadios = document.querySelectorAll('input[name="platform"]');
  if (platformRadios.length) {
    platformRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        const val = document.querySelector('input[name="platform"]:checked')?.value;
        applyPlatformVisibility(val);
      });
    });
    // 初始渲染时同步一次显隐状态
    const initVal = document.querySelector('input[name="platform"]:checked')?.value || 'zhipu';
    applyPlatformVisibility(initVal);
  }

  // 自动验证开关切换时显示/隐藏平台配置
  const autoVerifyCheckbox = document.getElementById('auto-verify');
  const platformSection = document.getElementById('platform-section');
  if (autoVerifyCheckbox && platformSection) {
    autoVerifyCheckbox.addEventListener('change', () => {
      if (autoVerifyCheckbox.checked) {
        platformSection.classList.remove('hidden');
      } else {
        platformSection.classList.add('hidden');
      }
    });
  }

  // 平台选择切换
  const platformSelect = document.getElementById('platform-select');
  const yingConfig = document.getElementById('ying-config');
  const bingkuoConfig = document.getElementById('bingkuo-config');
  const localOcrConfig = document.getElementById('localocr-config');

  if (platformSelect) {
    platformSelect.addEventListener('change', () => {
      if (platformSelect.value === '1') {
        yingConfig.classList.add('active');
        bingkuoConfig.classList.remove('active');
        localOcrConfig.classList.remove('active');
      } else if (platformSelect.value === '2') {
        yingConfig.classList.remove('active');
        bingkuoConfig.classList.add('active');
        localOcrConfig.classList.remove('active');
      } else if (platformSelect.value === '3') {
        yingConfig.classList.remove('active');
        bingkuoConfig.classList.remove('active');
        localOcrConfig.classList.add('active');
      }
    });
  }

  // 保存按钮
  document.getElementById('save-config').addEventListener('click', saveConfig);

  // 添加自定义规则按钮
  document.getElementById('add-rule-btn').addEventListener('click', () => {
    const from = document.getElementById('new-rule-from').value.trim();
    const to = document.getElementById('new-rule-to').value.trim();
    addCustomRule(from, to);
  });

  // 支持回车添加规则
  document.getElementById('new-rule-to').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const from = document.getElementById('new-rule-from').value.trim();
      const to = document.getElementById('new-rule-to').value.trim();
      addCustomRule(from, to);
    }
  });
}

function saveConfig() {
  chrome.storage.local.get(['variables', 'huoshanVariables', 'bailianVariables'], (data) => {
    const vars = data.variables || {};
    const huoshanVars = data.huoshanVariables || {};
    const bailianVars = data.bailianVariables || {};

    // 火山 3 字段（独立写入 huoshanVariables.MY_CONFIG，火山页面注入用）
    const huoshanConfig = {
      HuoshanStartTime: {
        HOUR: parseInt(document.getElementById('huoshan-start-hour')?.value) || 0,
        MINUTE: parseInt(document.getElementById('huoshan-start-minute')?.value) || 0,
        SECOND: parseInt(document.getElementById('huoshan-start-second')?.value) || 0
      },
      HuoshanEndTime: {
        HOUR: parseInt(document.getElementById('huoshan-end-hour')?.value) || 0,
        MINUTE: parseInt(document.getElementById('huoshan-end-minute')?.value) || 0,
        SECOND: parseInt(document.getElementById('huoshan-end-second')?.value) || 0
      },
      HuoshanSelector: document.getElementById('huoshan-selector')?.value || ''
    };

    // 百炼 3 字段（独立写入 bailianVariables.MY_CONFIG，百炼页面注入用）
    const bailianConfig = {
      BailianStartTime: {
        HOUR: parseInt(document.getElementById('bailian-start-hour')?.value) || 0,
        MINUTE: parseInt(document.getElementById('bailian-start-minute')?.value) || 0,
        SECOND: parseInt(document.getElementById('bailian-start-second')?.value) || 0
      },
      BailianEndTime: {
        HOUR: parseInt(document.getElementById('bailian-end-hour')?.value) || 0,
        MINUTE: parseInt(document.getElementById('bailian-end-minute')?.value) || 0,
        SECOND: parseInt(document.getElementById('bailian-end-second')?.value) || 0
      },
      BailianSelector: document.getElementById('bailian-selector')?.value || ''
    };

    const newConfig = {
      StartTime: {
        HOUR: parseInt(document.getElementById('start-hour').value) || 0,
        MINUTE: parseInt(document.getElementById('start-minute').value) || 0,
        SECOND: parseInt(document.getElementById('start-second').value) || 0
      },
      EndTime: {
        HOUR: parseInt(document.getElementById('end-hour').value) || 0,
        MINUTE: parseInt(document.getElementById('end-minute').value) || 0,
        SECOND: parseInt(document.getElementById('end-second').value) || 0
      },
      IsCollectCodeLength: Math.min(10, Math.max(1, parseInt(document.getElementById('code-length').value) || 1)),
      AutoVertifyRunning: document.getElementById('auto-verify').checked,
      useQrCodeType: parseInt(document.getElementById('platform-select').value),
      ClickIndex: parseInt(document.querySelector('input[name="plan"]:checked')?.value) || 1,
      CancelDelay: document.getElementById('cancel-delay').checked,
      qrCodeTimeOut: Number(document.getElementById('qr-timeout').value) || 0,
      YING: {
        USER: document.getElementById('ying-user').value,
        PASS2: document.getElementById('ying-pass').value,
        SOFTID: document.getElementById('ying-softid').value,
        CODETYPE: document.getElementById('ying-codetype').value
      },
      BingKuo: {
        USER: document.getElementById('bingkuo-user').value,
        PASS2: document.getElementById('bingkuo-pass').value,
        CODETYPE: document.getElementById('bingkuo-codetype').value
      },
      localOcr: document.getElementById('localocr-url').value,
      Platform: document.querySelector('input[name="platform"]:checked')?.value || 'zhipu',
      ...huoshanConfig,
      ...bailianConfig
    };

    vars.MY_CONFIG = newConfig;
    // 火山独立配置也写入 huoshanVariables.MY_CONFIG，供火山页面注入
    huoshanVars.MY_CONFIG = huoshanConfig;
    // 百炼独立配置也写入 bailianVariables.MY_CONFIG，供百炼页面注入
    bailianVars.MY_CONFIG = bailianConfig;
    chrome.storage.local.set({ variables: vars, huoshanVariables: huoshanVars, bailianVariables: bailianVars }, () => {
      // 显示保存成功反馈
      const btn = document.getElementById('save-config');
      const originalText = btn.textContent;
      btn.textContent = '✓ 已保存';
      btn.style.background = '#34a853';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '#1a73e8';
      }, 1500);
      // 当前若处于火山/百炼模式，同步刷新变量注入栏
      const currentPlatform = document.querySelector('input[name="platform"]:checked')?.value;
      if (currentPlatform === 'huoshan' || currentPlatform === 'bailian') {
        renderVariables();
      }
      // 通知 background.js 平台配置可能已变化（拉取/清空对应平台规则）
      try { chrome.runtime.sendMessage({ type: 'platformChanged' }); } catch (e) {}
    });
  });
}

// 渲染自定义规则
function renderCustomRules() {
  chrome.storage.local.get('customRules', (data) => {
    const container = document.getElementById('custom-rules');
    const rules = data.customRules || [];

    if (!rules.length) {
      container.innerHTML = '<div class="empty">暂无自定义规则</div>';
      return;
    }

    container.innerHTML = rules.map((rule, index) => `
      <div class="var-row" data-index="${index}">
        <div style="display: flex; gap: 8px; align-items: center;">
          <div style="flex: 1; font-family: monospace; font-size: 12px; word-break: break-all; color: #666;">
            ${escapeHtml(rule.from)}
          </div>
          <div style="color: #999;">→</div>
          <div style="flex: 1; font-family: monospace; font-size: 12px; word-break: break-all; color: #1a73e8;">
            ${escapeHtml(rule.to)}
          </div>
          <button class="btn-del" data-index="${index}">删除</button>
        </div>
      </div>
    `).join('');

    // 绑定删除事件
    container.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index);
        deleteCustomRule(index);
      });
    });
  });
}

// 添加自定义规则
function addCustomRule(from, to) {
  if (!from || !to) {
    alert('请填写完整的匹配规则和重定向地址');
    return;
  }

  chrome.storage.local.get('customRules', (data) => {
    const rules = data.customRules || [];
    rules.push({ from, to, enabled: true });
    chrome.storage.local.set({ customRules: rules }, () => {
      // 清空输入框
      document.getElementById('new-rule-from').value = '';
      document.getElementById('new-rule-to').value = '';
      renderCustomRules();
      // 通知 background.js 重新应用规则
      chrome.runtime.sendMessage('refreshRules');
    });
  });
}

// 删除自定义规则
function deleteCustomRule(index) {
  chrome.storage.local.get('customRules', (data) => {
    const rules = data.customRules || [];
    rules.splice(index, 1);
    chrome.storage.local.set({ customRules: rules }, () => {
      renderCustomRules();
      // 通知 background.js 重新应用规则
      chrome.runtime.sendMessage('refreshRules');
    });
  });
}

// 渲染变量注入区域（保留原有功能）
// 智谱模式读写 storage 'variables'；火山模式读写 'huoshanVariables'；百炼模式读写 'bailianVariables'
function getVarsStorageKey() {
  const platform = document.querySelector('input[name="platform"]:checked')?.value;
  if (platform === 'huoshan') return 'huoshanVariables';
  if (platform === 'bailian') return 'bailianVariables';
  return 'variables';
}

function renderVariables() {
  const storageKey = getVarsStorageKey();
  chrome.storage.local.get(storageKey, (data) => {
    const container = document.getElementById('variables');
    const vars = data[storageKey] || {};
    const keys = Object.keys(vars);

    if (!keys.length) {
      container.innerHTML = '<div class="empty">暂无变量</div>';
      return;
    }

    container.innerHTML = keys.map((key) => {
      const isConfig = key === 'MY_CONFIG';
      const val = vars[key];
      let raw = '';
      if (val === null || val === undefined) {
        raw = '';
      } else if (typeof val === 'string') {
        raw = val;
      } else {
        raw = JSON.stringify(val, null, 2);
      }

      // MY_CONFIG 显示为只读预览
      if (isConfig) {
        return `
        <div class="var-row" data-key="${escapeHtml(key)}" style="background: #e8f0fe; border-color: #1a73e8;">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
            <input type="text" class="var-key" value="${escapeHtml(key)}" readonly style="flex:1;background:#e8f0fe;color:#1a73e8;font-weight:600;border:none;" />
          </div>
          <pre class="var-val-readonly" style="width:100%;padding:10px;font-family:'SF Mono',Consolas,monospace;font-size:11px;overflow:auto;background:#fff;border:1px solid #d0d0d0;border-radius:4px;max-height:200px;">${escapeHtml(raw)}</pre>
        </div>
        `;
      }

      return `
      <div class="var-row" data-key="${escapeHtml(key)}">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input type="text" class="var-key" value="${escapeHtml(key)}" placeholder="变量名" style="flex:1" />
          <button class="btn-del">删除</button>
        </div>
        <textarea class="var-val" placeholder='字符串直接写，对象用 JSON 格式：{"a":1}' rows="${Math.max(2, (raw.match(/\n/g)||[]).length + 1)}">${escapeHtml(raw)}</textarea>
      </div>
    `}).join('');

    container.querySelectorAll('.var-row').forEach((row) => {
      const origKey = row.dataset.key;

      // MY_CONFIG 是只读的，跳过事件绑定
      if (origKey === 'MY_CONFIG') return;

      row.querySelector('.var-key').addEventListener('change', (e) => {
        const k = getVarsStorageKey();
        chrome.storage.local.get(k, (data) => {
          const vars = data[k] || {};
          const newKey = e.target.value.trim();
          if (newKey && newKey !== origKey) {
            vars[newKey] = vars[origKey];
            delete vars[origKey];
            chrome.storage.local.set({ [k]: vars }, renderVariables);
          }
        });
      });

      row.querySelector('.var-val')?.addEventListener('input', (e) => {
        const k = getVarsStorageKey();
        chrome.storage.local.get(k, (data) => {
          const vars = data[k] || {};
          const currentKey = row.querySelector('.var-key').value.trim();
          if (currentKey) {
            vars[currentKey] = e.target.value;
            if (origKey !== currentKey) delete vars[origKey];
            chrome.storage.local.set({ [k]: vars });
          }
        });
      });

      row.querySelector('.btn-del')?.addEventListener('click', () => {
        const k = getVarsStorageKey();
        chrome.storage.local.get(k, (data) => {
          const vars = data[k] || {};
          delete vars[origKey];
          chrome.storage.local.set({ [k]: vars }, renderVariables);
        });
      });
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
