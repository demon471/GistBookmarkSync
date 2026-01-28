import { onMessage, sendMessage } from 'webext-bridge/background'
import type { Tabs } from 'webextension-polyfill'
import { compressData, decompressData } from '~/logic/compression'

// only on dev mode
if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import('/@vite/client')
  // load latest content script
  import('./contentScriptHMR')
}

// remove or turn this off if you don't use side panel
const USE_SIDE_PANEL = true

browser.runtime.onInstalled.addListener((): void => {
  if (USE_SIDE_PANEL) {
    // @ts-expect-error missing types
    browser.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch((error: unknown) => console.error(error))
  }
  // eslint-disable-next-line no-console
  console.log('Extension installed')
})

async function ensureOffscreenDocument() {
  // @ts-expect-error offscreen is not typed in chrome types
  const offscreen = chrome.offscreen as {
    hasDocument?: () => Promise<boolean>
    createDocument?: (options: {
      url: string
      reasons: string[]
      justification: string
    }) => Promise<void>
  } | undefined

  if (!offscreen?.createDocument)
    return

  try {
    const hasDoc = await offscreen.hasDocument?.()
    if (hasDoc)
      return

    await offscreen.createDocument({
      url: 'dist/offscreen/index.html',
      reasons: ['MATCH_MEDIA'],
      justification: 'Listen for prefers-color-scheme changes to update the toolbar icon.',
    })
  }
  catch (error) {
    console.error('Failed to create offscreen document:', error)
  }
}

void ensureOffscreenDocument()
chrome.runtime.onStartup?.addListener(() => {
  void ensureOffscreenDocument()
})

function getThemeIconPaths(isDark: boolean) {
  const build = (name: string, size: number) =>
    chrome.runtime.getURL(`assets/${name}-${size}.png`)

  return isDark
    ? {
      16: build('logo-dark', 16),
      32: build('logo-dark', 32),
      48: build('logo-dark', 48),
      128: build('logo-dark', 128),
    }
    : {
      16: build('logo-light', 16),
      32: build('logo-light', 32),
      48: build('logo-light', 48),
      128: build('logo-light', 128),
    }
}

// 监听图标切换请求（跟随系统主题）
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.action === 'update-icon' && message.theme) {
    const isDark = message.theme === 'dark'
    const path = getThemeIconPaths(isDark)

    // @ts-expect-error missing types
    chrome.action.setIcon({ path }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to set icon:', chrome.runtime.lastError.message)
        sendResponse({ ok: false, error: chrome.runtime.lastError.message })
      }
      else {
        sendResponse({ ok: true })
      }
    })
    return true // 保持异步响应通道开启
  }
})

const INITIAL_DOWNLOAD_KEY = 'initial-download-done'

let previousTabId = 0
const sidePanelOpenByTab = new Map<number, boolean>()
let bookmarkEventSuspension = 0
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null
let autoSyncInProgress = false
let autoSyncPending = false
const AUTO_SYNC_ALARM_NAME = 'auto-sync-interval'
const RANDOM_BACKUP_ALARM_NAME = 'random-backup-alarm'

function debugLog(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[GistSync]', ...args)
}

interface SyncNode {
  title: string
  url?: string
  children?: SyncNode[]
}

interface LocalFolderInfo {
  id: string
  bookmarkUrls: Set<string>
  folderTitles: Set<string>
}

interface FolderNode {
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

interface WebDavVersionEntry {
  file: string
  timestamp: string
  count?: number
  seq?: number
}

interface SyncLogEntry {
  id: string
  time: string
  provider: 'gist' | 'webdav'
  mode: 'upload' | 'download' | 'random-backup' | 'concurrent-sync'
  status: 'ok' | 'error'
  summary: string
}

const MAX_SYNC_LOGS = 5
const SYNC_LOG_KEY = 'sync-log'

function isPortClosedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('back/forward cache')
    || message.includes('message channel is closed')
    || message.includes('Could not establish connection')
    || message.includes('Receiving end does not exist')
}

async function safeSendMessage(...args: Parameters<typeof sendMessage>) {
  try {
    await sendMessage(...args)
  }
  catch (error) {
    if (!isPortClosedError(error))
      console.error(error)
  }
}

function parseSyncLogValue(raw: unknown): SyncLogEntry[] {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as SyncLogEntry[]
      return Array.isArray(parsed) ? parsed : []
    }
    catch (error) {
      debugLog('Failed to parse sync log string', error)
      return []
    }
  }
  if (Array.isArray(raw))
    return raw as SyncLogEntry[]
  return []
}

async function normalizeSyncLogs() {
  const stored = await browser.storage.local.get([SYNC_LOG_KEY])
  const existing = parseSyncLogValue(stored[SYNC_LOG_KEY])
  if (existing.length <= MAX_SYNC_LOGS)
    return
  const next = existing.slice(0, MAX_SYNC_LOGS)
  await browser.storage.local.set({ [SYNC_LOG_KEY]: JSON.stringify(next) })
  debugLog('Sync log trimmed', next.length)
}

// Simple mutex to prevent race conditions during log append
let logMutex = Promise.resolve()

async function appendSyncLog(entry: SyncLogEntry) {
  const currentTask = logMutex.then(async () => {
    const stored = await browser.storage.local.get([SYNC_LOG_KEY])
    const existing = parseSyncLogValue(stored[SYNC_LOG_KEY])
    // Deduplicate logic: prevent exact duplicate logs in short timeframe
    if (existing.length > 0) {
      const last = existing[0]
      if (last.time === entry.time && last.summary === entry.summary && last.provider === entry.provider) {
        return
      }
    }
    const next = [entry, ...existing].slice(0, MAX_SYNC_LOGS)
    await browser.storage.local.set({ [SYNC_LOG_KEY]: JSON.stringify(next) })
    debugLog('Sync log appended', entry)
  }).catch(err => {
    console.error('Failed to append log', err)
  })

  logMutex = currentTask
  await currentTask
}

async function finalizeSyncResult(
  provider: 'gist' | 'webdav',
  mode: 'upload' | 'download',
  result: { ok: true, summary?: string, timestamp?: string } | { ok: false, error?: string },
) {
  const entry: SyncLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: 'timestamp' in result && result.timestamp ? result.timestamp : new Date().toISOString(),
    provider,
    mode,
    status: result.ok ? 'ok' : 'error',
    summary: result.ok ? (result.summary || (mode === 'upload' ? '推送成功' : '拉取成功')) : (result.error || '同步失败'),
  }
  await appendSyncLog(entry)
  return result
}

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

/**
 * 在 Restore (下载/合并) 后，因为文件夹 ID 会发生变化，
 * 我们需要刷新选中状态：
 * 1. 保留依然存在的旧选中 ID。
 * 2. 自动选中新出现的 ID (不在旧快照里的 ID)。
 * 3. 更新快照为当前所有 ID。
 */




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
      'Accept': 'application/vnd.github+json',
      'Authorization': `token ${token}`,
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
    parsed = await decompressData(content) as { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] }
  }
  catch (e) {
    debugLog('Gist parse error:', e)
    return { ok: false, error: 'Gist file is not valid JSON or Gzip data' }
  }

  if (!Array.isArray(parsed.bookmarks))
    return { ok: false, error: 'Gist file missing bookmarks array' }

  const gistNodes = sanitizeNodes(parsed.bookmarks)
  return { ok: true, gistNodes, raw: parsed }
}

async function loadLocalNodes() {
  const localTree = await browser.bookmarks.getTree()
  const root = localTree[0]
  if (!root)
    return { ok: false as const, error: 'Failed to read local bookmarks' }

  // 始终全量同步，不再过滤
  const localNodes = toSyncNodes(root.children)

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

function buildBookmarkPayloadText(nodes: SyncNode[]) {
  return `${JSON.stringify(buildBookmarkPayload(nodes))}\n`
}

async function buildGzipRequestBody(text: string) {
  if (typeof CompressionStream === 'undefined') {
    return {
      body: text,
      headers: { 'Content-Type': 'application/json' },
      gzip: false,
    }
  }

  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  return {
    body: new Uint8Array(buffer),
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    },
    gzip: true,
  }
}

async function sendJsonRequestWithOptionalGzip(
  url: string,
  init: RequestInit,
  payload: unknown,
) {
  const jsonText = JSON.stringify(payload)
  const compressed = await buildGzipRequestBody(jsonText)
  let response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...compressed.headers,
    },
    body: compressed.body,
  })

  if (!response.ok && compressed.gzip) {
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        'Content-Type': 'application/json',
      },
      body: jsonText,
    })
  }

  return response
}

function countBookmarksFromPayloadText(content: string) {
  try {
    const parsed = JSON.parse(content) as { bookmarks?: unknown }
    if (!Array.isArray(parsed.bookmarks))
      return undefined
    const nodes = sanitizeNodes(parsed.bookmarks)
    return countBookmarks(nodes)
  }
  catch {
    return undefined
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

function buildWebDavVersionsIndexPath() {
  return 'gist-bookmark-sync/versions/index.json'
}

function buildWebDavVersionFilePath(fileName: string) {
  return `gist-bookmark-sync/versions/${fileName}`
}

function getWebDavVersionSeqFromFile(fileName: string) {
  const match = fileName.match(/^bookmark-(\d+)\.json$/)
  if (!match)
    return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function getNextWebDavVersionSeq(entries: WebDavVersionEntry[]) {
  let maxSeq = 0
  for (const entry of entries) {
    const seq = typeof entry.seq === 'number' ? entry.seq : getWebDavVersionSeqFromFile(entry.file)
    if (typeof seq === 'number' && seq > maxSeq)
      maxSeq = seq
  }
  return maxSeq + 1
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
  let response: Response
  try {
    response = await probeWebDavPath(url, username, password)
  }
  catch {
    return { ok: false, error: 'WebDAV 连接失败，请检查地址配置' }
  }

  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }

  if (response.status === 404) {
    try {
      response = await fetch(url, {
        method: 'MKCOL',
        headers: {
          ...buildWebDavAuthHeaders(username, password),
        },
      })
    }
    catch {
      return { ok: false, error: 'WebDAV 目录创建失败，请检查地址配置' }
    }

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

  let content = ''
  try {
    content = await readWebDavResponseText(response)
  }
  catch {
    return { ok: false, error: 'WebDAV 文件读取失败' }
  }
  let parsed: { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] }
  try {
    parsed = await decompressData(content) as { browser?: string, version?: string | number, createDate?: number, bookmarks?: unknown[] }
  }
  catch {
    return { ok: false, error: 'WebDAV 文件不是有效的 JSON' }
  }

  if (!Array.isArray(parsed.bookmarks))
    return { ok: false, error: 'WebDAV 文件缺少 bookmarks 数组' }

  const nodes = sanitizeNodes(parsed.bookmarks)
  return { ok: true, nodes, raw: parsed }
}

async function applyWebDavDownload(
  remoteNodes: SyncNode[],
  root: browser.bookmarks.BookmarkTreeNode,
  localNodes: SyncNode[],
) {
  const mergedNodes = mergeNodeLists(localNodes, remoteNodes)

  const index = await buildLocalIndex(root)
  await ensureLocalEntries(root.id, index, mergedNodes)

  const mergedCount = countBookmarks(mergedNodes)
  const summary = `成功同步 ${mergedCount} 条书签`
  const timestamp = new Date().toISOString()

  await browser.storage.local.set({
    'webdav-last-sync': timestamp,
    'webdav-last-sync-summary': summary,
  })

  return {
    ok: true,
    summary,
    timestamp,
  }
}


async function updateWebDavFile(url: string, username: string | undefined, password: string | undefined, nodes: SyncNode[]) {
  const payload = buildBookmarkPayload(nodes)
  let response: Response
  try {
    const compressedContent = await compressData(payload)
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...buildWebDavAuthHeaders(username, password),
        'Content-Type': 'application/json',
      },
      body: compressedContent,
    })
  }
  catch {
    return { ok: false, error: 'WebDAV 推送失败，请检查地址配置' }
  }

  if (!response.ok && response.status !== 401 && response.status !== 403 && response.status !== 404) {
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...buildWebDavAuthHeaders(username, password),
        },
        body: payload,
      })
    }
    catch {
      return { ok: false, error: 'WebDAV 推送失败，请检查地址配置' }
    }
  }

  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }
  if (response.status === 404)
    return { ok: false, error: 'WebDAV 路径不存在，请检查目录' }
  if (!response.ok)
    return { ok: false, error: 'WebDAV 推送失败，请检查地址配置' }

  return { ok: true }
}

async function updateWebDavRawFile(url: string, content: string, username: string | undefined, password: string | undefined) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...buildWebDavAuthHeaders(username, password),
    },
    body: content,
  })

  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }
  if (response.status === 404)
    return { ok: false, error: 'WebDAV 路径不存在，请检查目录' }
  if (!response.ok)
    return { ok: false, error: 'WebDAV 写入失败，请检查地址配置' }

  return { ok: true }
}

async function readWebDavResponseText(response: Response) {
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B

  if (isGzip) {
    if (typeof DecompressionStream === 'undefined')
      throw new Error('WebDAV gzip content unsupported')
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  }

  return new TextDecoder().decode(bytes)
}

async function loadWebDavVersionsIndex(baseUrl: string, username: string | undefined, password: string | undefined) {
  const indexUrl = buildWebDavFileUrl(baseUrl, buildWebDavVersionsIndexPath())
  const response = await fetch(indexUrl, {
    method: 'GET',
    headers: {
      ...buildWebDavAuthHeaders(username, password),
    },
  })

  if (response.status === 404)
    return { ok: true, entries: [] as WebDavVersionEntry[] }
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }
  if (!response.ok)
    return { ok: false, error: 'WebDAV 版本索引读取失败' }

  let content = ''
  try {
    content = await readWebDavResponseText(response)
  }
  catch {
    return { ok: false, error: 'WebDAV 版本索引读取失败' }
  }
  try {
    const parsed = JSON.parse(content) as WebDavVersionEntry[]
    if (!Array.isArray(parsed))
      return { ok: false, error: 'WebDAV 版本索引格式错误' }
    const entries = parsed.filter(item => item && typeof item.file === 'string' && typeof item.timestamp === 'string')
    return { ok: true, entries }
  }
  catch {
    return { ok: false, error: 'WebDAV 版本索引解析失败' }
  }
}

async function saveWebDavVersionsIndex(baseUrl: string, username: string | undefined, password: string | undefined, entries: WebDavVersionEntry[]) {
  const indexPath = buildWebDavVersionsIndexPath()
  const ensureResult = await ensureWebDavDirectories(baseUrl, indexPath, username, password)
  if (!ensureResult.ok)
    return ensureResult
  const indexUrl = buildWebDavFileUrl(baseUrl, indexPath)
  return await updateWebDavRawFile(indexUrl, `${JSON.stringify(entries)}\n`, username, password)
}

async function saveWebDavVersionSnapshot(
  baseUrl: string,
  username: string | undefined,
  password: string | undefined,
  content: string,
  explicitCount?: number,
) {
  const timestamp = new Date().toISOString()
  const count = explicitCount ?? countBookmarksFromPayloadText(content)
  const indexResult = await loadWebDavVersionsIndex(baseUrl, username, password)
  if (!indexResult.ok) {
    return indexResult
  }
  const nextSeq = getNextWebDavVersionSeq(indexResult.entries)
  const fileName = `bookmark-${nextSeq}.json`
  const versionPath = buildWebDavVersionFilePath(fileName)
  const ensureResult = await ensureWebDavDirectories(baseUrl, versionPath, username, password)
  if (!ensureResult.ok)
    return { ok: false, error: ensureResult.error }
  const versionUrl = buildWebDavFileUrl(baseUrl, versionPath)
  const writeResult = await updateWebDavRawFile(versionUrl, `${content.trim()}\n`, username, password)
  if (!writeResult.ok)
    return writeResult

  const nextEntries = [{ file: fileName, timestamp, count, seq: nextSeq }, ...indexResult.entries]
  const trimmed = nextEntries.slice(0, 50)
  const saveResult = await saveWebDavVersionsIndex(baseUrl, username, password, trimmed)
  if (!saveResult.ok)
    return saveResult

  return { ok: true }
}

async function updateGistFile(token: string, gistId: string, fileName: string, nodes: SyncNode[]) {
  const payload = buildBookmarkPayload(nodes)
  const updateResponse = await sendJsonRequestWithOptionalGzip(
    `https://api.github.com/gists/${gistId}`,
    {
      method: 'PATCH',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `token ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    {
      files: {
        [fileName]: {
          content: await compressData(payload),
        },
      },
    },
  )

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

function setActionBadge(status: 'idle' | 'loading' | 'error') {
  if (!browser.action?.setBadgeText)
    return

  if (status === 'idle') {
    void browser.action.setBadgeText({ text: '' })
    return
  }

  const text = status === 'loading' ? '…' : '!'
  const color = status === 'loading' ? '#2f80ed' : '#d64545'
  void browser.action.setBadgeText({ text })
  void browser.action.setBadgeBackgroundColor?.({ color })
}

async function openSidePanelForActiveTab() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    const tabId = tab?.id
    if (!tabId || !browser.sidePanel?.open)
      return
    // @ts-expect-error sidePanel is not typed in polyfill
    void browser.sidePanel.open({ tabId })
  }
  catch {
    // ignore
  }
}

function parseSelectedFolderIds(rawSelection: unknown): string[] {
  let selectedFolderIds: unknown[] | undefined
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

  if (!Array.isArray(selectedFolderIds))
    return []

  return selectedFolderIds.map(String)
}

async function isNodeInSelectedScope(nodeId: string, selectedSet: Set<string>) {
  if (selectedSet.size === 0)
    return true

  let currentId: string | undefined = nodeId
  const visited = new Set<string>()

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    if (selectedSet.has(currentId))
      return true

    try {
      const [node] = await browser.bookmarks.get(currentId)
      currentId = node?.parentId
    }
    catch {
      return false
    }
  }

  return false
}

async function isFolderInSelectedScope(folderId: string, selectedSet: Set<string>) {
  if (!folderId)
    return false
  return await isNodeInSelectedScope(folderId, selectedSet)
}

async function sendSyncErrorToast(message: string) {
  await openSidePanelForActiveTab()
  try {
    setTimeout(() => {
      void safeSendMessage('sync-error', { message }, { context: 'popup' })
    }, 300)
  }
  catch {
    // ignore
  }
}

async function runAutoUpload() {
  if (autoSyncInProgress)
    return

  debugLog('Auto sync: start check')
  autoSyncInProgress = true

  try {
    const stored = await browser.storage.local.get([
      'sync-provider',
      'github-token',
      'gist-id',
      'gist-file-name',
      'webdav-url',
    ])
    const provider = (stored['sync-provider'] as string | undefined) || 'gist'
    const token = (stored['github-token'] as string | undefined)?.trim()
    const gistId = (stored['gist-id'] as string | undefined)?.trim()
    const fileName = (stored['gist-file-name'] as string | undefined)?.trim()
    const webdavUrl = (stored['webdav-url'] as string | undefined)?.trim()

    if (provider === 'webdav') {
      if (!webdavUrl) {
        setActionBadge('idle')
        debugLog('Auto sync skipped: missing webdavUrl')
        return
      }
    }
    else if (provider === 'gist') {
      if (!token || !gistId || !fileName) {
        setActionBadge('idle')
        debugLog('Auto sync skipped: missing gist config')
        return
      }
    }
    else {
      setActionBadge('idle')
      debugLog('Auto sync skipped: unknown provider', provider)
      return
    }

    debugLog('Auto sync performSync upload, provider:', provider)
    setActionBadge('loading')
    const result = await performSync('upload')
    if (result.ok) {
      setActionBadge('idle')
      debugLog('Auto sync upload ok')
      return
    }

    setActionBadge('error')
    debugLog('Auto sync upload error', result.error)
    await sendSyncErrorToast(result.error || '同步失败')
  }
  catch (error) {
    setActionBadge('error')
    debugLog('Auto sync upload exception', error)
    await sendSyncErrorToast(error instanceof Error ? error.message : '同步失败')
  }
  finally {
    autoSyncInProgress = false
    if (autoSyncPending) {
      autoSyncPending = false
      scheduleAutoUpload()
    }
  }
}

async function runInitialDownloadOnce() {
  try {
    const stored = await browser.storage.local.get([
      INITIAL_DOWNLOAD_KEY,
      'sync-provider',
      'github-token',
      'gist-id',
      'gist-file-name',
      'webdav-url',
    ])
    if (stored[INITIAL_DOWNLOAD_KEY])
      return

    const provider = (stored['sync-provider'] as string | undefined) || 'gist'
    const token = (stored['github-token'] as string | undefined)?.trim()
    const gistId = (stored['gist-id'] as string | undefined)?.trim()
    const fileName = (stored['gist-file-name'] as string | undefined)?.trim()
    const webdavUrl = (stored['webdav-url'] as string | undefined)?.trim()

    if (provider === 'webdav') {
      if (!webdavUrl) {
        debugLog('Initial download skipped: missing webdavUrl')
        return
      }
    }
    else if (provider === 'gist') {
      if (!token || !gistId || !fileName) {
        debugLog('Initial download skipped: missing gist config')
        return
      }
    }
    else {
      debugLog('Initial download skipped: unknown provider', provider)
      return
    }

    debugLog('Initial download performSync, provider:', provider)
    const result = await performSync('download')
    if (!result.ok) {
      debugLog('Initial download error', result.error)
      return
    }

    await browser.storage.local.set({ [INITIAL_DOWNLOAD_KEY]: true })
    debugLog('Initial download ok')
  }
  catch (error) {
    debugLog('Initial download exception', error)
  }
}

function scheduleAutoUpload() {
  if (bookmarkEventSuspension > 0)
    return

  if (autoSyncInProgress) {
    autoSyncPending = true
    return
  }

  if (autoSyncTimer)
    clearTimeout(autoSyncTimer)

  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null
    debugLog('Auto sync timer fired, runAutoUpload')
    void runAutoUpload()
  }, 2000)
}

async function updateSyncIntervalAlarm(minutes: number) {
  if (!browser.alarms)
    return
  if (!minutes || minutes <= 0) {
    debugLog('Clearing auto sync alarm')
    await browser.alarms.clear(AUTO_SYNC_ALARM_NAME)
    return
  }
  debugLog('Creating auto sync alarm', minutes, 'minutes')
  await browser.alarms.create(AUTO_SYNC_ALARM_NAME, {
    delayInMinutes: minutes,
    periodInMinutes: minutes,
  })
}

async function bootstrapSyncIntervalAlarm() {
  try {
    const stored = await browser.storage.local.get(['sync-interval-minutes'])
    const minutes = Number(stored['sync-interval-minutes'] || 0)
    debugLog('Bootstrap auto sync alarm, minutes:', minutes)
    await updateSyncIntervalAlarm(Number.isFinite(minutes) ? minutes : 0)
  }
  catch {
    // ignore
  }
}

void bootstrapSyncIntervalAlarm()
void normalizeSyncLogs()
if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    void runInitialDownloadOnce()
  })
}

if (browser.alarms) {
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== AUTO_SYNC_ALARM_NAME)
      return
    debugLog('Auto sync alarm fired')

    try {
      const stored = await browser.storage.local.get([
        'sync-provider',
        'github-token',
        'gist-id',
        'gist-file-name',
        'webdav-url',
      ])
      const provider = (stored['sync-provider'] as string | undefined) || 'gist'
      const token = (stored['github-token'] as string | undefined)?.trim()
      const gistId = (stored['gist-id'] as string | undefined)?.trim()
      const fileName = (stored['gist-file-name'] as string | undefined)?.trim()
      const webdavUrl = (stored['webdav-url'] as string | undefined)?.trim()

      if (provider === 'webdav') {
        if (!webdavUrl)
          return
        debugLog('Auto sync: WebDAV download trigger')
      }
      else if (provider === 'gist') {
        if (!token || !gistId || !fileName)
          return
        debugLog('Auto sync: Gist download trigger')
      }
      else {
        return
      }

      await performSync('download')
    }
    catch {
      // ignore
    }
  })
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local')
    return
  if (changes['sync-interval-minutes']) {
    const nextValue = Number(changes['sync-interval-minutes'].newValue || 0)
    debugLog('sync-interval-minutes changed to', nextValue)
    void updateSyncIntervalAlarm(Number.isFinite(nextValue) ? nextValue : 0)
  }

  // 监听高级备份配置变化
  if (
    changes['advanced-backup-enabled']
    || changes['advanced-backup-provider']
    || changes['advanced-backup-start-hour']
    || changes['advanced-backup-end-hour']
    || changes['advanced-backup-count']
  ) {
    debugLog('Advanced backup config changed, rescheduling...')
    void scheduleNextRandomBackup(true)
  }
})

onMessage('refresh-sync-interval', async ({ data }) => {
  let minutes = Number(data?.minutes)
  if (!Number.isFinite(minutes)) {
    const stored = await browser.storage.local.get(['sync-interval-minutes'])
    minutes = Number(stored['sync-interval-minutes'] || 0)
  }
  await updateSyncIntervalAlarm(Number.isFinite(minutes) ? minutes : 0)
  return { ok: true }
})

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

async function clearLocalBookmarks(root: browser.bookmarks.BookmarkTreeNode, protectedIds?: Set<string>) {
  // eslint-disable-next-line no-console
  console.log('[ClearBookmarks] Clearing bookmarks', { protectedCount: protectedIds?.size })

  async function removeAllChildren(node: browser.bookmarks.BookmarkTreeNode) {
    if (!node.children) return
    for (const child of node.children) {
      // 如果节点被保护（排除在同步之外），则跳过（不删除也不递归删除其子节点）
      if (protectedIds && protectedIds.has(child.id))
        continue

      if (child.url) {
        await browser.bookmarks.remove(child.id).catch(() => { })
      }
      else {
        // 先递归删除子节点
        await removeAllChildren(child)
        // 尝试删除文件夹。如果里面有残留（因为某些子节点被保护了），这一步会失败及被 catch，这是预期的。
        await browser.bookmarks.remove(child.id).catch(() => { })
      }
    }
  }

  // Reload fresh tree
  const freshTree = await browser.bookmarks.getTree()
  const freshRoot = freshTree[0]
  if (!freshRoot || !freshRoot.children) return

  for (const rootFolder of freshRoot.children) {
    await removeAllChildren(rootFolder)
  }
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
  void safeSendMessage('tab-prev', { title: tab.title }, { context: 'content-script', tabId })
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
    const createResponse = await sendJsonRequestWithOptionalGzip(
      'https://api.github.com/gists',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `token ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      {
        description: 'GistBookmarkSync',
        public: false,
        files: {
          [fileName]: {
            content: `${JSON.stringify(buildBookmarkPayload([]))}\n`,
          },
        },
      },
    )

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
      'Accept': 'application/vnd.github+json',
      'Authorization': `token ${token}`,
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

    const createResponse = await sendJsonRequestWithOptionalGzip(
      `https://api.github.com/gists/${gistId}`,
      {
        method: 'PATCH',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `token ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      {
        files: {
          [fileName]: {
            content: `${JSON.stringify(buildBookmarkPayload([]))}\n`,
          },
        },
      },
    )

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

  const versionsIndexPath = buildWebDavVersionsIndexPath()
  const versionsEnsure = await ensureWebDavDirectories(baseUrl, versionsIndexPath, username, password)
  if (!versionsEnsure.ok)
    return { ok: false, errors: [versionsEnsure.error || 'WebDAV 版本目录校验失败'] }

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
  let provider: 'gist' | 'webdav' = 'gist'
  try {
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
      'advanced-concurrent-sync',
    ])
    provider = (stored['sync-provider'] as string | undefined) || 'gist'
    const token = (stored['github-token'] as string | undefined)?.trim()
    const gistId = (stored['gist-id'] as string | undefined)?.trim()
    const fileName = (stored['gist-file-name'] as string | undefined)?.trim()
    const syncDirection = (stored['sync-direction'] as string | undefined) || 'pull'
    const conflictStrategy = (stored['sync-conflict-strategy'] as string | undefined) || 'gist-wins'
    const concurrentSync = stored['advanced-concurrent-sync'] === true

    const selectedFolderIds = parseSelectedFolderIds(stored['sync-folder-selection'])

    debugLog('performSync start', { mode, provider })

    if (provider === 'webdav') {
      const baseUrl = (stored['webdav-url'] as string | undefined)?.trim()
      const username = (stored['webdav-username'] as string | undefined) || ''
      const password = (stored['webdav-password'] as string | undefined) || ''

      if (!baseUrl) {
        await browser.storage.local.set({
          'webdav-connection-status': 'error',
          'webdav-last-validation-time': Date.now(),
        })
        return await finalizeSyncResult(provider, mode, {
          ok: false,
          error: '请先配置 WebDAV 地址',
        })
      }

      const filePath = resolveWebDavFilePath('')
      const fileUrl = buildWebDavFileUrl(baseUrl, filePath)

      const localResult = await loadLocalNodes() // No args
      if (!localResult.ok)
        return await finalizeSyncResult(provider, mode, { ok: false, error: localResult.error })

      const { root, localNodes } = localResult

      if (mode === 'upload') {
        const ensureResult = await ensureWebDavDirectories(baseUrl, filePath, username, password)
        if (!ensureResult.ok) {
          await browser.storage.local.set({
            'webdav-connection-status': 'error',
            'webdav-last-validation-time': Date.now(),
          })
          return await finalizeSyncResult(provider, mode, { ok: false, error: ensureResult.error })
        }

        let existingText: string | null = null
        try {
          const existingResponse = await fetch(fileUrl, {
            method: 'GET',
            headers: {
              ...buildWebDavAuthHeaders(username, password),
            },
          })
          if (existingResponse.status === 401 || existingResponse.status === 403) {
            await browser.storage.local.set({
              'webdav-connection-status': 'error',
              'webdav-last-validation-time': Date.now(),
            })
            return await finalizeSyncResult(provider, mode, { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' })
          }
          else if (existingResponse.status !== 404 && existingResponse.ok) {
            existingText = await existingResponse.text()
          }
          else if (existingResponse.status !== 404 && !existingResponse.ok) {
            await browser.storage.local.set({
              'webdav-connection-status': 'error',
              'webdav-last-validation-time': Date.now(),
            })
            return await finalizeSyncResult(provider, mode, { ok: false, error: 'WebDAV 读取失败，请检查地址配置' })
          }
        }
        catch {
          await browser.storage.local.set({
            'webdav-connection-status': 'error',
            'webdav-last-validation-time': Date.now(),
          })
          return await finalizeSyncResult(provider, mode, { ok: false, error: 'WebDAV 读取失败，请检查地址配置' })
        }

        let remoteJson = ''
        if (existingText) {
          try {
            // 尝试解压现有内容以进行比较
            const parsed = await decompressData<any>(existingText)
            if (parsed && parsed.bookmarks) {
              remoteJson = JSON.stringify(parsed.bookmarks)
            }
          }
          catch {
            // ignore parse error which means content changed or corrupted
          }
        }

        const localJson = JSON.stringify(localNodes)

        // 生成压缩后的 Payload 用于版本快照
        const fullPayload = buildBookmarkPayload(localNodes)
        const payloadText = await compressData(fullPayload)

        if (remoteJson && remoteJson === localJson) {
          const timestamp = new Date().toISOString()
          await browser.storage.local.set({
            'webdav-connection-status': 'ok',
            'webdav-last-validation-time': Date.now(),
            'webdav-last-sync': timestamp,
            'webdav-last-sync-summary': '无变更，已跳过上传',
            'webdav-last-sync-folders': selectedFolderIds || [],
          })
          if (mode === 'upload' && concurrentSync) {
            void performRandomBackup({ isConcurrent: true })
          }

          return await finalizeSyncResult(provider, mode, {
            ok: true,
            summary: '无变更，已跳过上传',
            timestamp,
          })
        }

        const updated = await updateWebDavFile(fileUrl, username, password, localNodes)
        if (!updated.ok) {
          await browser.storage.local.set({
            'webdav-connection-status': 'error',
            'webdav-last-validation-time': Date.now(),
          })
          return await finalizeSyncResult(provider, mode, { ok: false, error: updated.error })
        }

        const localCount = countBookmarks(localNodes)
        const versionResult = await saveWebDavVersionSnapshot(baseUrl, username, password, payloadText, localCount)
        if (!versionResult.ok) {
          await browser.storage.local.set({
            'webdav-connection-status': 'error',
            'webdav-last-validation-time': Date.now(),
          })
          return await finalizeSyncResult(provider, mode, { ok: false, error: versionResult.error })
        }
        const summary = `成功同步 ${localCount} 条书签`
        const timestamp = new Date().toISOString()

        await browser.storage.local.set({
          'webdav-connection-status': 'ok',
          'webdav-last-validation-time': Date.now(),
          'webdav-last-sync': timestamp,
          'webdav-last-sync-summary': summary,
          'webdav-last-sync-folders': selectedFolderIds || [],
        })

        if (mode === 'upload' && concurrentSync) {
          void performRandomBackup({ isConcurrent: true })
        }

        return await finalizeSyncResult(provider, mode, {
          ok: true,
          summary,
          timestamp,
        })
      }

      const webdavResult = await loadWebDavBookmarks(fileUrl, username, password)
      if (!webdavResult.ok) {
        await browser.storage.local.set({
          'webdav-connection-status': 'error',
          'webdav-last-validation-time': Date.now(),
        })
        return await finalizeSyncResult(provider, mode, { ok: false, error: webdavResult.error })
      }

      await browser.storage.local.set({
        'webdav-connection-status': 'ok',
        'webdav-last-validation-time': Date.now(),
      })

      bookmarkEventSuspension += 1
      try {
        const downloadResult = await applyWebDavDownload(webdavResult.nodes, root, localNodes, selectedFolderIds)
        return await finalizeSyncResult(provider, mode, downloadResult)
      }
      finally {
        bookmarkEventSuspension = Math.max(0, bookmarkEventSuspension - 1)
      }
    }

    if (!token || !gistId || !fileName) {
      // 更新连接状态为错误
      await browser.storage.local.set({
        'connection-status': 'error',
        'last-validation-time': Date.now(),
      })
      return await finalizeSyncResult(provider, mode, {
        ok: false,
        error: '请先配置 GitHub Token、Gist ID 和文件名',
      })
    }

    const gistResult = await loadGistBookmarks(token, gistId, fileName)
    if (!gistResult.ok) {
      // 更新连接状态为错误
      await browser.storage.local.set({
        'connection-status': 'error',
        'last-validation-time': Date.now(),
      })
      return await finalizeSyncResult(provider, mode, { ok: false, error: gistResult.error })
    }

    // 连接成功，更新状态
    await browser.storage.local.set({
      'connection-status': 'ok',
      'last-validation-time': Date.now(),
    })

    // 始终加载所有本地书签
    const localResult = await loadLocalNodes()
    if (!localResult.ok)
      return await finalizeSyncResult(provider, mode, { ok: false, error: localResult.error })

    const { root, localNodes } = localResult

    // Gist Upload logic cleanup
    if (mode === 'upload') {
      const updated = await updateGistFile(token, gistId, fileName, localNodes)
      if (!updated)
        return await finalizeSyncResult(provider, mode, { ok: false, error: 'Failed to update Gist' })

      const localCount = countBookmarks(localNodes)
      const summary = `成功同步 ${localCount} 条书签`
      const timestamp = new Date().toISOString()

      await browser.storage.local.set({
        'gist-bookmarks-cache': { version: 1, bookmarks: localNodes },
        'gist-last-sync': timestamp,
        'gist-last-sync-summary': summary,
        'gist-last-sync-direction': syncDirection,
        'gist-last-sync-strategy': conflictStrategy,
        // 'gist-last-sync-folders': selectedFolderIds || [], // REMOVED
      })

      if (mode === 'upload' && concurrentSync) {
        void performRandomBackup({ isConcurrent: true })
      }

      return await finalizeSyncResult(provider, mode, {
        ok: true,
        summary,
        timestamp,
      })
    }

    // Gist Download Mode
    bookmarkEventSuspension += 1
    try {
      if (!gistResult.ok) throw new Error('Unexpected error: gistResult is not ok')

      const mergedNodes = mergeNodeLists(localNodes, gistResult.gistNodes)

      const index = await buildLocalIndex(root)
      await ensureLocalEntries(root.id, index, mergedNodes)

      // Reorder excluded folders to the end
      if (selectedFolderIds && selectedFolderIds.length > 0) {
        await moveExcludedToEnd(new Set(selectedFolderIds))
      }

      const mergedCount = countBookmarks(mergedNodes)
      const summary = `成功同步 ${mergedCount} 条书签`
      const timestamp = new Date().toISOString()

      await browser.storage.local.set({
        'gist-bookmarks-cache': { version: 1, bookmarks: mergedNodes },
        'gist-last-sync': timestamp,
        'gist-last-sync-summary': summary,
        'gist-last-sync-direction': syncDirection,
        'gist-last-sync-strategy': conflictStrategy,
      })

      return await finalizeSyncResult(provider, mode, {
        ok: true,
        summary,
        timestamp,
      })
    }
    finally {
      bookmarkEventSuspension = Math.max(0, bookmarkEventSuspension - 1)
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '同步失败'
    return await finalizeSyncResult(provider, mode, { ok: false, error: message })
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

// =============================================
// 高级备份（随机备份）功能
// =============================================

/**
 * 执行随机备份：使用备用 provider 上传书签
 * 与主同步不同，随机备份使用配置的备用 provider
 */
async function performRandomBackup(options: { isConcurrent?: boolean } = {}) {
  const isConcurrent = options.isConcurrent === true
  debugLog('performRandomBackup start', { isConcurrent })

  const stored = await browser.storage.local.get([
    'advanced-backup-enabled',
    'sync-provider',
    'sync-folder-selection',
    'github-token',
    'gist-id',
    'gist-file-name',
    'webdav-url',
    'webdav-username',
    'webdav-password',
    'advanced-backup-today-count',
    'advanced-backup-count',
    'advanced-backup-history',
    'advanced-concurrent-scope',
  ])

  const enabled = stored['advanced-backup-enabled'] === true

  // 动态确定备份 provider：总是与主同步方式相反（互补）
  const mainProvider = (stored['sync-provider'] as string | undefined) || 'gist'
  const backupProvider = mainProvider === 'gist' ? 'webdav' : 'gist'

  // 如果是随机备份模式，需要检查是否启用；如果是并发同步模式，忽略随机备份的开关
  if (!isConcurrent && !enabled) {
    debugLog('Random backup skipped: not enabled')
    return { ok: false, error: '随机备份未启用' }
  }

  // 检查今日备份次数是否已达上限（并发同步模式不占用次数）
  const history = (stored['advanced-backup-history'] as string[] | undefined) || []
  const todayStr = new Date().toDateString()
  const todayCount = history.filter(ts => new Date(ts).toDateString() === todayStr).length

  const targetCount = (stored['advanced-backup-count'] as number | undefined) || 3
  if (!isConcurrent && todayCount >= targetCount) {
    debugLog('Random backup skipped: daily limit reached', { todayCount, targetCount })
    return { ok: false, error: '今日备份次数已达上限' }
  }

  const provider = backupProvider as 'gist' | 'webdav'

  try {
    // 加载本地书签
    const localResult = await loadLocalNodes()
    if (!localResult.ok) {
      return await finalizeRandomBackupResult(provider, { ok: false, error: localResult.error })
    }

    const { localNodes } = localResult

    // 计算内容哈希以检测变更
    const contentHash = await computeContentHash(localNodes)
    const hashKey = `backup-hash-${provider}`
    const lastHash = (stored[hashKey] as string | undefined)

    if (lastHash === contentHash) {
      debugLog(`Backup skipped (${provider}): content unchanged`)
      return await finalizeRandomBackupResult(provider, {
        ok: true,
        summary: '无变更，已跳过上传',
        // 使用当前时间作为 timestamp
        timestamp: new Date().toISOString()
      }, isConcurrent)
    }

    if (provider === 'webdav') {
      // 使用 WebDAV 备份
      const baseUrl = (stored['webdav-url'] as string | undefined)?.trim()
      const username = (stored['webdav-username'] as string | undefined) || ''
      const password = (stored['webdav-password'] as string | undefined) || ''

      if (!baseUrl) {
        return await finalizeRandomBackupResult(provider, { ok: false, error: 'WebDAV 未配置' })
      }

      const filePath = resolveWebDavFilePath('')
      const fileUrl = buildWebDavFileUrl(baseUrl, filePath)

      const ensureResult = await ensureWebDavDirectories(baseUrl, filePath, username, password)
      if (!ensureResult.ok) {
        return await finalizeRandomBackupResult(provider, { ok: false, error: ensureResult.error }, isConcurrent)
      }

      const updated = await updateWebDavFile(fileUrl, username, password, localNodes)
      if (!updated.ok) {
        return await finalizeRandomBackupResult(provider, { ok: false, error: updated.error }, isConcurrent)
      }

      const fullPayload = buildBookmarkPayload(localNodes)
      const payloadText = await compressData(fullPayload)
      const localCount = countBookmarks(localNodes)
      await saveWebDavVersionSnapshot(baseUrl, username, password, payloadText, localCount)


      const actionName = isConcurrent ? '随行备份' : '随机备份'
      const summary = `${actionName}成功 ${localCount} 条书签 (WebDAV)`
      const timestamp = new Date().toISOString()

      // 只有非随行备份（即随机备份）才记录历史和消耗次数
      if (!isConcurrent) {
        // 更新今日备份计数和历史记录
        const history = (stored['advanced-backup-history'] as string[] | undefined) || []
        history.push(timestamp)

        await browser.storage.local.set({
          'advanced-backup-today-count': todayCount + 1,
          'advanced-backup-history': history,
          [hashKey]: contentHash
        })
      } else {
        await browser.storage.local.set({ [hashKey]: contentHash })
      }

      return await finalizeRandomBackupResult(provider, { ok: true, summary, timestamp }, isConcurrent)
    }
    else {
      // 使用 Gist 备份
      const token = (stored['github-token'] as string | undefined)?.trim()
      const gistId = (stored['gist-id'] as string | undefined)?.trim()
      const fileName = (stored['gist-file-name'] as string | undefined)?.trim()

      if (!token || !gistId || !fileName) {
        return await finalizeRandomBackupResult(provider, { ok: false, error: 'Gist 未配置' }, isConcurrent)
      }

      const updated = await updateGistFile(token, gistId, fileName, localNodes)
      if (!updated) {
        return await finalizeRandomBackupResult(provider, { ok: false, error: 'Gist 更新失败' }, isConcurrent)
      }

      const localCount = countBookmarks(localNodes)
      const actionName = isConcurrent ? '随行备份' : '随机备份'
      const summary = `${actionName}成功 ${localCount} 条书签 (Gist)`
      const timestamp = new Date().toISOString()

      // 只有非随行备份（即随机备份）才记录历史和消耗次数
      if (!isConcurrent) {
        // 更新今日备份计数和历史记录
        const history = (stored['advanced-backup-history'] as string[] | undefined) || []
        history.push(timestamp)

        await browser.storage.local.set({
          'advanced-backup-today-count': todayCount + 1,
          'advanced-backup-history': history,
          [hashKey]: contentHash
        })
      } else {
        await browser.storage.local.set({ [hashKey]: contentHash })
      }

      return await finalizeRandomBackupResult(provider, { ok: true, summary, timestamp }, isConcurrent)
    }
  }
  catch (error) {
    const actionName = isConcurrent ? '随行备份' : '随机备份'
    const message = error instanceof Error ? error.message : `${actionName}失败`
    return await finalizeRandomBackupResult(provider, { ok: false, error: message }, isConcurrent)
  }
}

/**
 * 记录随机备份日志
 */
async function finalizeRandomBackupResult(
  provider: 'gist' | 'webdav',
  result: { ok: true, summary?: string, timestamp?: string } | { ok: false, error?: string },
  isConcurrent = false,
) {
  const entry: SyncLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: 'timestamp' in result && result.timestamp ? result.timestamp : new Date().toISOString(),
    provider,
    mode: isConcurrent ? 'concurrent-sync' : 'random-backup',
    status: result.ok ? 'ok' : 'error',
    summary: result.ok ? (result.summary || '备份成功') : (result.error || '备份失败'),
  }
  await appendSyncLog(entry)
  debugLog('Random backup finalized', entry)
  return result
}

/**
 * 检查是否在备份时间区间内
 */
function isInBackupTimeRange(startHour: number, endHour: number): boolean {
  const now = new Date()
  const currentHour = now.getHours()
  if (startHour <= endHour) {
    return currentHour >= startHour && currentHour < endHour
  }
  else {
    // 跨夜情况，如 22:00-06:00
    return currentHour >= startHour || currentHour < endHour
  }
}

/**
 * 计算下次随机备份的时间延迟（毫秒）
 */
/**
 * 计算下次随机备份的时间延迟（毫秒）
 * 根据剩余时间和剩余次数动态分配
 */
function calculateNextRandomBackupDelay(endHour: number, remainingCount: number): number {
  const now = new Date()
  let targetEnd = new Date(now)
  targetEnd.setHours(endHour, 0, 0, 0)

  // 如果目标结束时间在过去，说明跨夜了（或者异常），需要在下一天
  // 但前面已保证 isInBackupTimeRange，所以如果是跨夜区间（如22-06），当前23点，结束06点，06点是明天。
  if (targetEnd.getTime() <= now.getTime()) {
    targetEnd.setDate(targetEnd.getDate() + 1)
  }

  const remainingMinutes = (targetEnd.getTime() - now.getTime()) / 60000
  if (remainingMinutes <= 5) {
    return 60 * 1000 // 剩余时间很少，1分钟后执行
  }

  const safeCount = Math.max(1, remainingCount)
  const intervalMinutes = remainingMinutes / safeCount

  // 在分配的时间片内随机
  const delayMinutes = Math.random() * intervalMinutes

  return Math.max(60 * 1000, delayMinutes * 60 * 1000)
}

/**
 * 设置下一次随机备份的 alarm
 */
/**
 * 设置下一次随机备份的 alarm
 * @param force 是否强制重新调度（忽略已有 alarm）
 */
async function scheduleNextRandomBackup(force = false) {
  const stored = await browser.storage.local.get([
    'advanced-backup-enabled',
    'advanced-backup-provider',
    'advanced-backup-start-hour',
    'advanced-backup-end-hour',
    'advanced-backup-count',
    'advanced-backup-today-count',
    'advanced-backup-last-date',
    'advanced-backup-history',
    'advanced-backup-next-run-time',
  ])

  const enabled = stored['advanced-backup-enabled'] === true
  const backupProvider = stored['advanced-backup-provider'] as string | undefined

  if (!enabled) {
    debugLog('Random backup scheduling skipped: feature not enabled')
    await browser.alarms?.clear(RANDOM_BACKUP_ALARM_NAME)
    return
  }

  if (!backupProvider) {
    debugLog('Random backup scheduling skipped: no backup provider selected')
    await browser.alarms?.clear(RANDOM_BACKUP_ALARM_NAME)
    return
  }

  const startHour = (stored['advanced-backup-start-hour'] as number | undefined) ?? 9
  const endHour = (stored['advanced-backup-end-hour'] as number | undefined) ?? 18
  const dailyCount = (stored['advanced-backup-count'] as number | undefined) || 3
  const todayCount = Number(stored['advanced-backup-today-count']) || 0
  const lastDate = (stored['advanced-backup-last-date'] as string | undefined) || ''

  // 检查是否需要重置今日计数（新的一天）
  const today = new Date().toISOString().slice(0, 10)
  if (lastDate !== today) {
    await browser.storage.local.set({
      'advanced-backup-last-date': today,
      'advanced-backup-today-count': 0,
      'advanced-backup-history': [],
      'advanced-backup-next-run-time': null,
    })
    debugLog('Random backup: new day, reset today count')
  }

  const actualTodayCount = lastDate === today ? todayCount : 0

  // 如果今日备份次数已达上限，不调度
  if (actualTodayCount >= dailyCount) {
    debugLog('Random backup scheduling skipped: daily limit reached')
    await browser.alarms?.clear(RANDOM_BACKUP_ALARM_NAME)
    return
  }

  // 如果非强制且已有 alarm，跳过
  if (!force) {
    const existing = await browser.alarms?.get(RANDOM_BACKUP_ALARM_NAME)
    if (existing) {
      debugLog('Random backup alarm already scheduled, skipping', {
        scheduledTime: new Date(existing.scheduledTime).toLocaleString(),
        force
      })
      return
    }
  }

  // 如果不在时间区间内，计算到开始时间的延迟
  if (!isInBackupTimeRange(startHour, endHour)) {
    const now = new Date()
    const currentHour = now.getHours()
    let hoursUntilStart: number

    if (currentHour < startHour) {
      hoursUntilStart = startHour - currentHour
    }
    else {
      hoursUntilStart = 24 - currentHour + startHour
    }

    const delayMs = hoursUntilStart * 60 * 60 * 1000 + Math.random() * 30 * 60 * 1000
    const scheduledTime = new Date(Date.now() + delayMs).toLocaleString()
    debugLog('Random backup: not in time range, scheduling for start', {
      hoursUntilStart,
      scheduledTime
    })
    const nextRunTime = Date.now() + delayMs
    await browser.storage.local.set({
      'advanced-backup-next-run-time': nextRunTime
    })
    await browser.alarms?.create(RANDOM_BACKUP_ALARM_NAME, { delayInMinutes: delayMs / 60000 })
    return
  }

  // 在时间区间内，计算下次备份时间
  // 修正：基于剩余时间计算，而非全天时间
  const delayMs = calculateNextRandomBackupDelay(endHour, dailyCount - actualTodayCount)
  const scheduledTime = new Date(Date.now() + delayMs).toLocaleString()
  debugLog(`Random backup: scheduling next backup (${actualTodayCount + 1}/${dailyCount})`, {
    delayMinutes: (delayMs / 60000).toFixed(1),
    scheduledTime
  })

  const nextRunTime = Date.now() + delayMs
  await browser.storage.local.set({
    'advanced-backup-next-run-time': nextRunTime
  })

  await browser.alarms?.create(RANDOM_BACKUP_ALARM_NAME, { delayInMinutes: delayMs / 60000 })
}

// 监听 alarm 触发
browser.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RANDOM_BACKUP_ALARM_NAME) {
    debugLog('Random backup alarm triggered')

    const stored = await browser.storage.local.get([
      'advanced-backup-enabled',
      'advanced-backup-start-hour',
      'advanced-backup-end-hour',
    ])

    const enabled = stored['advanced-backup-enabled'] === true
    const startHour = (stored['advanced-backup-start-hour'] as number | undefined) ?? 9
    const endHour = (stored['advanced-backup-end-hour'] as number | undefined) ?? 18

    if (enabled && isInBackupTimeRange(startHour, endHour)) {
      await performRandomBackup()
    }

    // 调度下一次备份
    await scheduleNextRandomBackup(true)
  }
})

// 立即执行随机备份
onMessage('random-backup-now', async () => {
  const stored = await browser.storage.local.get([
    'advanced-backup-enabled',
    'advanced-backup-provider',
  ])

  const enabled = stored['advanced-backup-enabled'] === true
  const backupProvider = stored['advanced-backup-provider'] as string | undefined

  if (!enabled || !backupProvider) {
    return { ok: false, error: '随机备份未启用或未配置备份方式' }
  }

  return await performRandomBackup()
})

// 获取高级备份配置
// 获取高级备份配置
onMessage('get-advanced-backup-config', async () => {
  const stored = await browser.storage.local.get([
    'advanced-backup-enabled',
    'advanced-backup-provider',
    'advanced-backup-start-hour',
    'advanced-backup-end-hour',
    'advanced-backup-count',
    'advanced-backup-today-count',
    'advanced-backup-last-date',
    'advanced-backup-history',
    'advanced-backup-next-run-time',
    'advanced-concurrent-sync',
    'advanced-concurrent-scope',
  ])

  const today = new Date().toISOString().slice(0, 10)
  const lastDate = (stored['advanced-backup-last-date'] as string | undefined) || ''
  const todayCount = lastDate === today ? (Number(stored['advanced-backup-today-count']) || 0) : 0
  const history = lastDate === today ? (stored['advanced-backup-history'] as string[] || []) : []
  const nextRunTime = stored['advanced-backup-next-run-time'] as number | undefined

  return {
    ok: true,
    config: {
      enabled: stored['advanced-backup-enabled'] === true,
      provider: (stored['advanced-backup-provider'] as string | undefined) || '',
      startHour: (stored['advanced-backup-start-hour'] as number | undefined) ?? 9,
      endHour: (stored['advanced-backup-end-hour'] as number | undefined) ?? 18,
      count: (stored['advanced-backup-count'] as number | undefined) || 3,
      todayCount,
      history,
      nextRunTime,
      concurrentSync: stored['advanced-concurrent-sync'] === true,
      concurrentScope: (stored['advanced-concurrent-scope'] as 'sync' | 'full') || 'sync',
    },
  }
})

// 更新高级备份配置
onMessage('update-advanced-backup-config', async ({ data }) => {
  const config = data as {
    enabled?: boolean
    provider?: string
    startHour?: number
    endHour?: number
    count?: number
    concurrentSync?: boolean
  } | undefined

  if (!config) {
    return { ok: false, error: '无效的配置参数' }
  }

  const updates: Record<string, unknown> = {}

  if (typeof config.enabled === 'boolean') {
    updates['advanced-backup-enabled'] = config.enabled
  }
  if (typeof config.provider === 'string') {
    updates['advanced-backup-provider'] = config.provider
  }
  if (typeof config.startHour === 'number') {
    updates['advanced-backup-start-hour'] = Math.max(0, Math.min(23, config.startHour))
  }
  if (typeof config.endHour === 'number') {
    updates['advanced-backup-end-hour'] = Math.max(0, Math.min(23, config.endHour))
  }
  if (typeof config.count === 'number') {
    updates['advanced-backup-count'] = Math.max(1, Math.min(10, config.count))
  }
  if (typeof config.concurrentSync === 'boolean') {
    updates['advanced-concurrent-sync'] = config.concurrentSync
  }

  await browser.storage.local.set(updates)
  debugLog('Advanced backup config updated', updates)

  // 不再手动调用，依赖 browser.storage.onChanged 监听器触发重新调度
  // await scheduleNextRandomBackup(true)

  return { ok: true }
})

// 启动时调度随机备份
void scheduleNextRandomBackup()


onMessage('webdav-list-versions', async () => {
  const stored = await browser.storage.local.get([
    'webdav-url',
    'webdav-username',
    'webdav-password',
  ])
  const baseUrl = (stored['webdav-url'] as string | undefined)?.trim()
  const username = (stored['webdav-username'] as string | undefined) || ''
  const password = (stored['webdav-password'] as string | undefined) || ''

  if (!baseUrl)
    return { ok: false, error: '请先配置 WebDAV 地址' }

  const indexResult = await loadWebDavVersionsIndex(baseUrl, username, password)
  if (!indexResult.ok)
    return { ok: false, error: indexResult.error }

  const sorted = [...indexResult.entries].sort((a, b) => {
    const aTime = Date.parse(a.timestamp)
    const bTime = Date.parse(b.timestamp)
    return bTime - aTime
  })

  return {
    ok: true,
    versions: sorted.slice(0, 5),
  }
})

onMessage('webdav-delete-version', async ({ data }) => {
  const file = data?.file as string | undefined
  if (!file)
    return { ok: false, error: '缺少版本文件' }

  const stored = await browser.storage.local.get([
    'webdav-url',
    'webdav-username',
    'webdav-password',
  ])
  const baseUrl = (stored['webdav-url'] as string | undefined)?.trim()
  const username = (stored['webdav-username'] as string | undefined) || ''
  const password = (stored['webdav-password'] as string | undefined) || ''

  if (!baseUrl)
    return { ok: false, error: '请先配置 WebDAV 地址' }

  const versionPath = buildWebDavVersionFilePath(file)
  const versionUrl = buildWebDavFileUrl(baseUrl, versionPath)
  const response = await fetch(versionUrl, {
    method: 'DELETE',
    headers: {
      ...buildWebDavAuthHeaders(username, password),
    },
  })

  if (response.status === 401 || response.status === 403)
    return { ok: false, error: 'WebDAV 认证失败，请检查账号或密码' }
  if (!response.ok && response.status !== 404)
    return { ok: false, error: 'WebDAV 删除版本失败' }

  const indexResult = await loadWebDavVersionsIndex(baseUrl, username, password)
  if (!indexResult.ok)
    return { ok: false, error: indexResult.error }

  const nextEntries = indexResult.entries.filter(entry => entry.file !== file)
  const saveResult = await saveWebDavVersionsIndex(baseUrl, username, password, nextEntries)
  if (!saveResult.ok)
    return { ok: false, error: saveResult.error }

  return { ok: true }
})

onMessage('webdav-download-version', async ({ data }) => {
  const file = data?.file as string | undefined
  if (!file)
    return { ok: false, error: '缺少版本文件' }

  const stored = await browser.storage.local.get([
    'webdav-url',
    'webdav-username',
    'webdav-password',
    'sync-folder-selection',
  ])
  const baseUrl = (stored['webdav-url'] as string | undefined)?.trim()
  const username = (stored['webdav-username'] as string | undefined) || ''
  const password = (stored['webdav-password'] as string | undefined) || ''

  if (!baseUrl)
    return { ok: false, error: '请先配置 WebDAV 地址' }

  const localResult = await loadLocalNodes()
  if (!localResult.ok)
    return { ok: false, error: localResult.error }

  const versionPath = buildWebDavVersionFilePath(file)
  const versionUrl = buildWebDavFileUrl(baseUrl, versionPath)
  const webdavResult = await loadWebDavBookmarks(versionUrl, username, password)
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

  bookmarkEventSuspension += 1
  try {
    await clearLocalBookmarks(localResult.root)
    const refreshedLocal = await loadLocalNodes()
    if (!refreshedLocal.ok)
      return { ok: false, error: refreshedLocal.error }

    // 应用下载的内容
    const result = await applyWebDavDownload(webdavResult.nodes, refreshedLocal.root, refreshedLocal.localNodes)

    return result
  }
  finally {
    bookmarkEventSuspension = Math.max(0, bookmarkEventSuspension - 1)
  }
})

async function toggleSidePanel(tabId: number) {
  // @ts-expect-error sidePanel is not typed in polyfill
  if (!browser.sidePanel?.open)
    return { ok: false, error: 'Side panel not supported' }

  // Toggle logic based on tracked state
  const isOpen = sidePanelOpenByTab.get(tabId) ?? false

  if (isOpen) {
    // Attempt to close via message
    // We don't await this to keep the response fast, but we handle errors to correct state
    await sendMessage('close-sidepanel', { tabId }, 'popup')
      .catch(() => {
        // If sending failed, assume it wasn't actually open or is unresponsive
        // Correct the state so next click will try to open
        sidePanelOpenByTab.set(tabId, false)
      })
    return { ok: true }
  }
  else {
    // Open the panel
    // @ts-expect-error sidePanel is not typed in polyfill
    await browser.sidePanel.open({ tabId })
    return { ok: true }
  }
}

onMessage('open-sidepanel', async ({ sender }) => {
  try {
    const tabId = sender?.tabId ?? sender?.tab?.id
    if (!tabId)
      return { ok: false, error: 'No tab id from sender' }

    return await toggleSidePanel(tabId)
  }
  catch (e) {
    // eslint-disable-next-line no-console
    console.error('Failed to toggle side panel', e)
    return { ok: false, error: String(e) }
  }
})

// Support toggling via toolbar icon
// Note: This requires openPanelOnActionClick to be false
browser.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    await toggleSidePanel(tab.id)
  }
})

async function shouldTriggerAutoSync(nodeId?: string, parentId?: string, oldParentId?: string) {
  if (bookmarkEventSuspension > 0)
    return false

  const stored = await browser.storage.local.get(['sync-folder-selection'])
  const selectedSet = new Set(parseSelectedFolderIds(stored['sync-folder-selection']))

  if (selectedSet.size === 0)
    return true

  if (nodeId && await isNodeInSelectedScope(nodeId, selectedSet))
    return true

  if (parentId && await isFolderInSelectedScope(parentId, selectedSet))
    return true

  if (oldParentId && await isFolderInSelectedScope(oldParentId, selectedSet))
    return true

  return false
}

browser.bookmarks.onCreated.addListener(async (id, node) => {
  if (await shouldTriggerAutoSync(id, node.parentId))
    scheduleAutoUpload()
})

browser.bookmarks.onChanged.addListener(async (id) => {
  if (await shouldTriggerAutoSync(id))
    scheduleAutoUpload()
})

browser.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  if (await shouldTriggerAutoSync(id, moveInfo.parentId, moveInfo.oldParentId))
    scheduleAutoUpload()
})

browser.bookmarks.onRemoved.addListener(async (_id, removeInfo) => {
  if (await shouldTriggerAutoSync(undefined, removeInfo.parentId))
    scheduleAutoUpload()
})

onMessage('sidepanel-visibility', ({ sender, data }) => {
  const tabId = (data as { tabId?: number } | undefined)?.tabId ?? sender?.tabId ?? sender?.tab?.id
  if (!tabId)
    return { ok: false, error: 'No tab id from sender' }

  sidePanelOpenByTab.set(tabId, Boolean((data as { open?: boolean } | undefined)?.open))
  return { ok: true }
})

onMessage('clear-bookmarks', async () => {
  bookmarkEventSuspension += 1
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer)
    autoSyncTimer = null
  }
  autoSyncPending = false
  try {
    const tree = await browser.bookmarks.getTree()
    const root = tree[0]
    if (!root)
      return { ok: false, success: false, error: 'Failed to read bookmarks' }

    const stored = await browser.storage.local.get(['sync-folder-selection'])
    const selectedIds = new Set(parseSelectedFolderIds(stored['sync-folder-selection']))

    // Validate if selected IDs match current tree
    if (selectedIds.size > 0) {
      let matchFound = false
      const checkMatch = (node: browser.bookmarks.BookmarkTreeNode) => {
        if (matchFound)
          return
        if (selectedIds.has(node.id)) {
          matchFound = true
          return
        }
        node.children?.forEach(checkMatch)
      }
      checkMatch(root)

      if (!matchFound) {
        // eslint-disable-next-line no-console
        console.warn('[ClearBookmarks] Configured items not found in local tree - aborting clear to protect excluded items')
        return { ok: false, error: '同步范围失效，无法安全清除。请在设置中重新勾选同步目录。' }
      }
    }

    await clearLocalBookmarks(root, selectedIds)

    return { ok: true, success: true }
  }
  catch (error) {
    return { ok: false, success: false, error: String(error) }
  }
  finally {
    bookmarkEventSuspension = Math.max(0, bookmarkEventSuspension - 1)
  }
})

onMessage('export-bookmarks', async ({ data }) => {
  try {


    const localTree = await browser.bookmarks.getTree()
    const root = localTree[0]
    if (!root)
      return { ok: false, error: 'Failed to read bookmarks' }

    const bookmarks = toSyncNodes(root.children)

    const payload = {
      browser: navigator.userAgent,
      version: browser.runtime.getManifest().version,
      createDate: Date.now(),
      exportType: 'full',
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

onMessage('get-bookmark-stats', async () => {
  const tree = await browser.bookmarks.getTree()
  let bookmarks = 0
  let folders = 0
  const walk = (nodes: browser.bookmarks.BookmarkTreeNode[]) => {
    for (const node of nodes) {
      if (node.url) {
        bookmarks++
      }
      else {
        // Exclude root node '0'
        if (node.id !== '0')
          folders++
        if (node.children)
          walk(node.children)
      }
    }
  }
  walk(tree)
  return { ok: true, stats: { bookmarks, folders } }
})

async function computeContentHash(nodes: SyncNode[]): Promise<string> {
  const str = JSON.stringify(nodes)
  const msgBuffer = new TextEncoder().encode(str)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 将 protectedIds 中的书签移动到所在父文件夹的末尾
 * 用于防止在同步下载后，这些不想被同步影响的文件夹跑到前面去
 */
async function moveExcludedToEnd(protectedIds: Set<string>) {
  if (protectedIds.size === 0) return

  const toMove: string[] = []

  // 遍历寻找需要移动的 ID
  const tree = await browser.bookmarks.getTree()
  const walk = (node: browser.bookmarks.BookmarkTreeNode) => {
    if (protectedIds.has(node.id)) {
      toMove.push(node.id)
      return
    }
    if (node.children) {
      node.children.forEach(walk)
    }
  }
  if (tree[0].children) {
    tree[0].children.forEach(walk)
  }

  // 执行移动
  for (const id of toMove) {
    try {
      // 移动到极大索引值，即 append 到末尾
      await browser.bookmarks.move(id, { index: 10000000 })
    }
    catch (e) {
      // 忽略移动失败（例如已被手动删除）
    }
  }
}
