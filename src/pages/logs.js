/**
 * 日志查看页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

const LOG_TABS = [
  { key: 'gateway', label: 'Gateway' },
  { key: 'gateway-err', label: 'Gateway Err' },
  { key: 'guardian', label: 'Guardian' },
  { key: 'guardian-backup', label: 'Backup' },
  { key: 'config-audit', label: '审计日志' },
]

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">日志查看</h1>
      <p class="page-desc">查看 OpenClaw 各服务日志</p>
    </div>
    <div class="tab-bar">
      ${LOG_TABS.map((t, i) => `<div class="tab${i === 0 ? ' active' : ''}" data-tab="${t.key}">${t.label}</div>`).join('')}
    </div>
    <div class="log-toolbar">
      <input type="text" class="form-input" id="log-search" placeholder="搜索日志..." style="max-width:300px">
      <button class="btn btn-secondary btn-sm" id="btn-refresh">刷新</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:var(--font-size-sm);color:var(--text-secondary)">
        <input type="checkbox" id="log-autoscroll" checked> 自动滚动
      </label>
    </div>
    <div class="log-viewer" id="log-content" style="height:calc(100vh - 280px)">加载中...</div>
  `

  let currentTab = 'gateway'

  // Tab 切换
  page.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      page.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      currentTab = tab.dataset.tab
      page.querySelector('#log-search').value = ''
      loadLog(page, currentTab)
    }
  })

  // 搜索
  let searchTimer = null
  page.querySelector('#log-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      if (e.target.value.trim()) {
        searchLog(page, currentTab, e.target.value.trim())
      } else {
        loadLog(page, currentTab)
      }
    }, 300)
  })

  // 刷新
  page.querySelector('#btn-refresh').onclick = () => loadLog(page, currentTab)

  loadLog(page, currentTab)
  return page
}

async function loadLog(page, logName) {
  const el = page.querySelector('#log-content')
  el.innerHTML = '<div style="color:var(--text-tertiary)">加载中...</div>'
  try {
    const content = await api.readLogTail(logName, 200)
    if (!content || !content.trim()) {
      el.innerHTML = '<div style="color:var(--text-tertiary)">暂无日志</div>'
      return
    }
    const lines = content.trim().split('\n')
    el.innerHTML = lines.map(l => `<div class="log-line">${escapeHtml(l)}</div>`).join('')
    if (page.querySelector('#log-autoscroll')?.checked) {
      el.scrollTop = el.scrollHeight
    }
  } catch (e) {
    toast('加载日志失败: ' + e, 'error')
  }
}

async function searchLog(page, logName, query) {
  const el = page.querySelector('#log-content')
  el.innerHTML = '<div style="color:var(--text-tertiary)">搜索中...</div>'
  try {
    const results = await api.searchLog(logName, query)
    if (!results || !results.length) {
      el.innerHTML = '<div style="color:var(--text-tertiary)">未找到匹配结果</div>'
      return
    }
    el.innerHTML = results.map(l => `<div class="log-line">${highlightMatch(escapeHtml(l), query)}</div>`).join('')
  } catch (e) {
    toast('搜索失败: ' + e, 'error')
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightMatch(html, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.replace(new RegExp(escaped, 'gi'), m => `<mark>${m}</mark>`)
}
