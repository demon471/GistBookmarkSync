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
const sidePanelOpenByTab = new Map<number, boolean>()

type SyncNode = {
  title: string
  url?: string
  children?: SyncNode[]
}

type LocalFolderInfo = {
  id: string
  bookmarkUrls: Set<string>
  folderTitles: Set<string>
}

type FolderNode = {
  id: string
  title: string
  count: number
  children: FolderNode[]
}

type GistLoadResult =
  | { ok: true, gistNodes: SyncNode[], raw: { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] } }
  | { ok: false, error: string }

type WebDavLoadResult =
  | { ok: true, nodes: SyncNode[], raw: { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] } }
  | { ok: false, error: string }

function normalizeTitle(title?: string) {
  return (title || '').trim()
}

function toSyncNodes(nodes?: browser.bookmarks.BookmarkTreeNode[]): SyncNode[] {
  if (!nodes)
    return []
  return nodes.map((node) => {
    if (node.url)
      return { title: node.title || node.url, url: node.url }

    const children = toSyncNodes(node.children)
    return { title: node.title || 'Untitled', children }
  })
}

function filterLocalNodes(
  nodes: browser.bookmarks.BookmarkTreeNode[],
  selectedIds: Set<string>,
): SyncNode[] {
  const result: SyncNode[] = []

  for (const node of nodes) {
    // 书签：检查父文件夹是否被选中（书签没有自己的 ID 在 selectedIds 中）
    // 书签的包含由其所在文件夹决定，这里我们在文件夹层面处理
    if (node.url) {
      // 书签直接添加（因为我们只会在选中的文件夹内递归调用此函数）
      result.push({ title: node.title || node.url, url: node.url })
      continue
    }

    // 文件夹：检查是否被选中
    if (!selectedIds.has(node.id)) {
      // 文件夹未选中，跳过它及其所有内容
      continue
    }

    // 文件夹被选中，递归处理子节点
    const children = filterLocalNodes(node.children || [], selectedIds)
    result.push({
      title: node.title || 'Untitled',
      children,
    })
  }

  return result
}

function sanitizeNodes(input: unknown): SyncNode[] {
  if (!Array.isArray(input))
    return []

  const nodes: SyncNode[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object')
      continue

    const record = item as { title?: unknown, url?: unknown, children?: unknown }
    const title = typeof record.title === 'string'
      ? record.title
      : (typeof record.url === 'string' ? record.url : 'Untitled')

    if (typeof record.url === 'string') {
      nodes.push({ title, url: record.url })
      continue
    }

    nodes.push({ title, children: sanitizeNodes(record.children) })
  }

  return nodes
}

function buildFolderTree(node: browser.bookmarks.BookmarkTreeNode): { folder?: FolderNode, count: number } {
  if (node.url)
    return { count: 1 }

  const children: FolderNode[] = []
  let count = 0
  for (const child of node.children || []) {
    const childResult = buildFolderTree(child)
    count += childResult.count
    if (childResult.folder)
      children.push(childResult.folder)
  }

  return {
    count,
    folder: {
      id: node.id,
      title: node.title || 'Untitled',
      count,
      children,
    },
  }
}

async function loadGistBookmarks(token: string, gistId: string, fileName: string): Promise<GistLoadResult> {
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `token ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (response.status === 401)
    return { ok: false, error: 'GitHub Token is invalid or expired' }
  if (response.status === 403)
    return { ok: false, error: 'GitHub API access denied or rate limited' }
  if (response.status === 404)
    return { ok: false, error: 'Gist not found or no access' }
  if (!response.ok)
    return { ok: false, error: 'Sync failed, please try again' }

  const gist = await response.json() as {
    files?: Record<string, { content?: string, truncated?: boolean, raw_url?: string }>
  }
  const file = gist.files?.[fileName]
  if (!file)
    return { ok: false, error: 'Gist file name not found' }

  let content = file.content ?? ''
  if (file.truncated && file.raw_url) {
    const rawResponse = await fetch(file.raw_url, {
      headers: {
        Authorization: `token ${token}`,
      },
    })
    if (!rawResponse.ok)
      return { ok: false, error: 'Failed to fetch full Gist content' }
    content = await rawResponse.text()
  }

  let parsed: { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] }
  try {
    parsed = JSON.parse(content) as { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] }
  }
  catch {
    return { ok: false, error: 'Gist file is not valid JSON' }
  }

  if (!Array.isArray(parsed.bookmarks))
    return { ok: false, error: 'Gist file missing bookmarks array' }

  const gistNodes = sanitizeNodes(parsed.bookmarks)
  return { ok: true, gistNodes, raw: parsed }
}

async function loadLocalNodes(selectedFolderIds?: string[]) {
  const localTree = await browser.bookmarks.getTree()
  const root = localTree[0]
  if (!root)
    return { ok: false as const, error: 'Failed to read local bookmarks' }

  const selectedSet = new Set(selectedFolderIds || [])

  // eslint-disable-next-line no-console
  console.log('[GistSync] loadLocalNodes - selectedSet size:', selectedSet.size, 'ids:', Array.from(selectedSet))

  // 如果没有选择任何文件夹，返回所有书签
  if (selectedSet.size === 0) {
    // eslint-disable-next-line no-console
    console.log('[GistSync] No folder selection, returning all bookmarks')
    return { ok: true as const, root, localNodes: toSyncNodes(root.children) }
  }

  // 有选择的文件夹，进行过滤
  const localNodes = filterLocalNodes(root.children || [], selectedSet)

  // eslint-disable-next-line no-console
  console.log('[GistSync] Filtered localNodes:', JSON.stringify(localNodes, null, 2))

  // 如果过滤后为空（可能是选择状态异常），返回所有书签
  if (localNodes.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[GistSync] Filtered result is empty, returning all bookmarks')
    return { ok: true as const, root, localNodes: toSyncNodes(root.children) }
  }

  return { ok: true as const, root, localNodes }
}

function buildBookmarkPayload(nodes: SyncNode[]) {
  return {
    browser: navigator.userAgent,
    version: browser.runtime.getManifest().version,
    createDate: Date.now(),
    bookmarks: nodes,
  }
}

function buildWebDavFileUrl(baseUrl: string, filePath?: string) {
  const normalizedBase = baseUrl.trim()
  const normalizedPath = (filePath || '').trim()
  if (!normalizedPath)
    return normalizedBase
  if (normalizedBase.endsWith('/') && normalizedPath.startsWith('/'))
    return `${normalizedBase}${normalizedPath.slice(1)}`
  if (!normalizedBase.endsWith('/') && !normalizedPath.startsWith('/'))
    return `${normalizedBase}/${normalizedPath}`
  return `${normalizedBase}${normalizedPath}`
}

function resolveWebDavFilePath(filePath?: string) {
  const normalized = (filePath || '').trim()
  return normalized || 'gist-bookmark-sync/bookmarks.json'
}

function buildWebDavAuthHeaders(username?: string, password?: string) {
  if (!username && !password)
    return {}
  const token = btoa(`${username || ''}:${password || ''}`)
  return {
    Authorization: `Basic ${token}`,
  }
}

function getWebDavDirectorySegments(filePath: string) {
  const normalized = filePath.replace(/^\/+/, '').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1)
    return []
  return parts.slice(0, -1)
}

async function probeWebDavPath(url: string, username?: string, password?: string) {
  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Depth: '0',
      ...buildWebDavAuthHeaders(username, password),
    },
  })
  return response
}

async function ensureWebDavDirectory(url: string, username?: string, password?: string) {
  let response = await probeWebDavPath(url, username, password)

  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }

  if (response.status === 404) {
    response = await fetch(url, {
      method: 'MKCOL',
      headers: {
        ...buildWebDavAuthHeaders(username, password),
      },
    })

    if (response.status === 401 || response.status === 403)
      return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }

    if (!response.ok && response.status !== 405)
      return { ok: false, error: 'WebDAV 目录创建失败，请检查权限' }

    return { ok: true }
  }

  if (!response.ok && response.status !== 207)
    return { ok: false, error: 'WebDAV 目录校验失败，请检查地址配置' }

  return { ok: true }
}

async function ensureWebDavDirectories(baseUrl: string, filePath: string, username?: string, password?: string) {
  const segments = getWebDavDirectorySegments(filePath)
  if (segments.length === 0)
    return { ok: true }

  let currentPath = ''
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment
    const dirUrl = buildWebDavFileUrl(baseUrl, `${currentPath}/`)
    const result = await ensureWebDavDirectory(dirUrl, username, password)
    if (!result.ok)
      return result
  }

  return { ok: true }
}

async function loadWebDavBookmarks(url: string, username?: string, password?: string): Promise<WebDavLoadResult> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...buildWebDavAuthHeaders(username, password),
    },
  })

  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }
  if (response.status === 404)
    return { ok: false, error: 'WebDAV 文件不存在，请先推送一次' }
  if (!response.ok)
    return { ok: false, error: 'WebDAV 拉取失败，请检查地址配置' }

  const content = await response.text()
  let parsed: { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] }
  try {
    parsed = JSON.parse(content) as { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] }
  }
  catch {
    return { ok: false, error: 'WebDAV 文件不是有效的 JSON' }
  }

  if (!Array.isArray(parsed.bookmarks))
    return { ok: false, error: 'WebDAV 文件缺少 bookmarks 数组' }

  const nodes = sanitizeNodes(parsed.bookmarks)
  return { ok: true, nodes, raw: parsed }
}

async function updateWebDavFile(url: string, username: string | undefined, password: string | undefined, nodes: SyncNode[]) {
  const payload = buildBookmarkPayload(nodes)
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...buildWebDavAuthHeaders(username, password),
    },
    body: `${JSON.stringify(payload)}\n`,
  })

  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }
  if (response.status === 404)
    return { ok: false, error: 'WebDAV 路径不存在，请检查目录' }
  if (!response.ok)
    return { ok: false, error: 'WebDAV 推送失败，请检查地址配置' }

  return { ok: true }
}

async function updateGistFile(token: string, gistId: string, fileName: string, nodes: SyncNode[]) {
  const payload = buildBookmarkPayload(nodes)
  const updateResponse = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `token ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      files: {
        [fileName]: {
          content: `${JSON.stringify(payload)}\n`,
        },
      },
    }),
  })

  return updateResponse.ok
}

function mergeNodeLists(localNodes: SyncNode[], gistNodes: SyncNode[]) {
  const result: SyncNode[] = []
  const index = new Map<string, SyncNode>()

  for (const node of localNodes) {
    const key = node.url ? `url:${node.url}` : `folder:${normalizeTitle(node.title)}`
    index.set(key, node)
    result.push(node)
  }

  for (const node of gistNodes) {
    const key = node.url ? `url:${node.url}` : `folder:${normalizeTitle(node.title)}`
    const existing = index.get(key)
    if (!existing) {
      result.push(node)
      continue
    }

    if (!node.url && !existing.url) {
      existing.children = mergeNodeLists(existing.children || [], node.children || [])
    }
  }

  return result
}

function countBookmarks(nodes: SyncNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.url)
      count += 1
    if (node.children)
      count += countBookmarks(node.children)
  }
  return count
}

async function buildLocalIndex(root: browser.bookmarks.BookmarkTreeNode) {
  const index = new Map<string, LocalFolderInfo>()
  const rootPath = ''

  function ensureFolder(path: string, id: string) {
    if (!index.has(path)) {
      index.set(path, {
        id,
        bookmarkUrls: new Set(),
        folderTitles: new Set(),
      })
    }
  }

  function walk(node: browser.bookmarks.BookmarkTreeNode, currentPath: string) {
    if (node.url) {
      const folder = index.get(currentPath)
      folder?.bookmarkUrls.add(node.url)
      return
    }

    const title = normalizeTitle(node.title)
    const path = currentPath ? `${currentPath}/${title}` : title
    ensureFolder(path, node.id)

    const parentFolder = index.get(currentPath)
    if (parentFolder && title)
      parentFolder.folderTitles.add(title)

    for (const child of node.children || [])
      walk(child, path)
  }

  ensureFolder(rootPath, root.id)
  for (const child of root.children || [])
    walk(child, rootPath)

  return index
}

async function ensureLocalEntries(rootId: string, index: Map<string, LocalFolderInfo>, nodes: SyncNode[]) {
  async function ensureFolder(path: string, title: string, parentId: string) {
    const normalizedTitle = normalizeTitle(title)
    const nextPath = path ? `${path}/${normalizedTitle}` : normalizedTitle
    const existing = index.get(nextPath)
    if (existing)
      return { path: nextPath, info: existing }

    const created = await browser.bookmarks.create({ parentId, title: normalizedTitle || 'Untitled' })
    const info = {
      id: created.id,
      bookmarkUrls: new Set<string>(),
      folderTitles: new Set<string>(),
    }
    index.set(nextPath, info)
    const parent = index.get(path)
    if (parent)
      parent.folderTitles.add(normalizedTitle)
    return { path: nextPath, info }
  }

  async function walk(list: SyncNode[], currentPath: string, parentId: string) {
    const folderInfo = index.get(currentPath)
    const existingUrls = folderInfo?.bookmarkUrls || new Set<string>()

    for (const node of list) {
      if (node.url) {
        if (!existingUrls.has(node.url)) {
          await browser.bookmarks.create({
            parentId,
            title: node.title || node.url,
            url: node.url,
          })
          existingUrls.add(node.url)
        }
        continue
      }

      const ensured = await ensureFolder(currentPath, node.title, parentId)
      await walk(node.children || [], ensured.path, ensured.info.id)
    }
  }

  await walk(nodes, '', rootId)
}

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
  const createIfMissing = data?.createIfMissing ?? false
  const errors: string[] = []

  if (!token)
    errors.push('GitHub Token is required')
  if (!gistId && !createIfMissing)
    errors.push('Gist ID is required')
  if (!fileName)
    errors.push('Gist file name is required')

  if (errors.length > 0)
    return { ok: false, errors }

  async function createNewGist() {
    const createResponse = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        description: 'GistBookmarkSync',
        public: false,
        files: {
          [fileName]: {
            content: `${JSON.stringify(buildBookmarkPayload([]))}\n`,
          },
        },
      }),
    })

    if (!createResponse.ok)
      return { ok: false, errors: ['Failed to create new Gist'] }

    const created = await createResponse.json() as { id?: string, files?: Record<string, unknown>, description?: string, owner?: { login?: string } }
    const createdFiles = Object.keys(created.files || {})

    if (!created.id)
      return { ok: false, errors: ['Gist created but missing ID'] }

    return {
      ok: true,
      createdGist: true,
      gist: {
        id: created.id,
        owner: created.owner?.login,
        description: created.description,
        files: createdFiles,
      },
    }
  }

  if (!gistId && createIfMissing)
    return await createNewGist()

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
  if (response.status === 404) {
    if (createIfMissing)
      return await createNewGist()
    return { ok: false, errors: ['Gist not found or no access'] }
  }
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
            content: `${JSON.stringify(buildBookmarkPayload([]))}\n`,
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
      createdFile: true,
      createdGist: false,
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
    createdFile: false,
    createdGist: false,
    gist: {
      id: gistId,
      owner: gist.owner?.login,
      description: gist.description,
      files: fileNames,
    },
  }
})

onMessage('validate-webdav-auth', async ({ data }) => {
  const baseUrl = data?.url?.trim()
  const rawFilePath = ''
  const username = data?.username as string | undefined
  const password = data?.password as string | undefined
  const errors: string[] = []

  if (!baseUrl)
    errors.push('WebDAV 地址不能为空')

  if (errors.length > 0)
    return { ok: false, errors }

  const filePath = resolveWebDavFilePath(rawFilePath)

  if (filePath) {
    const ensureResult = await ensureWebDavDirectories(baseUrl, filePath, username, password)
    if (!ensureResult.ok)
      return { ok: false, errors: [ensureResult.error || 'WebDAV 目录校验失败'] }
  }

  const fileUrl = buildWebDavFileUrl(baseUrl, filePath)

  try {
    const response = await fetch(fileUrl, {
      method: 'GET',
      headers: {
        ...buildWebDavAuthHeaders(username, password),
      },
    })

    if (response.status === 401 || response.status === 403)
      return { ok: false, errors: ['WebDAV 认证失败，请检查账号或密码'] }

    if (response.status === 404)
      return { ok: true, missing: true }

    if (!response.ok)
      return { ok: false, errors: ['WebDAV 连接失败，请检查地址配置'] }

    return { ok: true, missing: false }
  }
  catch {
    return { ok: false, errors: ['WebDAV 连接失败，请检查地址配置'] }
  }
})

onMessage('get-bookmark-folders', async () => {
  const tree = await browser.bookmarks.getTree()
  const root = tree[0]
  if (!root)
    return { ok: false, error: 'Failed to load bookmarks' }

  const folders: FolderNode[] = []
  for (const child of root.children || []) {
    const built = buildFolderTree(child)
    if (built.folder)
      folders.push(built.folder)
  }

  return {
    ok: true,
    tree: folders,
  }
})

async function performSync(mode: 'upload' | 'download') {
  const stored = await browser.storage.local.get([
    'sync-provider',
    'github-token',
    'gist-id',
    'gist-file-name',
    'sync-direction',
    'sync-conflict-strategy',
    'sync-folder-selection',
    'webdav-url',
    'webdav-username',
    'webdav-password',
  ])
  const provider = (stored['sync-provider'] as string | undefined) || 'gist'
  const token = (stored['github-token'] as string | undefined)?.trim()
  const gistId = (stored['gist-id'] as string | undefined)?.trim()
  const fileName = (stored['gist-file-name'] as string | undefined)?.trim()
  const syncDirection = (stored['sync-direction'] as string | undefined) || 'pull'
  const conflictStrategy = (stored['sync-conflict-strategy'] as string | undefined) || 'gist-wins'

  // sync-folder-selection 可能是字符串（JSON）或数组，需要正确解析
  let selectedFolderIds: string[] | undefined
  const rawSelection = stored['sync-folder-selection']
  if (typeof rawSelection === 'string') {
    try {
      selectedFolderIds = JSON.parse(rawSelection)
    }
    catch {
      selectedFolderIds = undefined
    }
  }
  else if (Array.isArray(rawSelection)) {
    selectedFolderIds = rawSelection
  }

  // eslint-disable-next-line no-console
  console.log('[GistSync] selectedFolderIds from storage:', selectedFolderIds)

  if (provider === 'webdav') {
    const baseUrl = (stored['webdav-url'] as string | undefined)?.trim()
    const username = (stored['webdav-username'] as string | undefined) || ''
    const password = (stored['webdav-password'] as string | undefined) || ''

    if (!baseUrl) {
      await browser.storage.local.set({
        'webdav-connection-status': 'error',
        'webdav-last-validation-time': Date.now(),
      })
      return {
        ok: false,
        error: '请先配置 WebDAV 地址',
      }
    }

    const filePath = resolveWebDavFilePath('')
    const fileUrl = buildWebDavFileUrl(baseUrl, filePath)

    const localResult = await loadLocalNodes(selectedFolderIds)
    if (!localResult.ok)
      return { ok: false, error: localResult.error }

    const { root, localNodes } = localResult

    if (mode === 'upload') {
      const ensureResult = await ensureWebDavDirectories(baseUrl, filePath, username, password)
      if (!ensureResult.ok) {
        await browser.storage.local.set({
          'webdav-connection-status': 'error',
          'webdav-last-validation-time': Date.now(),
        })
        return { ok: false, error: ensureResult.error }
      }

      const updated = await updateWebDavFile(fileUrl, username, password, localNodes)
      if (!updated.ok) {
        await browser.storage.local.set({
          'webdav-connection-status': 'error',
          'webdav-last-validation-time': Date.now(),
        })
        return { ok: false, error: updated.error }
      }

      const localCount = countBookmarks(localNodes)
      const summary = `推送成功 ${localCount} 条书签`
      const timestamp = new Date().toISOString()

      await browser.storage.local.set({
        'webdav-connection-status': 'ok',
        'webdav-last-validation-time': Date.now(),
        'webdav-last-sync': timestamp,
        'webdav-last-sync-summary': summary,
        'webdav-last-sync-folders': selectedFolderIds || [],
      })

      return {
        ok: true,
        summary,
        timestamp,
      }
    }

    const webdavResult = await loadWebDavBookmarks(fileUrl, username, password)
    if (!webdavResult.ok) {
      await browser.storage.local.set({
        'webdav-connection-status': 'error',
        'webdav-last-validation-time': Date.now(),
      })
      return { ok: false, error: webdavResult.error }
    }

    await browser.storage.local.set({
      'webdav-connection-status': 'ok',
      'webdav-last-validation-time': Date.now(),
    })

    const mergedNodes = mergeNodeLists(localNodes, webdavResult.nodes)

    const index = await buildLocalIndex(root)
    await ensureLocalEntries(root.id, index, mergedNodes)

    const webdavCount = countBookmarks(webdavResult.nodes)
    const localCount = countBookmarks(localNodes)
    const mergedCount = countBookmarks(mergedNodes)
    const summary = `拉取成功 ${mergedCount} 条书签 (云端 ${webdavCount}, 本地 ${localCount})`
    const timestamp = new Date().toISOString()

    await browser.storage.local.set({
      'webdav-last-sync': timestamp,
      'webdav-last-sync-summary': summary,
      'webdav-last-sync-folders': selectedFolderIds || [],
    })

    return {
      ok: true,
      summary,
      timestamp,
    }
  }

  if (!token || !gistId || !fileName) {
    // 更新连接状态为错误
    await browser.storage.local.set({
      'connection-status': 'error',
      'last-validation-time': Date.now(),
    })
    return {
      ok: false,
      error: '请先配置 GitHub Token、Gist ID 和文件名',
    }
  }

  const gistResult = await loadGistBookmarks(token, gistId, fileName)
  if (!gistResult.ok) {
    // 更新连接状态为错误
    await browser.storage.local.set({
      'connection-status': 'error',
      'last-validation-time': Date.now(),
    })
    return { ok: false, error: gistResult.error }
  }

  // 连接成功，更新状态
  await browser.storage.local.set({
    'connection-status': 'ok',
    'last-validation-time': Date.now(),
  })

  const localResult = await loadLocalNodes(selectedFolderIds)
  if (!localResult.ok)
    return { ok: false, error: localResult.error }

  const { root, localNodes } = localResult

  if (mode === 'upload') {
    // 上传模式：只上传选中的本地书签到云端
    const updated = await updateGistFile(token, gistId, fileName, localNodes)
    if (!updated)
      return { ok: false, error: 'Failed to update Gist' }

    const localCount = countBookmarks(localNodes)
    const summary = `推送成功 ${localCount} 条书签`
    const timestamp = new Date().toISOString()

    await browser.storage.local.set({
      'gist-bookmarks-cache': { version: 1, bookmarks: localNodes },
      'gist-last-sync': timestamp,
      'gist-last-sync-summary': summary,
      'gist-last-sync-direction': syncDirection,
      'gist-last-sync-strategy': conflictStrategy,
      'gist-last-sync-folders': selectedFolderIds || [],
    })

    return {
      ok: true,
      summary,
      timestamp,
    }
  }

  // 下载模式：合并云端和本地书签
  const mergedNodes = mergeNodeLists(localNodes, gistResult.gistNodes)

  const index = await buildLocalIndex(root)
  await ensureLocalEntries(root.id, index, mergedNodes)

  const gistCount = countBookmarks(gistResult.gistNodes)
  const localCount = countBookmarks(localNodes)
  const mergedCount = countBookmarks(mergedNodes)
  const summary = `拉取成功 ${mergedCount} 条书签 (云端 ${gistCount}, 本地 ${localCount})`
  const timestamp = new Date().toISOString()

  await browser.storage.local.set({
    'gist-bookmarks-cache': { version: 1, bookmarks: mergedNodes },
    'gist-last-sync': timestamp,
    'gist-last-sync-summary': summary,
    'gist-last-sync-direction': syncDirection,
    'gist-last-sync-strategy': conflictStrategy,
    'gist-last-sync-folders': selectedFolderIds || [],
  })

  return {
    ok: true,
    summary,
    timestamp,
  }
}

onMessage('sync-upload', async () => {
  return await performSync('upload')
})

onMessage('sync-download', async () => {
  return await performSync('download')
})

onMessage('sync-now', async () => {
  return await performSync('upload')
})

onMessage('open-sidepanel', ({ sender }) => {
  try {
    const tabId = sender?.tabId ?? sender?.tab?.id
    if (!tabId)
      return { ok: false, error: 'No tab id from sender' }

    // @ts-expect-error sidePanel is not typed in polyfill
    if (!browser.sidePanel?.open)
      return { ok: false, error: 'Side panel not supported' }

    const isOpen = sidePanelOpenByTab.get(tabId) ?? false
    if (isOpen) {
      // @ts-expect-error sidePanel is not typed in polyfill
      if (browser.sidePanel?.close) {
        // @ts-expect-error sidePanel is not typed in polyfill
        void browser.sidePanel.close({ tabId })
      }
      else {
        // @ts-expect-error sidePanel is not typed in polyfill
        void browser.sidePanel.setOptions?.({ tabId, enabled: false })
      }
      sidePanelOpenByTab.set(tabId, false)
      return { ok: true }
    }

    // Fire immediately to preserve the user-gesture chain.
    // @ts-expect-error sidePanel is not typed in polyfill
    void browser.sidePanel.setOptions?.({ tabId, path: 'dist/sidepanel/index.html', enabled: true })
    // @ts-expect-error sidePanel is not typed in polyfill
    void browser.sidePanel.open({ tabId })
    sidePanelOpenByTab.set(tabId, true)
    return { ok: true }
  }
  catch {
    return { ok: false, error: 'Failed to open side panel' }
  }
})

onMessage('sidepanel-visibility', ({ sender, data }) => {
  const tabId = (data as { tabId?: number } | undefined)?.tabId ?? sender?.tabId ?? sender?.tab?.id
  if (!tabId)
    return { ok: false, error: 'No tab id from sender' }

  sidePanelOpenByTab.set(tabId, Boolean((data as { open?: boolean } | undefined)?.open))
  return { ok: true }
})

onMessage('clear-bookmarks', async () => {
  try {
    const tree = await browser.bookmarks.getTree()
    const root = tree[0]
    if (!root)
      return { ok: false, success: false, error: 'Failed to read bookmarks' }

    // 递归删除所有书签和文件夹（保留根节点的直接子文件夹如"书签栏"、"其他书签"）
    async function clearFolder(node: browser.bookmarks.BookmarkTreeNode) {
      if (!node.children)
        return

      for (const child of node.children) {
        if (child.url) {
          // 删除书签
          await browser.bookmarks.remove(child.id)
        }
        else if (child.children) {
          // 递归清空子文件夹内容
          await clearFolder(child)
          // 如果不是根级文件夹（书签栏、其他书签等），则删除空文件夹
          if (child.parentId !== root.id) {
            await browser.bookmarks.remove(child.id)
          }
        }
      }
    }

    // 清空每个根级文件夹的内容
    for (const rootFolder of root.children || []) {
      await clearFolder(rootFolder)
    }

    // 清除保存的文件夹选择状态，这样下次下载时会是全选状态
    await browser.storage.local.remove('sync-folder-selection')

    return { ok: true, success: true }
  }
  catch (error) {
    return { ok: false, success: false, error: String(error) }
  }
})

onMessage('export-bookmarks', async ({ data }) => {
  try {
    const includeExcluded = data?.includeExcluded ?? true

    const localTree = await browser.bookmarks.getTree()
    const root = localTree[0]
    if (!root)
      return { ok: false, error: 'Failed to read bookmarks' }

    let bookmarks: SyncNode[]

    if (includeExcluded) {
      // 导出全部书签
      bookmarks = toSyncNodes(root.children)
    }
    else {
      // 只导出选中的书签（排除未选中的）
      const stored = await browser.storage.local.get(['sync-folder-selection'])
      let selectedFolderIds: string[] | undefined
      const rawSelection = stored['sync-folder-selection']
      if (typeof rawSelection === 'string') {
        try {
          selectedFolderIds = JSON.parse(rawSelection)
        }
        catch {
          selectedFolderIds = undefined
        }
      }
      else if (Array.isArray(rawSelection)) {
        selectedFolderIds = rawSelection
      }

      const selectedSet = new Set(selectedFolderIds || [])
      if (selectedSet.size === 0) {
        bookmarks = toSyncNodes(root.children)
      }
      else {
        bookmarks = filterLocalNodes(root.children || [], selectedSet)
      }
    }

    const payload = {
      browser: navigator.userAgent,
      version: browser.runtime.getManifest().version,
      createDate: Date.now(),
      exportType: includeExcluded ? 'full' : 'selected',
      bookmarks,
    }

    return { ok: true, data: payload, count: countBookmarks(bookmarks) }
  }
  catch (error) {
    return { ok: false, error: String(error) }
  }
})

onMessage('import-bookmarks', async ({ data }) => {
  try {
    const bookmarks = data?.bookmarks as SyncNode[] | undefined
    if (!Array.isArray(bookmarks))
      return { ok: false, error: '无效的书签数据' }

    const localTree = await browser.bookmarks.getTree()
    const root = localTree[0]
    if (!root)
      return { ok: false, error: 'Failed to read bookmarks' }

    const index = await buildLocalIndex(root)
    await ensureLocalEntries(root.id, index, bookmarks)

    const count = countBookmarks(bookmarks)
    return { ok: true, count }
  }
  catch (error) {
    return { ok: false, error: String(error) }
  }
})
