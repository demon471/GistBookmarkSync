/* eslint-disable no-console */
declare const chrome: any

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

function sendThemeUpdate(theme: 'dark' | 'light', retries = 3) {
  console.log('[GistBookmarkSync] Offscreen sending theme:', theme, 'retries left:', retries)
  try {
    chrome.runtime.sendMessage({
      action: 'update-icon',
      theme,
    }, (response: unknown) => {
      if (chrome.runtime.lastError) {
        console.warn('[GistBookmarkSync] Offscreen message error:', chrome.runtime.lastError.message)
        if (retries > 0) {
          setTimeout(() => sendThemeUpdate(theme, retries - 1), 500)
        }
      }
      else {
        console.log('[GistBookmarkSync] Offscreen message sent successfully, response:', response)
      }
    })
  }
  catch (err) {
    console.error('[GistBookmarkSync] Offscreen failed to send message:', err)
    if (retries > 0) {
      setTimeout(() => sendThemeUpdate(theme, retries - 1), 500)
    }
  }
}

const updateIcon = (e: MediaQueryListEvent | MediaQueryList) => {
  const theme = e.matches ? 'dark' : 'light'
  console.log('[GistBookmarkSync] Offscreen theme changed:', theme)
  sendThemeUpdate(theme)
}

// 延迟初始化，确保 service worker 已准备好
setTimeout(() => {
  updateIcon(mediaQuery)
}, 100)

// 也在扩展启动后再次发送，以确保状态同步
setTimeout(() => {
  updateIcon(mediaQuery)
}, 1000)

mediaQuery.addEventListener('change', updateIcon)
