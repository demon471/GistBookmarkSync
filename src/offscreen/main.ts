/* eslint-disable no-console */

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

const updateIcon = (e: MediaQueryListEvent | MediaQueryList) => {
  const theme = e.matches ? 'dark' : 'light'
  console.log('[GistBookmarkSync] Offscreen theme changed:', theme)
  try {
    chrome.runtime.sendMessage({
      action: 'update-icon',
      theme,
    })
    console.log('[GistBookmarkSync] Offscreen sent update-icon message')
  }
  catch (err) {
    console.error('[GistBookmarkSync] Offscreen failed to send message:', err)
  }
}

updateIcon(mediaQuery)
mediaQuery.addEventListener('change', updateIcon)
