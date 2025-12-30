import { onMessage, sendMessage } from 'webext-bridge/background'
import type { Tabs } from 'webextension-polyfill'

// only on dev mode
if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import('/@vite/client')
  // load latest content script
  import('./contentScriptHMR')
}

// remove or turn this off if you don't use side panel
const USE_SIDE_PANEL = true

// to toggle the sidepanel with the action button in chromium:
if (USE_SIDE_PANEL) {
  // @ts-expect-error missing types
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error(error))
}

browser.runtime.onInstalled.addListener((): void => {
  // eslint-disable-next-line no-console
  console.log('Extension installed')
})

let previousTabId = 0

// communication example: send previous tab title from background page
// see shim.d.ts for type declaration
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!previousTabId) {
    previousTabId = tabId
    return
  }

  let tab: Tabs.Tab

  try {
    tab = await browser.tabs.get(previousTabId)
    previousTabId = tabId
  }
  catch {
    return
  }

  // eslint-disable-next-line no-console
  console.log('previous tab', tab)
  sendMessage('tab-prev', { title: tab.title }, { context: 'content-script', tabId })
})

onMessage('get-current-tab', async () => {
  try {
    const tab = await browser.tabs.get(previousTabId)
    return {
      title: tab?.title,
    }
  }
  catch {
    return {
      title: undefined,
    }
  }
})

onMessage('validate-gist-auth', async ({ data }) => {
  const token = data?.token?.trim()
  const gistId = data?.gistId?.trim()
  const fileName = data?.fileName?.trim()
  const autoCreate = data?.autoCreate ?? false
  const errors: string[] = []

  if (!token)
    errors.push('GitHub Token is required')
  if (!gistId)
    errors.push('Gist ID is required')
  if (!fileName)
    errors.push('Gist file name is required')

  if (errors.length > 0)
    return { ok: false, errors }

  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `token ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (response.status === 401)
    return { ok: false, errors: ['GitHub Token is invalid or expired'] }
  if (response.status === 403)
    return { ok: false, errors: ['GitHub API access denied or rate limited'] }
  if (response.status === 404)
    return { ok: false, errors: ['Gist not found or no access'] }
  if (!response.ok)
    return { ok: false, errors: ['Validation failed, please try again'] }

  const gist = await response.json() as { files?: Record<string, unknown>, description?: string, owner?: { login?: string } }
  const fileNames = Object.keys(gist.files || {})

  if (!gist.files || !gist.files[fileName]) {
    if (!autoCreate)
      return { ok: false, errors: ['Gist file name not found'] }

    const createResponse = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        files: {
          [fileName]: {
            content: '{\"version\":1,\"bookmarks\":[]}\n',
          },
        },
      }),
    })

    if (!createResponse.ok)
      return { ok: false, errors: ['Failed to create Gist file'] }

    const createdGist = await createResponse.json() as { files?: Record<string, unknown>, description?: string, owner?: { login?: string } }
    const createdFiles = Object.keys(createdGist.files || {})

    return {
      ok: true,
      created: true,
      gist: {
        id: gistId,
        owner: createdGist.owner?.login,
        description: createdGist.description,
        files: createdFiles,
      },
    }
  }

  return {
    ok: true,
    created: false,
    gist: {
      id: gistId,
      owner: gist.owner?.login,
      description: gist.description,
      files: fileNames,
    },
  }
})
