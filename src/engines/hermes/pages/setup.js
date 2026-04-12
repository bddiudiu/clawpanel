/**
 * Hermes Agent 一键安装/配置向导
 *
 * 状态机: detect → install → configure → gateway → complete
 */
import { t } from '../../../lib/i18n.js'
import { api, invalidate } from '../../../lib/tauri-api.js'
import { PROVIDER_PRESETS } from '../../../lib/model-presets.js'
import { getActiveEngine } from '../../../lib/engine-manager.js'

// SVG 图标
const ICONS = {
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--warning, #f59e0b)" stroke-width="2" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--error, #ef4444)" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  spinner: `<svg class="hermes-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 2a10 10 0 0110 10"/></svg>`,
  rocket: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
  done: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" width="24" height="24"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
}

// 可选 extras
const EXTRAS_LIST = [
  { key: 'cron', i18n: 'extraCron', recommended: true },
  { key: 'cli', i18n: 'extraCli', recommended: true },
  { key: 'pty', i18n: 'extraPty', recommended: true },
  { key: 'mcp', i18n: 'extraMcp', recommended: true },
  { key: 'messaging', i18n: 'extraMessaging' },
  { key: 'feishu', i18n: 'extraFeishu' },
  { key: 'dingtalk', i18n: 'extraDingtalk' },
  { key: 'slack', i18n: 'extraSlack' },
  { key: 'voice', i18n: 'extraVoice' },
]

// Hermes 使用 OpenAI 兼容接口，过滤出兼容的服务商
const HERMES_PROVIDERS = PROVIDER_PRESETS.filter(p => !p.hidden)

export function render() {
  const el = document.createElement('div')
  el.className = 'page'

  // 状态
  let phase = 'detect' // detect | install | configure | gateway | complete
  let pyInfo = null
  let hermesInfo = null
  let logs = []
  let installing = false
  let progress = 0
  let showLogs = false
  let selectedExtras = ['cron', 'cli', 'pty', 'mcp']
  let unlisten = null

  function draw() {
    el.innerHTML = `
      <div class="page-header">
        <h1>Hermes Agent</h1>
        <p style="color:var(--text-secondary);margin-top:4px">${t('engine.hermesSetupDesc')}</p>
      </div>
      <div style="max-width:720px">
        ${renderPhaseIndicator()}
        ${phase === 'detect' ? renderDetect() : ''}
        ${phase === 'install' ? renderInstall() : ''}
        ${phase === 'configure' ? renderConfigure() : ''}
        ${phase === 'gateway' ? renderGateway() : ''}
        ${phase === 'complete' ? renderComplete() : ''}
        ${renderLogPanel()}
        <div style="margin-top:16px;text-align:right">
          <a href="https://hermes-agent.nousresearch.com/docs/getting-started/installation/" target="_blank" rel="noopener"
             style="font-size:13px;color:var(--accent);text-decoration:none">
            ${t('engine.hermesSetupDocLink')} →
          </a>
        </div>
      </div>`
    bind()
  }

  // --- 阶段指示器 ---
  function renderPhaseIndicator() {
    const phases = [
      { id: 'detect', label: '检测' },
      { id: 'install', label: '安装' },
      { id: 'configure', label: '配置' },
      { id: 'gateway', label: '启动' },
      { id: 'complete', label: '完成' },
    ]
    const idx = phases.findIndex(p => p.id === phase)
    return `<div class="hermes-phases">${phases.map((p, i) => {
      const cls = i < idx ? 'done' : i === idx ? 'active' : ''
      return `<div class="hermes-phase ${cls}">
        <span class="hermes-phase-dot">${i < idx ? ICONS.check : i + 1}</span>
        <span class="hermes-phase-label">${p.label}</span>
      </div>`
    }).join('<div class="hermes-phase-line"></div>')}</div>`
  }

  // --- 检测阶段 ---
  function renderDetect() {
    const rows = []
    if (!pyInfo && !hermesInfo) {
      rows.push(`<div class="hermes-detect-row">${ICONS.spinner} <span>${t('engine.detecting')}</span></div>`)
    } else {
      // Python
      if (pyInfo) {
        if (pyInfo.installed && pyInfo.versionOk) {
          rows.push(`<div class="hermes-detect-row ok">${ICONS.check} <span>${t('engine.pythonFound', { version: pyInfo.version })}</span></div>`)
        } else if (pyInfo.installed && !pyInfo.versionOk) {
          rows.push(`<div class="hermes-detect-row warn">${ICONS.warn} <span>${t('engine.pythonTooOld', { version: pyInfo.version })}</span></div>`)
        } else {
          rows.push(`<div class="hermes-detect-row warn">${ICONS.warn} <span>${t('engine.pythonNotFound')}</span></div>`)
        }
        // uv
        if (pyInfo.hasUv) {
          rows.push(`<div class="hermes-detect-row ok">${ICONS.check} <span>${t('engine.uvFound')}</span></div>`)
        } else {
          rows.push(`<div class="hermes-detect-row warn">${ICONS.warn} <span>${t('engine.uvNotFound')}</span></div>`)
        }
        // git（从 GitHub 安装需要）
        if (pyInfo.hasGit) {
          rows.push(`<div class="hermes-detect-row ok">${ICONS.check} <span>${t('engine.gitFound')}</span></div>`)
        } else {
          rows.push(`<div class="hermes-detect-row warn">${ICONS.error} <span>${t('engine.gitNotFound')}</span></div>`)
        }
      }
      // Hermes
      if (hermesInfo) {
        if (hermesInfo.installed) {
          rows.push(`<div class="hermes-detect-row ok">${ICONS.check} <span>${t('engine.hermesFound', { version: hermesInfo.version })}</span></div>`)
          if (hermesInfo.gatewayRunning) {
            rows.push(`<div class="hermes-detect-row ok">${ICONS.check} <span>${t('engine.hermesReady')}</span></div>`)
          }
        } else {
          rows.push(`<div class="hermes-detect-row">${ICONS.warn} <span>${t('engine.hermesNotFound')}</span></div>`)
        }
      }
    }
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-body" style="padding:24px">
        <p style="color:var(--text-secondary);line-height:1.7;margin:0 0 16px">${t('engine.hermesSetupIntro')}</p>
        <div class="hermes-detect-list">${rows.join('')}</div>
      </div>
    </div>`
  }

  // --- 安装阶段 ---
  function renderInstall() {
    const extrasHtml = EXTRAS_LIST.map(ex => {
      const checked = selectedExtras.includes(ex.key) ? 'checked' : ''
      return `<label class="hermes-extra-item">
        <input type="checkbox" value="${ex.key}" ${checked} class="hermes-extra-cb">
        <span>${t('engine.' + ex.i18n)}${ex.recommended ? ' ⭐' : ''}</span>
      </label>`
    }).join('')

    const btnText = installing ? `${ICONS.spinner} ${t('engine.installingBtn')}` : `${ICONS.rocket} ${t('engine.installBtn')}`
    const btnDisabled = installing ? 'disabled' : ''

    return `<div class="card" style="margin-bottom:16px">
      <div class="card-body" style="padding:24px">
        <h3 style="margin:0 0 4px;font-size:16px">${t('engine.installTitle')}</h3>
        <p style="color:var(--text-secondary);margin:0 0 20px;font-size:13px">${t('engine.installDesc')}</p>

        <div style="margin-bottom:20px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">${t('engine.extrasTitle')}</div>
          <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 10px">${t('engine.extrasDesc')}</p>
          <div class="hermes-extras-grid">${extrasHtml}</div>
          <button class="btn-text hermes-select-all" style="margin-top:6px;font-size:12px">${t('engine.extraAll')}</button>
        </div>

        ${progress > 0 ? `<div class="hermes-progress"><div class="hermes-progress-bar" style="width:${progress}%"></div></div>` : ''}

        <div style="display:flex;gap:10px;align-items:center">
          <button class="btn btn-primary hermes-install-btn" ${btnDisabled}>${btnText}</button>
          ${!installing ? `<button class="btn-text hermes-toggle-logs" style="font-size:12px">${showLogs ? t('engine.hideLogs') : t('engine.viewLogs')}</button>` : ''}
        </div>
      </div>
    </div>`
  }

  // --- 配置阶段 ---
  function renderConfigure() {
    const presetBtns = HERMES_PROVIDERS.map(p =>
      `<button class="btn btn-sm btn-secondary hermes-preset-btn" data-key="${p.key}" data-url="${p.baseUrl}" data-api="${p.api}" style="font-size:12px;padding:3px 10px;margin:0 6px 6px 0">${p.label}${p.badge ? ` <span style="font-size:9px;background:var(--accent);color:#fff;padding:1px 4px;border-radius:6px;margin-left:3px">${p.badge}</span>` : ''}</button>`
    ).join('')

    return `<div class="card" style="margin-bottom:16px">
      <div class="card-body" style="padding:24px">
        <h3 style="margin:0 0 4px;font-size:16px">${t('engine.configTitle')}</h3>
        <p style="color:var(--text-secondary);margin:0 0 20px;font-size:13px">${t('engine.configDesc')}</p>

        <div class="hermes-form">
          <div class="hermes-field">
            <span>${t('engine.configProvider')}</span>
            <div style="display:flex;flex-wrap:wrap">${presetBtns}</div>
            <div id="hm-preset-detail" style="display:none;margin-top:6px;padding:8px 12px;background:var(--bg-tertiary);border-radius:var(--radius-md,8px);font-size:12px"></div>
          </div>
          <label class="hermes-field">
            <span>API Base URL</span>
            <input type="text" id="hm-baseurl" class="input" placeholder="https://openrouter.ai/api/v1">
          </label>
          <div class="hermes-field">
            <span>${t('engine.configApiKey')}</span>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="password" id="hm-apikey" class="input" placeholder="sk-..." autocomplete="off" style="flex:1">
              <button class="btn btn-sm btn-secondary hermes-fetch-models" style="white-space:nowrap;flex-shrink:0">${t('engine.configFetchModels')}</button>
            </div>
          </div>
          <div id="hm-fetch-result" style="font-size:12px;min-height:16px;margin:-6px 0 2px"></div>
          <div class="hermes-field">
            <span>${t('engine.configModel')}</span>
            <div style="position:relative">
              <input type="text" id="hm-model" class="input" placeholder="anthropic/claude-sonnet-4-20250514" autocomplete="off">
              <div id="hm-model-dropdown" class="hermes-model-dropdown" style="display:none"></div>
            </div>
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:20px">
          <button class="btn btn-primary hermes-config-save">${t('engine.configSaveBtn')}</button>
          <button class="btn-text hermes-config-skip">${t('engine.configSkipBtn')}</button>
        </div>
      </div>
    </div>`
  }

  // --- Gateway 阶段 ---
  function renderGateway() {
    const running = hermesInfo?.gatewayRunning
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-body" style="padding:24px">
        <h3 style="margin:0 0 4px;font-size:16px">${t('engine.gatewayTitle')}</h3>
        <p style="color:var(--text-secondary);margin:0 0 20px;font-size:13px">${t('engine.gatewayDesc')}</p>
        <div class="hermes-detect-row ${running ? 'ok' : ''}">
          ${running ? ICONS.check : ICONS.warn}
          <span>${running ? t('engine.gatewayRunning', { port: hermesInfo?.gatewayPort || 8642 }) : t('engine.gatewayStopped')}</span>
        </div>
        <div id="hm-gw-error" style="display:none;margin-top:12px;padding:10px 14px;background:var(--error-bg, #fef2f2);border:1px solid var(--error, #ef4444);border-radius:var(--radius-sm,6px);color:var(--error, #ef4444);font-size:13px;line-height:1.5;word-break:break-all"></div>
        <div style="display:flex;gap:10px;margin-top:16px">
          ${!running ? `<button class="btn btn-primary hermes-gw-start">${t('engine.gatewayStartBtn')}</button>` : ''}
          <button class="btn btn-primary hermes-gw-next">${running ? t('engine.goToDashboard') : t('engine.configSkipBtn')}</button>
        </div>
      </div>
    </div>`
  }

  // --- 完成 ---
  function renderComplete() {
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-body" style="padding:32px;text-align:center">
        <div style="margin-bottom:12px">${ICONS.done}</div>
        <h3 style="margin:0 0 6px;font-size:18px">${t('engine.setupComplete')}</h3>
        <p style="color:var(--text-secondary);margin:0 0 20px">${t('engine.setupCompleteDesc')}</p>
        <button class="btn btn-primary hermes-go-dashboard">${t('engine.goToDashboard')}</button>
      </div>
    </div>`
  }

  // --- 日志面板 ---
  function renderLogPanel() {
    if (!showLogs || logs.length === 0) return ''
    return `<div class="hermes-log-panel">
      <div class="hermes-log-content">${logs.map(l => `<div>${esc(l)}</div>`).join('')}</div>
    </div>`
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  // --- 事件绑定 ---
  function bind() {
    // 安装按钮
    el.querySelector('.hermes-install-btn')?.addEventListener('click', doInstall)
    // 全选 extras
    el.querySelector('.hermes-select-all')?.addEventListener('click', () => {
      selectedExtras = EXTRAS_LIST.map(e => e.key)
      draw()
    })
    // extras checkbox
    el.querySelectorAll('.hermes-extra-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked && !selectedExtras.includes(cb.value)) selectedExtras.push(cb.value)
        else selectedExtras = selectedExtras.filter(k => k !== cb.value)
      })
    })
    // 日志切换
    el.querySelector('.hermes-toggle-logs')?.addEventListener('click', () => {
      showLogs = !showLogs; draw()
    })
    // 服务商预设按钮
    el.querySelectorAll('.hermes-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const baseUrlInput = el.querySelector('#hm-baseurl')
        if (baseUrlInput) baseUrlInput.value = btn.dataset.url
        // 高亮选中
        el.querySelectorAll('.hermes-preset-btn').forEach(b => b.style.opacity = '0.5')
        btn.style.opacity = '1'
        // 显示服务商详情
        const preset = HERMES_PROVIDERS.find(p => p.key === btn.dataset.key)
        const detailEl = el.querySelector('#hm-preset-detail')
        if (detailEl && preset) {
          let html = preset.desc ? `<div style="color:var(--text-secondary);line-height:1.5">${preset.desc}</div>` : ''
          if (preset.site) html += `<a href="${preset.site}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:11px;margin-top:3px;display:inline-block">→ ${preset.label} 官网</a>`
          detailEl.innerHTML = html
          detailEl.style.display = html ? 'block' : 'none'
        }
      })
    })
    // 获取模型列表
    el.querySelector('.hermes-fetch-models')?.addEventListener('click', doFetchModels)
    // 模型下拉选择：点击选项填入 input
    el.querySelector('#hm-model-dropdown')?.addEventListener('click', (e) => {
      const opt = e.target.closest('.hermes-model-option')
      if (!opt) return
      const modelInput = el.querySelector('#hm-model')
      if (modelInput) modelInput.value = opt.dataset.model
      el.querySelector('#hm-model-dropdown').style.display = 'none'
    })
    // 点击 input 时如果有下拉就展开
    el.querySelector('#hm-model')?.addEventListener('focus', () => {
      const dd = el.querySelector('#hm-model-dropdown')
      if (dd && dd.children.length > 0) dd.style.display = 'block'
    })
    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      const dd = el.querySelector('#hm-model-dropdown')
      if (dd && !e.target.closest('.hermes-field')) dd.style.display = 'none'
    })
    // 配置保存
    el.querySelector('.hermes-config-save')?.addEventListener('click', doSaveConfig)
    el.querySelector('.hermes-config-skip')?.addEventListener('click', () => { phase = 'gateway'; refreshHermes() })
    // Gateway
    el.querySelector('.hermes-gw-start')?.addEventListener('click', doStartGateway)
    el.querySelector('.hermes-gw-next')?.addEventListener('click', () => {
      if (hermesInfo?.gatewayRunning) { phase = 'complete'; draw() }
      else { phase = 'complete'; draw() }
    })
    // 仪表盘
    el.querySelector('.hermes-go-dashboard')?.addEventListener('click', async () => {
      const engine = getActiveEngine()
      if (engine?.detect) await engine.detect()
      window.location.hash = '#/h/dashboard'
    })
    // 自动滚日志到底
    const logEl = el.querySelector('.hermes-log-content')
    if (logEl) logEl.scrollTop = logEl.scrollHeight
  }

  // --- 检测流程 ---
  async function detect() {
    phase = 'detect'
    draw()
    try {
      invalidate('check_hermes', 'check_python')
      const [py, hm] = await Promise.all([api.checkPython(), api.checkHermes()])
      pyInfo = py
      hermesInfo = hm

      draw()

      // 自动跳转
      await new Promise(r => setTimeout(r, 800))
      if (hm.installed && hm.gatewayRunning) {
        phase = 'complete'
        // 更新引擎状态并自动跳转仪表盘
        const engine = getActiveEngine()
        if (engine?.detect) await engine.detect()
        window.location.hash = '#/h/dashboard'
        return
      } else if (hm.installed && hm.configExists) {
        phase = 'gateway'
      } else if (hm.installed) {
        phase = 'configure'
      } else {
        phase = 'install'
      }
      draw()
    } catch (e) {
      logs.push(`检测错误: ${e}`)
      phase = 'install'
      draw()
    }
  }

  // --- 安装流程 ---
  async function doInstall() {
    installing = true
    progress = 0
    showLogs = true
    logs = []
    draw()

    // 监听事件
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const u1 = await listen('hermes-install-log', (e) => {
        logs.push(String(e.payload))
        const logEl = el.querySelector('.hermes-log-content')
        if (logEl) {
          logEl.innerHTML += `<div>${esc(String(e.payload))}</div>`
          logEl.scrollTop = logEl.scrollHeight
        }
      })
      const u2 = await listen('hermes-install-progress', (e) => {
        progress = Number(e.payload) || 0
        const bar = el.querySelector('.hermes-progress-bar')
        if (bar) bar.style.width = progress + '%'
      })
      unlisten = () => { u1(); u2() }
    } catch (_) {}

    try {
      await api.installHermes('uv-tool', selectedExtras)
      installing = false
      progress = 100
      logs.push(t('engine.installSuccess'))
      phase = 'configure'
      draw()
    } catch (e) {
      installing = false
      logs.push(`${t('engine.installFailed')}: ${e}`)
      draw()
    } finally {
      if (unlisten) { unlisten(); unlisten = null }
    }
  }

  // --- 获取模型列表 ---
  async function doFetchModels() {
    const btn = el.querySelector('.hermes-fetch-models')
    const resultEl = el.querySelector('#hm-fetch-result')
    const dropdown = el.querySelector('#hm-model-dropdown')
    const baseUrl = el.querySelector('#hm-baseurl')?.value?.trim()
    const apiKey = el.querySelector('#hm-apikey')?.value?.trim()

    if (!baseUrl) {
      if (resultEl) resultEl.innerHTML = `<span style="color:var(--warning)">${t('engine.configFetchNeedUrl')}</span>`
      return
    }
    if (!apiKey) {
      if (resultEl) resultEl.innerHTML = `<span style="color:var(--warning)">${t('engine.configFetchNeedKey')}</span>`
      return
    }

    if (btn) { btn.disabled = true; btn.textContent = t('engine.configFetching') }
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--text-tertiary)">${t('engine.configFetching')}</span>`

    try {
      // 清理 URL：去掉尾部多余路径，确保 /models 能正确拼接
      let base = baseUrl.replace(/\/+$/, '')
      // 移除常见尾部路径
      base = base.replace(/\/(chat\/completions|completions|responses|messages|models)\/?$/, '')

      // 判断 API 类型（大部分是 OpenAI 兼容）
      const matched = HERMES_PROVIDERS.find(p => baseUrl === p.baseUrl)
      const apiType = matched?.api || 'openai-completions'

      let models = []

      if (apiType === 'anthropic-messages') {
        // Anthropic 格式
        if (!base.endsWith('/v1')) base += '/v1'
        const resp = await fetch(base + '/models', {
          headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey },
          signal: AbortSignal.timeout(15000),
        })
        if (!resp.ok) throw new Error('HTTP ' + resp.status)
        const data = await resp.json()
        models = (data.data || []).map(m => m.id).filter(Boolean).sort()
      } else if (apiType === 'google-generative-ai') {
        // Google Gemini
        const resp = await fetch(base + '/models?key=' + apiKey, { signal: AbortSignal.timeout(15000) })
        if (!resp.ok) throw new Error('HTTP ' + resp.status)
        const data = await resp.json()
        models = (data.models || []).map(m => (m.name || '').replace('models/', '')).filter(Boolean).sort()
      } else {
        // OpenAI 兼容（大多数服务商）
        const resp = await fetch(base + '/models', {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        })
        if (!resp.ok) throw new Error('HTTP ' + resp.status)
        const data = await resp.json()
        models = (data.data || []).map(m => m.id).filter(Boolean).sort()
      }

      if (models.length === 0) {
        if (resultEl) resultEl.innerHTML = `<span style="color:var(--warning)">${t('engine.configFetchNotSupported')}</span>`
        return
      }

      if (resultEl) resultEl.innerHTML = `<span style="color:var(--success)">✓ ${t('engine.configFetchSuccess', { count: models.length })}</span>`
      if (dropdown) {
        dropdown.innerHTML = models.map(m =>
          `<div class="hermes-model-option" data-model="${m}" style="padding:6px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border-primary)">${m}</div>`
        ).join('')
        dropdown.style.display = 'block'
      }
    } catch (err) {
      // 网络错误或不支持
      const msg = err.message || String(err)
      if (resultEl) {
        if (msg.includes('403') || msg.includes('404') || msg.includes('405') || msg.includes('timeout') || msg.includes('Failed to fetch')) {
          resultEl.innerHTML = `<span style="color:var(--warning)">${t('engine.configFetchNotSupported')}</span>`
        } else {
          resultEl.innerHTML = `<span style="color:var(--error)">✗ ${t('engine.configFetchFailed', { error: msg })}</span>`
        }
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = t('engine.configFetchModels') }
    }
  }

  // --- 配置保存 ---
  async function doSaveConfig() {
    const baseUrl = el.querySelector('#hm-baseurl')?.value?.trim()
    const apiKey = el.querySelector('#hm-apikey')?.value?.trim()
    const model = el.querySelector('#hm-model')?.value?.trim()
    // 从 baseUrl 推断 provider key
    const matched = HERMES_PROVIDERS.find(p => baseUrl && p.baseUrl === baseUrl)
    const provider = matched?.key || 'openai'

    if (!apiKey) {
      alert('请输入 API Key')
      return
    }
    try {
      await api.configureHermes(provider, apiKey, model, baseUrl)
      phase = 'gateway'
      await refreshHermes()
    } catch (e) {
      alert(`配置保存失败: ${e}`)
    }
  }

  // --- Gateway 启动 ---
  let gwStarting = false
  async function doStartGateway() {
    const btn = el.querySelector('.hermes-gw-start')
    if (btn) { btn.disabled = true; btn.textContent = t('engine.gatewayStarting') }
    gwStarting = true
    try {
      await api.hermesGatewayAction('start')
      await refreshHermes()
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, '')
      // 在 Gateway 阶段显示错误信息
      const errEl = el.querySelector('#hm-gw-error')
      if (errEl) {
        errEl.textContent = msg || t('engine.gatewayStartFailed')
        errEl.style.display = 'block'
      } else {
        alert(msg || t('engine.gatewayStartFailed'))
      }
    } finally {
      gwStarting = false
      if (btn) { btn.disabled = false; btn.textContent = t('engine.gatewayStartBtn') }
    }
  }

  // --- 刷新 hermes 状态 ---
  async function refreshHermes() {
    invalidate('check_hermes')
    try { hermesInfo = await api.checkHermes() } catch (_) {}
    // 已安装且 Gateway 在运行 → 更新引擎状态并跳转仪表盘
    if (hermesInfo?.installed && hermesInfo?.gatewayRunning) {
      phase = 'complete'
      const engine = getActiveEngine()
      if (engine?.detect) await engine.detect()
      window.location.hash = '#/h/dashboard'
      return
    }
    draw()
  }

  // 启动检测
  detect()

  return el
}
