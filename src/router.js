/**
 * 极简 hash 路由
 */
const routes = {}
let _contentEl = null
let _loadId = 0
let _currentCleanup = null

export function registerRoute(path, loader) {
  routes[path] = loader
}

export function navigate(path) {
  window.location.hash = path
}

export function initRouter(contentEl) {
  _contentEl = contentEl
  window.addEventListener('hashchange', () => loadRoute())
  loadRoute()
}

async function loadRoute() {
  const hash = window.location.hash.slice(1) || '/dashboard'
  const loader = routes[hash]
  if (!loader || !_contentEl) return

  // 竞态防护：记录本次加载 ID
  const thisLoad = ++_loadId

  // 清理上一个页面
  if (_currentCleanup) {
    try { _currentCleanup() } catch (_) {}
    _currentCleanup = null
  }

  _contentEl.innerHTML = ''
  const mod = await loader()

  // 如果加载期间路由又变了，丢弃本次结果
  if (thisLoad !== _loadId) return

  const page = mod.render ? await mod.render() : mod.default ? await mod.default() : mod
  if (thisLoad !== _loadId) return

  if (typeof page === 'string') {
    _contentEl.innerHTML = page
  } else if (page instanceof HTMLElement) {
    _contentEl.appendChild(page)
  }

  // 保存页面清理函数
  _currentCleanup = mod.cleanup || null

  // 更新侧边栏激活状态
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.route === hash)
  })
}

export function getCurrentRoute() {
  return window.location.hash.slice(1) || '/dashboard'
}
