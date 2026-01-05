<script setup lang="ts">
import { onMessage, sendMessage } from 'webext-bridge/popup'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  connectionStatus,
  connectionStatusReady,
  gistFileName,
  gistId,
  gistIdReady,
  githubToken,
  githubTokenReady,
  lastValidationTime,
  syncFolderSelection,
  syncFolderSelectionReady,
  syncIntervalMinutes,
  syncIntervalMinutesReady,
  syncLogs,
  syncLogsReady,
  syncProvider,
  syncProviderReady,
  webdavConnectionStatus,
  webdavConnectionStatusReady,
  webdavLastValidationTime,
  webdavPassword,
  webdavUrl,
  webdavUrlReady,
  webdavUsername,
} from '~/logic/storage'
import type { SyncLogEntry } from '~/logic/storage'

interface FolderNode {
  id: string
  title: string
  count: number
  children: FolderNode[]
}

const gistValidationState = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const webdavValidationState = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const uploadState = ref<'idle' | 'syncing' | 'done' | 'error'>('idle')
const downloadState = ref<'idle' | 'syncing' | 'done' | 'error'>('idle')
const folderTree = ref<FolderNode[]>([])
const folderTreeState = ref<'idle' | 'loading' | 'error'>('idle')
const folderTreeMessage = ref('')
const selectedFolderIds = ref(new Set<string>())
const savedFolderIds = ref(new Set<string>()) // 已保存的选择，用于统计
const currentTabId = ref<number | null>(null)
const webdavVersionsVisible = ref(false)
const webdavVersionsState = ref<'idle' | 'loading' | 'error'>('idle')
const webdavVersionsMessage = ref('')
const webdavVersions = ref<Array<{ file: string, timestamp: string, count?: number }>>([])
let downloadClickTimer: ReturnType<typeof setTimeout> | null = null
const intervalDropdownOpen = ref(false)
const intervalDropdownRef = ref<HTMLElement | null>(null)
const intervalDropdownTriggerRef = ref<HTMLElement | null>(null)
const intervalDropdownMenuRef = ref<HTMLElement | null>(null)
const intervalDropdownStyle = ref<Record<string, string>>({})
const syncLogVisible = ref(false)
const syncLogReady = ref(false)
const syncLogError = ref('')
const exportModalVisible = ref(false)
const exportIncludeExcluded = ref(true)

const activeValidationState = computed(() => {
  return syncProvider.value === 'webdav' ? webdavValidationState.value : gistValidationState.value
})

const syncIntervalOptions = [
  { value: 0, label: '无' },
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' },
  { value: 120, label: '2 小时' },
  { value: 180, label: '3 小时' },
]

const providerTitle = computed(() => {
  return syncProvider.value === 'webdav' ? 'WebDAV Sync' : 'Gist Sync'
})

const providerSubtitle = computed(() => {
  return syncProvider.value === 'webdav' ? '书签 WebDAV 同步' : '书签云同步'
})

const syncIntervalLabel = computed(() => {
  return syncIntervalOptions.find(item => item.value === syncIntervalMinutes.value)?.label ?? '未设置'
})

const recentSyncLogs = computed(() => {
  if (!Array.isArray(syncLogs.value))
    return []
  return [...syncLogs.value]
    .sort((a, b) => {
      const ta = Number(new Date(a.time))
      const tb = Number(new Date(b.time))
      return Number.isNaN(tb - ta) ? 0 : tb - ta
    })
    .slice(0, 5)
})

const syncLogCount = computed(() => Array.isArray(syncLogs.value) ? syncLogs.value.length : 0)

function openSyncLog() {
  syncLogVisible.value = true
}

function clearSyncLogs() {
  syncLogs.value = []
  showToast('日志已清空', 'success')
}

function formatSyncLogTime(time: string) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime()))
    return time
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function formatSyncLogTitle(entry: SyncLogEntry) {
  const providerLabel = entry.provider === 'webdav' ? 'WebDAV' : 'Gist'
  const modeLabel = entry.mode === 'upload' ? '推送' : '拉取'
  const statusLabel = entry.status === 'ok' ? '成功' : '失败'
  return `${providerLabel} · ${modeLabel} · ${statusLabel}`
}

function formatSyncLogSummary(entry: SyncLogEntry) {
  if (entry.mode === 'download')
    return entry.summary.replace(/\s*\(云端.*\)\s*$/, '')
  return entry.summary
}

function isPortClosedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('back/forward cache')
    || message.includes('message channel is closed')
    || message.includes('Could not establish connection')
    || message.includes('Receiving end does not exist')
}

async function safeSendMessage(...args: Parameters<typeof sendMessage>) {
  try {
    return await sendMessage(...args)
  }
  catch (error) {
    if (!isPortClosedError(error))
      console.error(error)
    return { ok: false, error: '消息通道已关闭' }
  }
}

function toggleIntervalDropdown() {
  intervalDropdownOpen.value = !intervalDropdownOpen.value
  if (intervalDropdownOpen.value)
    void positionIntervalDropdown()
}

function selectInterval(value: number) {
  syncIntervalMinutes.value = value
  intervalDropdownOpen.value = false
}

function handleIntervalDropdownOutside(event: MouseEvent) {
  const target = event.target as Node | null
  if (!intervalDropdownRef.value || !target)
    return
  if (!intervalDropdownRef.value.contains(target))
    intervalDropdownOpen.value = false
}

function handleIntervalEsc(event: KeyboardEvent) {
  if (event.key === 'Escape')
    intervalDropdownOpen.value = false
}

async function positionIntervalDropdown() {
  await nextTick()
  const trigger = intervalDropdownTriggerRef.value
  const menu = intervalDropdownMenuRef.value
  if (!trigger || !menu) {
    requestAnimationFrame(() => {
      if (intervalDropdownOpen.value)
        void positionIntervalDropdown()
    })
    return
  }
  const rect = trigger.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  // 先让菜单实际渲染以获取高度
  const menuHeight = Math.min(menu.scrollHeight, 260)
  let top = rect.bottom + 8
  if (top + menuHeight > viewportHeight - 8)
    top = Math.max(8, rect.top - 8 - menuHeight)

  let left = rect.left
  const maxLeft = Math.max(8, viewportWidth - rect.width - 8)
  left = Math.min(Math.max(8, left), maxLeft)

  intervalDropdownStyle.value = {
    top: `${top}px`,
    left: `${left}px`,
    width: `${rect.width}px`,
  }
}

function handleIntervalResize() {
  if (intervalDropdownOpen.value)
    void positionIntervalDropdown()
}

function handleIntervalScroll() {
  if (intervalDropdownOpen.value)
    void positionIntervalDropdown()
}

function setScrollLock(locked: boolean) {
  document.documentElement.style.overflow = locked ? 'hidden' : ''
  document.body.style.overflow = locked ? 'hidden' : ''
}

async function resolveTabId() {
  if (currentTabId.value !== null)
    return
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    const tabId = tabs[0]?.id
    if (typeof tabId === 'number')
      currentTabId.value = tabId
  }
  catch {
    // ignore if tab query fails
  }
}

async function notifySidepanelOpen() {
  await resolveTabId()
  if (currentTabId.value === null)
    return
  void safeSendMessage('sidepanel-visibility', { open: true, tabId: currentTabId.value }, 'background')
}

async function notifySidepanelClosed() {
  await resolveTabId()
  if (currentTabId.value === null)
    return
  void safeSendMessage('sidepanel-visibility', { open: false, tabId: currentTabId.value }, 'background')
}

function handleSidepanelHide() {
  void notifySidepanelClosed()
}

onMounted(() => {
  void notifySidepanelOpen()
  window.addEventListener('pagehide', handleSidepanelHide)
  window.addEventListener('beforeunload', handleSidepanelHide)
  window.addEventListener('click', handleIntervalDropdownOutside)
  window.addEventListener('keydown', handleIntervalEsc)
  window.addEventListener('resize', handleIntervalResize)
  window.addEventListener('scroll', handleIntervalScroll, { passive: true })
  watch(
    () => exportModalVisible.value || webdavVersionsVisible.value || syncLogVisible.value,
    locked => setScrollLock(locked),
    { immediate: true },
  )
  syncLogsReady.then(() => {
    syncLogReady.value = true
  }).catch((error) => {
    syncLogReady.value = true
    syncLogError.value = error instanceof Error ? error.message : String(error)
    console.error('[GistSync][Sidepanel] syncLogs load error', error)
  })
  watch(syncLogs, () => {
    syncLogReady.value = true
  }, { immediate: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', handleSidepanelHide)
  window.removeEventListener('beforeunload', handleSidepanelHide)
  void notifySidepanelClosed()
  window.removeEventListener('click', handleIntervalDropdownOutside)
  window.removeEventListener('keydown', handleIntervalEsc)
  window.removeEventListener('resize', handleIntervalResize)
  window.removeEventListener('scroll', handleIntervalScroll)
  setScrollLock(false)
})

// 检测同步范围是否有未保存的变化
const hasUnsavedChanges = computed(() => {
  if (selectedFolderIds.value.size !== savedFolderIds.value.size)
    return true
  for (const id of selectedFolderIds.value) {
    if (!savedFolderIds.value.has(id))
      return true
  }
  return false
})

// Toast 通知
const toastVisible = ref(false)
const toastMessage = ref('')
const toastType = ref<'success' | 'error'>('success')
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(message: string, type: 'success' | 'error' = 'success') {
  if (toastTimer)
    clearTimeout(toastTimer)
  toastMessage.value = message
  toastType.value = type
  toastVisible.value = true
  toastTimer = setTimeout(() => {
    toastVisible.value = false
  }, 3000)
}

// 计算选中和排除的书签数量
// node.count 是该文件夹及其所有子文件夹的书签总数
function countSelectedBookmarks(nodes: FolderNode[], selected: Set<string>): { selected: number, total: number } {
  let selectedCount = 0
  let totalCount = 0

  for (const node of nodes) {
    // 计算子文件夹的书签总数
    let childrenCount = 0
    for (const child of node.children) {
      childrenCount += child.count
    }

    // 该文件夹直接包含的书签数 = node.count - 子文件夹书签总数
    const directCount = node.count - childrenCount
    totalCount += directCount
    if (selected.has(node.id))
      selectedCount += directCount

    // 递归处理子文件夹
    if (node.children.length > 0) {
      const childResult = countSelectedBookmarks(node.children, selected)
      selectedCount += childResult.selected
      totalCount += childResult.total
    }
  }

  return { selected: selectedCount, total: totalCount }
}

const bookmarkStats = computed(() => {
  const result = countSelectedBookmarks(folderTree.value, savedFolderIds.value)
  const excluded = result.total - result.selected
  const coverage = result.total > 0 ? Math.round((result.selected / result.total) * 100) : 0
  return {
    selected: result.selected,
    total: result.total,
    excluded,
    coverage,
  }
})

// 验证间隔时间（1小时）
const VALIDATION_INTERVAL = 60 * 60 * 1000
// 随机校验概率（10%）
const RANDOM_CHECK_RATE = 0.1

// 静默验证连接（不显示 toast，用于自动验证）
async function checkConnection(force = false) {
  if (!githubToken.value?.trim() || !gistId.value?.trim()) {
    gistValidationState.value = 'idle'
    connectionStatus.value = ''
    return
  }

  const now = Date.now()
  const lastTime = lastValidationTime.value || 0
  const timeSinceLastCheck = now - lastTime

  // 如果不是强制验证，检查是否需要重新验证
  if (!force) {
    // 如果之前验证成功
    if (connectionStatus.value === 'ok') {
      // 在有效期内，直接使用缓存状态
      if (timeSinceLastCheck < VALIDATION_INTERVAL) {
        gistValidationState.value = 'ok'
        // 随机校验（10%概率）
        if (Math.random() >= RANDOM_CHECK_RATE) {
          return
        }
      }
    }
    // 如果之前验证失败，短时间内不重复验证（1分钟）
    else if (connectionStatus.value === 'error' && timeSinceLastCheck < 60 * 1000) {
      gistValidationState.value = 'error'
      return
    }
  }

  gistValidationState.value = 'checking'

  try {
    const result = await safeSendMessage(
      'validate-gist-auth',
      {
        token: githubToken.value,
        gistId: gistId.value,
        fileName: gistFileName.value || 'bookmarks',
        autoCreate: false,
        createIfMissing: false,
      },
      'background',
    )

    const status = result.ok ? 'ok' : 'error'
    gistValidationState.value = status
    connectionStatus.value = status
    lastValidationTime.value = Date.now()
  }
  catch {
    gistValidationState.value = 'error'
    connectionStatus.value = 'error'
    lastValidationTime.value = Date.now()
  }
}

onMessage('sync-error', ({ data }) => {
  const message = typeof data?.message === 'string' ? data.message : '同步失败'
  showToast(message, 'error')
})

async function validateGistAuth() {
  gistValidationState.value = 'checking'

  // 设置默认文件名
  if (!gistFileName.value.trim()) {
    gistFileName.value = 'bookmarks'
  }

  try {
    const result = await safeSendMessage(
      'validate-gist-auth',
      {
        token: githubToken.value,
        gistId: gistId.value,
        fileName: gistFileName.value,
        autoCreate: true, // 自动创建文件
        createIfMissing: !gistId.value.trim(), // Gist ID 为空时自动创建
      },
      'background',
    )

    if (result.ok) {
      gistValidationState.value = 'ok'
      connectionStatus.value = 'ok'
      lastValidationTime.value = Date.now()
      if (result.gist?.id)
        gistId.value = result.gist.id
      if (result.createdGist)
        showToast('已创建新 Gist 并保存配置', 'success')
      else if (result.createdFile)
        showToast('已创建文件并保存配置', 'success')
      else
        showToast('配置已保存', 'success')
      return
    }

    gistValidationState.value = 'error'
    connectionStatus.value = 'error'
    lastValidationTime.value = Date.now()
    showToast(result.errors?.join('; ') || '保存失败', 'error')
  }
  catch (error) {
    gistValidationState.value = 'error'
    connectionStatus.value = 'error'
    lastValidationTime.value = Date.now()
    showToast(error instanceof Error ? error.message : '保存失败', 'error')
  }
}

// WebDAV 验证
const WEBDAV_VALIDATION_INTERVAL = 60 * 60 * 1000
const WEBDAV_RANDOM_CHECK_RATE = 0.1

async function checkWebdavConnection(force = false) {
  if (!webdavUrl.value?.trim()) {
    webdavValidationState.value = 'idle'
    webdavConnectionStatus.value = ''
    return
  }

  const now = Date.now()
  const lastTime = webdavLastValidationTime.value || 0
  const timeSinceLastCheck = now - lastTime

  if (!force) {
    if (webdavConnectionStatus.value === 'ok') {
      if (timeSinceLastCheck < WEBDAV_VALIDATION_INTERVAL) {
        webdavValidationState.value = 'ok'
        if (Math.random() >= WEBDAV_RANDOM_CHECK_RATE)
          return
      }
    }
    else if (webdavConnectionStatus.value === 'error' && timeSinceLastCheck < 60 * 1000) {
      webdavValidationState.value = 'error'
      return
    }
  }

  webdavValidationState.value = 'checking'

  try {
    const result = await safeSendMessage(
      'validate-webdav-auth',
      {
        url: webdavUrl.value,
        username: webdavUsername.value,
        password: webdavPassword.value,
      },
      'background',
    )

    const status = result.ok ? 'ok' : 'error'
    webdavValidationState.value = status
    webdavConnectionStatus.value = status
    webdavLastValidationTime.value = Date.now()
  }
  catch {
    webdavValidationState.value = 'error'
    webdavConnectionStatus.value = 'error'
    webdavLastValidationTime.value = Date.now()
  }
}

async function validateWebdavAuth() {
  webdavValidationState.value = 'checking'

  // 留空时由后台自动生成默认路径

  try {
    const result = await safeSendMessage(
      'validate-webdav-auth',
      {
        url: webdavUrl.value,
        username: webdavUsername.value,
        password: webdavPassword.value,
      },
      'background',
    )

    if (result.ok) {
      webdavValidationState.value = 'ok'
      webdavConnectionStatus.value = 'ok'
      webdavLastValidationTime.value = Date.now()
      if (result.missing)
        showToast('连接成功，文件不存在，将在首次同步时创建', 'success')
      else
        showToast('配置已保存', 'success')
      return
    }

    webdavValidationState.value = 'error'
    webdavConnectionStatus.value = 'error'
    webdavLastValidationTime.value = Date.now()
    showToast(result.errors?.join('; ') || '保存失败', 'error')
  }
  catch (error) {
    webdavValidationState.value = 'error'
    webdavConnectionStatus.value = 'error'
    webdavLastValidationTime.value = Date.now()
    showToast(error instanceof Error ? error.message : '保存失败', 'error')
  }
}

async function syncNow() {
  uploadState.value = 'syncing'

  try {
    const result = await safeSendMessage('sync-upload', undefined, 'background')
    if (result.ok) {
      uploadState.value = 'done'
      showToast(result.summary || '推送成功', 'success')
      return
    }

    uploadState.value = 'error'
    showToast(result.error || '推送失败', 'error')
  }
  catch (error) {
    uploadState.value = 'error'
    showToast(error instanceof Error ? error.message : '推送失败', 'error')
  }
}

async function downloadBookmarks(options?: { silent?: boolean }) {
  downloadState.value = 'syncing'

  try {
    const result = await safeSendMessage('sync-download', undefined, 'background')
    if (result.ok) {
      downloadState.value = 'done'
      if (!options?.silent)
        showToast(result.summary || '拉取成功', 'success')
      void loadFolderTree()
      return
    }

    downloadState.value = 'error'
    if (!options?.silent)
      showToast(result.error || '拉取失败', 'error')
  }
  catch (error) {
    downloadState.value = 'error'
    if (!options?.silent)
      showToast(error instanceof Error ? error.message : '拉取失败', 'error')
  }
}

async function autoPullOnOpen() {
  if (syncProvider.value === 'webdav') {
    if (!webdavUrl.value?.trim())
      return
  }
  else {
    if (!githubToken.value?.trim() || !gistId.value?.trim() || !gistFileName.value?.trim())
      return
  }

  await downloadBookmarks({ silent: true })
}

function handleDownloadClick() {
  if (syncProvider.value === 'webdav') {
    if (downloadClickTimer)
      clearTimeout(downloadClickTimer)
    downloadClickTimer = setTimeout(() => {
      downloadClickTimer = null
      void downloadBookmarks()
    }, 240)
    return
  }

  void downloadBookmarks()
}

async function loadWebdavVersions() {
  if (syncProvider.value !== 'webdav')
    return

  if (downloadClickTimer) {
    clearTimeout(downloadClickTimer)
    downloadClickTimer = null
  }

  webdavVersionsState.value = 'loading'
  webdavVersionsMessage.value = ''

  try {
    const result = await safeSendMessage('webdav-list-versions', undefined, 'background') as { ok: boolean, error?: string, versions?: Array<{ file: string, timestamp: string, count?: number }> }
    if (!result.ok) {
      webdavVersionsState.value = 'error'
      webdavVersionsMessage.value = result.error || '加载版本失败'
      return
    }

    webdavVersions.value = result.versions || []
    webdavVersionsState.value = 'idle'
  }
  catch (error) {
    webdavVersionsState.value = 'error'
    webdavVersionsMessage.value = error instanceof Error ? error.message : '加载版本失败'
  }
}

async function openWebdavVersions() {
  webdavVersionsVisible.value = true
  await loadWebdavVersions()
}

async function downloadWebdavVersion(file: string) {
  webdavVersionsVisible.value = false
  downloadState.value = 'syncing'

  try {
    const result = await safeSendMessage('webdav-download-version', { file }, 'background') as { ok: boolean, error?: string, summary?: string }
    if (result.ok) {
      downloadState.value = 'done'
      showToast(result.summary || '回退成功', 'success')
      void loadFolderTree()
      return
    }

    downloadState.value = 'error'
    showToast(result.error || '回退失败', 'error')
  }
  catch (error) {
    downloadState.value = 'error'
    showToast(error instanceof Error ? error.message : '回退失败', 'error')
  }
}

async function deleteWebdavVersion(file: string) {
  try {
    const result = await safeSendMessage('webdav-delete-version', { file }, 'background') as { ok: boolean, error?: string }
    if (!result.ok) {
      showToast(result.error || '删除失败', 'error')
      return
    }

    showToast('已删除版本', 'success')
    await loadWebdavVersions()
  }
  catch (error) {
    showToast(error instanceof Error ? error.message : '删除失败', 'error')
  }
}

function parseWebdavVersionLabel(item: { file: string, timestamp: string }) {
  const match = item.file.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-\d+Z\.json$/)
  if (match) {
    const [, , month, day, hour, minute] = match
    return `${month}/${day} ${hour}:${minute}`
  }

  const date = new Date(item.timestamp)
  if (!Number.isNaN(date.getTime())) {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${month}/${day} ${hour}:${minute}`
  }

  return item.timestamp
}

function formatWebdavFileLabel(item: { file: string, seq?: number }) {
  if (typeof item.seq === 'number')
    return `bookmark #${item.seq}`
  const match = item.file.match(/^bookmark-(\d+)\.json$/)
  if (match)
    return `bookmark #${match[1]}`
  if (item.file.endsWith('.json'))
    return item.file.replace(/\.json$/, '')
  return item.file
}

function exportConfig() {
  const config = {
    syncProvider: syncProvider.value,
    githubToken: githubToken.value,
    gistId: gistId.value,
    gistFileName: gistFileName.value,
    webdavUrl: webdavUrl.value,
    webdavUsername: webdavUsername.value,
    webdavPassword: webdavPassword.value,
    syncIntervalMinutes: syncIntervalMinutes.value,
    syncFolderSelection: Array.from(selectedFolderIds.value),
  }
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'bookmark-sync-config.json'
  a.click()
  URL.revokeObjectURL(url)
  showToast('配置已导出', 'success')
}

function importConfig() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file)
      return
    try {
      const text = await file.text()
      const config = JSON.parse(text)
      if (config.syncProvider === 'webdav' || config.syncProvider === 'gist')
        syncProvider.value = config.syncProvider
      if (config.githubToken)
        githubToken.value = config.githubToken
      if (config.gistId)
        gistId.value = config.gistId
      if (config.gistFileName)
        gistFileName.value = config.gistFileName
      if (config.webdavUrl)
        webdavUrl.value = config.webdavUrl
      if (config.webdavUsername)
        webdavUsername.value = config.webdavUsername
      if (config.webdavPassword)
        webdavPassword.value = config.webdavPassword
      if (typeof config.syncIntervalMinutes === 'number')
        syncIntervalMinutes.value = config.syncIntervalMinutes
      if (Array.isArray(config.syncFolderSelection)) {
        syncFolderSelection.value = config.syncFolderSelection
        selectedFolderIds.value = new Set(config.syncFolderSelection)
      }
      const storagePayload: Record<string, unknown> = {}
      if (config.syncProvider === 'webdav' || config.syncProvider === 'gist')
        storagePayload['sync-provider'] = config.syncProvider
      if (config.githubToken)
        storagePayload['github-token'] = config.githubToken
      if (config.gistId)
        storagePayload['gist-id'] = config.gistId
      if (config.gistFileName)
        storagePayload['gist-file-name'] = config.gistFileName
      if (config.webdavUrl)
        storagePayload['webdav-url'] = config.webdavUrl
      if (config.webdavUsername)
        storagePayload['webdav-username'] = config.webdavUsername
      if (config.webdavPassword)
        storagePayload['webdav-password'] = config.webdavPassword
      if (typeof config.syncIntervalMinutes === 'number')
        storagePayload['sync-interval-minutes'] = config.syncIntervalMinutes
      if (Array.isArray(config.syncFolderSelection))
        storagePayload['sync-folder-selection'] = config.syncFolderSelection
      if (Object.keys(storagePayload).length > 0)
        await browser.storage.local.set(storagePayload)
      if (typeof config.syncIntervalMinutes === 'number')
        void safeSendMessage('refresh-sync-interval', { minutes: config.syncIntervalMinutes }, 'background')
      await handleImportSyncFlow()
    }
    catch {
      showToast('配置文件格式错误', 'error')
    }
  }
  input.click()
}

function collectAllFolderIds(nodes: FolderNode[]): string[] {
  const result: string[] = []
  const stack = [...nodes]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node)
      continue
    result.push(node.id)
    if (node.children?.length)
      stack.push(...node.children)
  }
  return result
}

async function handleImportSyncFlow() {
  if (syncProvider.value === 'webdav') {
    if (!webdavUrl.value?.trim()) {
      showToast('配置已导入', 'success')
      return
    }
  }
  else if (!githubToken.value?.trim() || !gistId.value?.trim() || !gistFileName.value?.trim()) {
    showToast('配置已导入', 'success')
    return
  }

  await downloadBookmarks({ silent: true })
  if (syncProvider.value === 'webdav')
    void checkWebdavConnection(true)
  else
    void checkConnection(true)
  await loadFolderTree()
  const allIds = collectAllFolderIds(folderTree.value)
  selectedFolderIds.value = new Set(allIds)
  syncFolderSelection.value = allIds
  savedFolderIds.value = new Set(allIds)
  await browser.storage.local.set({ 'sync-folder-selection': allIds })
  showToast('配置已导入并刷新同步范围', 'success')
}

function showExportModal() {
  exportModalVisible.value = true
}

async function doExportBookmarks() {
  exportModalVisible.value = false
  try {
    const result = await safeSendMessage('export-bookmarks', { includeExcluded: exportIncludeExcluded.value }, 'background') as { ok: boolean, error?: string, data?: unknown, count?: number }
    if (!result.ok) {
      showToast(result.error || '导出失败', 'error')
      return
    }

    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const suffix = exportIncludeExcluded.value ? 'full' : 'selected'
    a.download = `bookmarks-${suffix}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast(`已导出 ${result.count} 条书签`, 'success')
  }
  catch (error) {
    showToast(error instanceof Error ? error.message : '导出失败', 'error')
  }
}

// 书签导入
function importBookmarks() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file)
      return
    try {
      const text = await file.text()
      const data = JSON.parse(text)

      // 支持两种格式：直接的书签数组或带 bookmarks 字段的对象
      const bookmarks = Array.isArray(data) ? data : data.bookmarks
      if (!Array.isArray(bookmarks)) {
        showToast('无效的书签文件格式', 'error')
        return
      }

      const result = await safeSendMessage('import-bookmarks', { bookmarks }, 'background') as { ok: boolean, error?: string, count?: number }
      if (result.ok) {
        showToast(`已导入 ${result.count} 条书签`, 'success')
        void loadFolderTree()
      }
      else {
        showToast(result.error || '导入失败', 'error')
      }
    }
    catch {
      showToast('书签文件格式错误', 'error')
    }
  }
  input.click()
}

function collectFolderIds(nodes: FolderNode[]) {
  const ids: string[] = []
  for (const node of nodes) {
    ids.push(node.id)
    if (node.children.length)
      ids.push(...collectFolderIds(node.children))
  }
  return ids
}

function normalizeSelection(nodes: FolderNode[], selected: Set<string>, parentSelected = true) {
  for (const node of nodes) {
    const isSelected = parentSelected && selected.has(node.id)
    if (!isSelected)
      selected.delete(node.id)
    if (node.children.length)
      normalizeSelection(node.children, selected, isSelected)
  }
}

function setNodeSelection(node: FolderNode, checked: boolean) {
  if (checked)
    selectedFolderIds.value.add(node.id)
  else
    selectedFolderIds.value.delete(node.id)

  for (const child of node.children)
    setNodeSelection(child, checked)
}

function toggleFolder(node: FolderNode, checked: boolean) {
  setNodeSelection(node, checked)
  selectedFolderIds.value = new Set(selectedFolderIds.value)
}

async function loadFolderTree() {
  folderTreeState.value = 'loading'
  folderTreeMessage.value = ''

  try {
    const result = await safeSendMessage('get-bookmark-folders', undefined, 'background')
    if (!result.ok) {
      folderTreeState.value = 'error'
      folderTreeMessage.value = result.error || 'Failed to load bookmarks'
      return
    }

    folderTree.value = (result.tree as FolderNode[]) || []
    const stored = Array.isArray(syncFolderSelection.value) ? syncFolderSelection.value : []
    const selected = new Set<string>(stored)
    if (selected.size === 0) {
      for (const id of collectFolderIds(folderTree.value))
        selected.add(id)
    }
    normalizeSelection(folderTree.value, selected, true)
    selectedFolderIds.value = selected
    savedFolderIds.value = new Set(selected) // 初始化已保存的选择
    folderTreeState.value = 'idle'
  }
  catch (error) {
    folderTreeState.value = 'error'
    folderTreeMessage.value = error instanceof Error ? error.message : 'Failed to load bookmarks'
  }
}

async function saveFolderSelection() {
  const selection = Array.from(selectedFolderIds.value)
  syncFolderSelection.value = selection
  savedFolderIds.value = new Set(selection)
  await browser.storage.local.set({ 'sync-folder-selection': JSON.stringify(selection) })
  void triggerUploadAfterSave()
}

async function triggerUploadAfterSave() {
  if (syncProvider.value === 'webdav') {
    if (!webdavUrl.value?.trim()) {
      showToast('同步范围已保存', 'success')
      return
    }
  }
  else {
    if (!githubToken.value?.trim() || !gistId.value?.trim() || !gistFileName.value?.trim()) {
      showToast('同步范围已保存', 'success')
      return
    }
  }

  try {
    uploadState.value = 'syncing'
    const result = await safeSendMessage('sync-upload', undefined, 'background')
    if (result.ok) {
      uploadState.value = 'done'
      showToast(result.summary || '同步范围已保存并推送', 'success')
      return
    }
    uploadState.value = 'error'
    showToast(result.error || '同步范围已保存，但推送失败', 'error')
  }
  catch (error) {
    uploadState.value = 'error'
    showToast(error instanceof Error ? error.message : '同步范围已保存，但推送失败', 'error')
  }
}

onMounted(() => {
  void loadFolderTree()
  // 等待所有配置数据加载完成后恢复连接状态
  Promise.all([githubTokenReady, gistIdReady, connectionStatusReady]).then(() => {
    // 恢复之前保存的连接状态
    if (connectionStatus.value === 'ok') {
      gistValidationState.value = 'ok'
    }
    else if (connectionStatus.value === 'error') {
      gistValidationState.value = 'error'
    }
    // 如果有配置但没有连接状态，进行一次验证
    else if (githubToken.value?.trim() && gistId.value?.trim()) {
      void checkConnection()
    }
  })

  Promise.all([webdavConnectionStatusReady, webdavUrlReady]).then(() => {
    if (webdavConnectionStatus.value === 'ok') {
      webdavValidationState.value = 'ok'
    }
    else if (webdavConnectionStatus.value === 'error') {
      webdavValidationState.value = 'error'
    }
    else if (webdavUrl.value?.trim()) {
      void checkWebdavConnection()
    }
  })

  syncProviderReady.then(() => {
    if (syncProvider.value !== 'gist' && syncProvider.value !== 'webdav')
      syncProvider.value = 'gist'
  })

  Promise.all([syncProviderReady, githubTokenReady, gistIdReady, webdavUrlReady, syncFolderSelectionReady, syncIntervalMinutesReady]).then(() => {
    void autoPullOnOpen()
  })
})

watch(syncProvider, (nextProvider) => {
  if (nextProvider === 'webdav') {
    if (webdavConnectionStatus.value === '' && webdavUrl.value?.trim())
      void checkWebdavConnection()
  }
  else {
    if (connectionStatus.value === '' && githubToken.value?.trim() && gistId.value?.trim())
      void checkConnection()
  }
})

watch(intervalDropdownOpen, (open) => {
  if (open)
    void positionIntervalDropdown()
})
</script>

<template>
  <main class="panel">
    <header class="panel__header">
      <div class="panel__brand">
        <div class="panel__logo">
          <ph-cloud-arrow-up class="panel__logo-icon" />
        </div>
        <div>
          <h1 class="panel__title">
            {{ providerTitle }}
          </h1>
          <p class="panel__subtitle">
            {{ providerSubtitle }}
          </p>
        </div>
      </div>
      <div class="panel__status" :data-state="activeValidationState">
        <span class="panel__status-dot" />
        <span v-if="activeValidationState === 'checking'">校验中</span>
        <span v-else-if="activeValidationState === 'ok'">已连接</span>
        <span v-else-if="activeValidationState === 'error'">连接失败</span>
        <span v-else>未连接</span>
      </div>
    </header>

    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">已选书签</span>
        <span class="stats__value">
          <span class="stats__highlight">{{ bookmarkStats.selected }}</span>
          <span class="stats__total">/ {{ bookmarkStats.total }}</span>
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已排除书签</span>
        <span class="stats__value">{{ bookmarkStats.excluded }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">覆盖率</span>
        <span class="stats__value stats__value--accent">{{ bookmarkStats.coverage }}%</span>
      </div>
    </div>

    <section class="card">
      <div class="card__header">
        <ph-plugs-connected class="card__icon" />
        <h2 class="card__title">
          连接配置
        </h2>
      </div>
      <div class="provider-tabs">
        <button
          class="provider-tab"
          :class="{ 'is-active': syncProvider === 'gist' }"
          @click="syncProvider = 'gist'"
        >
          Gist
        </button>
        <button
          class="provider-tab"
          :class="{ 'is-active': syncProvider === 'webdav' }"
          @click="syncProvider = 'webdav'"
        >
          WebDAV
        </button>
      </div>

      <div v-if="syncProvider === 'gist'" class="provider-form">
        <div class="field">
          <label class="field__label">
            <ph-key class="field__icon" />
            GitHub Token
          </label>
          <input v-model="githubToken" type="password" placeholder="ghp_xxxxxxxxxxxx" class="input">
        </div>
        <div class="field">
          <label class="field__label">
            <ph-identification-badge class="field__icon" />
            Gist ID
          </label>
          <input v-model="gistId" placeholder="留空可自动创建" class="input">
        </div>
        <div class="field">
          <label class="field__label">
            <ph-file-text class="field__icon" />
            文件名
          </label>
          <input v-model="gistFileName" placeholder="bookmarks" class="input">
        </div>
        <div class="field">
          <label class="field__label">
            <ph-timer class="field__icon" />
            自动拉取间隔
            <button class="link-ghost" type="button" @click.stop="openSyncLog">
              查看日志 <span v-if="syncLogCount">({{ syncLogCount }})</span>
            </button>
          </label>
          <div ref="intervalDropdownRef" class="select-input" :class="{ 'is-open': intervalDropdownOpen }">
            <button
              ref="intervalDropdownTriggerRef"
              type="button"
              class="select-input__trigger input"
              :aria-expanded="intervalDropdownOpen"
              @click.stop="toggleIntervalDropdown"
            >
              <span class="select-input__value">{{ syncIntervalLabel }}</span>
              <ph-caret-down class="select-input__arrow" />
            </button>
            <Transition name="fade">
              <teleport to="body">
                <div
                  v-if="intervalDropdownOpen"
                  ref="intervalDropdownMenuRef"
                  class="select-menu"
                  role="listbox"
                  :style="intervalDropdownStyle"
                >
                  <button
                    v-for="option in syncIntervalOptions"
                    :key="option.value"
                    type="button"
                    class="select-option"
                    :class="{ 'is-active': option.value === syncIntervalMinutes }"
                    role="option"
                    :aria-selected="option.value === syncIntervalMinutes"
                    @click.stop="selectInterval(option.value)"
                  >
                    <span>{{ option.label }}</span>
                    <ph-check v-if="option.value === syncIntervalMinutes" class="select-option__check" />
                  </button>
                </div>
              </teleport>
            </Transition>
          </div>
        </div>
        <button class="btn btn--primary btn--input" :disabled="gistValidationState === 'checking'" @click="validateGistAuth">
          <ph-floppy-disk v-if="gistValidationState !== 'checking'" class="btn__icon" />
          <ph-circle-notch v-else class="btn__icon btn__icon--spin" />
          {{ gistValidationState === 'checking' ? '保存中…' : '保存配置' }}
        </button>
      </div>

      <div v-else class="provider-form">
        <div class="field">
          <label class="field__label">
            <ph-link class="field__icon" />
            WebDAV 地址
          </label>
          <input v-model="webdavUrl" placeholder="https://dav.example.com/remote.php/dav/files/user/" class="input">
        </div>
        <div class="field">
          <label class="field__label">
            <ph-user class="field__icon" />
            用户名
          </label>
          <input v-model="webdavUsername" placeholder="可选" class="input">
        </div>
        <div class="field">
          <label class="field__label">
            <ph-key class="field__icon" />
            密码
          </label>
          <input v-model="webdavPassword" type="password" placeholder="可选" class="input">
        </div>
        <div class="field">
          <label class="field__label">
            <ph-timer class="field__icon" />
            自动拉取间隔
            <button class="link-ghost" type="button" @click.stop="openSyncLog">
              查看日志 <span v-if="syncLogCount">({{ syncLogCount }})</span>
            </button>
          </label>
          <div ref="intervalDropdownRef" class="select-input" :class="{ 'is-open': intervalDropdownOpen }">
            <button
              ref="intervalDropdownTriggerRef"
              type="button"
              class="select-input__trigger input"
              :aria-expanded="intervalDropdownOpen"
              @click.stop="toggleIntervalDropdown"
            >
              <span class="select-input__value">{{ syncIntervalLabel }}</span>
              <ph-caret-down class="select-input__arrow" />
            </button>
            <Transition name="fade">
              <teleport to="body">
                <div
                  v-if="intervalDropdownOpen"
                  ref="intervalDropdownMenuRef"
                  class="select-menu"
                  role="listbox"
                  :style="intervalDropdownStyle"
                >
                  <button
                    v-for="option in syncIntervalOptions"
                    :key="option.value"
                    type="button"
                    class="select-option"
                    :class="{ 'is-active': option.value === syncIntervalMinutes }"
                    role="option"
                    :aria-selected="option.value === syncIntervalMinutes"
                    @click.stop="selectInterval(option.value)"
                  >
                    <span>{{ option.label }}</span>
                    <ph-check v-if="option.value === syncIntervalMinutes" class="select-option__check" />
                  </button>
                </div>
              </teleport>
            </Transition>
          </div>
        </div>
        <button class="btn btn--primary btn--input" :disabled="webdavValidationState === 'checking'" @click="validateWebdavAuth">
          <ph-floppy-disk v-if="webdavValidationState !== 'checking'" class="btn__icon" />
          <ph-circle-notch v-else class="btn__icon btn__icon--spin" />
          {{ webdavValidationState === 'checking' ? '保存中…' : '保存配置' }}
        </button>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <ph-squares-four class="card__icon" />
        <h2 class="card__title">
          快捷操作
        </h2>
      </div>
      <div class="action-grid">
        <button class="action-tile action-tile--blue" @click="importConfig">
          <span class="action-tile__icon"><ph-download-simple /></span>
          <span class="action-tile__label">导入配置</span>
        </button>
        <button class="action-tile action-tile--green" :disabled="!githubToken?.trim() && !webdavUrl?.trim()" @click="exportConfig">
          <span class="action-tile__icon"><ph-upload-simple /></span>
          <span class="action-tile__label">导出配置</span>
        </button>
        <button
          class="action-tile action-tile--cyan"
          :disabled="downloadState === 'syncing' || activeValidationState !== 'ok'"
          @click="handleDownloadClick"
          @dblclick="openWebdavVersions"
        >
          <span class="action-tile__icon">
            <ph-cloud-arrow-down v-if="downloadState !== 'syncing'" />
            <ph-circle-notch v-else class="btn__icon--spin" />
          </span>
          <span class="action-tile__label">拉取云端</span>
        </button>
        <button class="action-tile action-tile--purple" :disabled="uploadState === 'syncing' || activeValidationState !== 'ok'" @click="syncNow">
          <span class="action-tile__icon">
            <ph-cloud-arrow-up v-if="uploadState !== 'syncing'" />
            <ph-circle-notch v-else class="btn__icon--spin" />
          </span>
          <span class="action-tile__label">推送云端</span>
        </button>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <ph-bookmarks class="card__icon" />
        <h2 class="card__title">
          书签管理
        </h2>
      </div>
      <div class="action-grid">
        <button class="action-tile action-tile--teal" @click="importBookmarks">
          <span class="action-tile__icon"><ph-file-arrow-down /></span>
          <span class="action-tile__label">导入书签</span>
        </button>
        <button class="action-tile action-tile--orange" @click="showExportModal">
          <span class="action-tile__icon"><ph-file-arrow-up /></span>
          <span class="action-tile__label">导出书签</span>
        </button>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <ph-folder-open class="card__icon" />
        <h2 class="card__title">
          同步范围
        </h2>
        <button class="btn btn--ghost" :disabled="folderTreeState === 'loading'" @click="loadFolderTree">
          <ph-arrows-clockwise class="btn__icon" :class="{ 'btn__icon--spin': folderTreeState === 'loading' }" />
        </button>
        <button class="btn btn--ghost" @click="saveFolderSelection">
          <ph-floppy-disk class="btn__icon" />
          保存
          <span v-if="hasUnsavedChanges" class="unsaved-dot" />
        </button>
      </div>
      <p class="card__hint">
        选择需要同步的书签文件夹
      </p>
      <div v-if="folderTreeState === 'loading' && folderTree.length === 0" class="tree-loading">
        <ph-circle-notch class="tree-loading__icon" />
        <span>加载书签…</span>
      </div>
      <div v-else-if="folderTreeState === 'error'" class="message" data-state="error">
        {{ folderTreeMessage }}
      </div>
      <div v-else class="tree-container" :class="{ 'tree-container--loading': folderTreeState === 'loading' }">
        <FolderTree
          :nodes="folderTree"
          :selected-ids="Array.from(selectedFolderIds)"
          @toggle="toggleFolder"
        />
      </div>
    </section>

    <!-- Toast 通知 -->
    <Transition name="toast">
      <div v-if="toastVisible" class="toast" :class="[`toast--${toastType}`]">
        <ph-check-circle v-if="toastType === 'success'" class="toast__icon" />
        <ph-warning-circle v-else class="toast__icon" />
        <span class="toast__message">{{ toastMessage }}</span>
      </div>
    </Transition>

    <!-- 导出书签弹窗 -->
    <Transition name="modal">
      <div v-if="exportModalVisible" class="modal-overlay" @click.self="exportModalVisible = false">
        <div class="modal">
          <div class="modal__header">
            <ph-file-arrow-up class="modal__icon" />
            <h3 class="modal__title">
              导出书签
            </h3>
          </div>
          <div class="modal__body">
            <label class="radio-option">
              <input v-model="exportIncludeExcluded" type="radio" :value="true" class="radio-option__input">
              <span class="radio-option__mark" />
              <span class="radio-option__content">
                <span class="radio-option__label">导出全部书签</span>
                <span class="radio-option__hint">包含所有书签，共 {{ bookmarkStats.total }} 条</span>
              </span>
            </label>
            <label class="radio-option">
              <input v-model="exportIncludeExcluded" type="radio" :value="false" class="radio-option__input">
              <span class="radio-option__mark" />
              <span class="radio-option__content">
                <span class="radio-option__label">仅导出已选书签</span>
                <span class="radio-option__hint">排除未选中的文件夹，共 {{ bookmarkStats.selected }} 条</span>
              </span>
            </label>
          </div>
          <div class="modal__footer">
            <button class="btn btn--ghost" @click="exportModalVisible = false">
              取消
            </button>
            <button class="btn btn--primary" @click="doExportBookmarks">
              导出
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- WebDAV 历史版本 -->
    <Transition name="modal">
      <div v-if="webdavVersionsVisible" class="modal-overlay" @click.self="webdavVersionsVisible = false">
        <div class="modal">
          <div class="modal__header">
            <ph-clock-counter-clockwise class="modal__icon" />
            <h3 class="modal__title">
              历史版本
            </h3>
          </div>
          <div class="modal__body">
            <div v-if="webdavVersionsState === 'loading' && webdavVersions.length === 0" class="tree-loading">
              <ph-circle-notch class="tree-loading__icon" />
              <span>加载版本…</span>
            </div>
            <div v-else-if="webdavVersionsState === 'error'" class="message" data-state="error">
              {{ webdavVersionsMessage }}
            </div>
            <div v-else-if="webdavVersions.length === 0" class="message" data-state="info">
              暂无历史版本
            </div>
            <div v-else class="version-list">
              <div v-if="webdavVersionsState === 'loading'" class="version-loading">
                <ph-circle-notch class="tree-loading__icon" />
                <span>刷新中…</span>
              </div>
              <div v-for="item in webdavVersions" :key="item.file" class="version-item">
                <div class="version-meta">
                  <div class="version-time">
                    {{ parseWebdavVersionLabel(item) }}
                    <button class="btn btn--danger-inline" @click="deleteWebdavVersion(item.file)">
                      <ph-trash class="btn__icon" />
                      删除
                    </button>
                  </div>
                  <div class="version-meta-row">
                    <span class="version-name">{{ formatWebdavFileLabel(item) }}</span>
                    <span v-if="typeof item.count === 'number'" class="version-count">{{ item.count }} 条</span>
                  </div>
                </div>
                <div class="version-actions">
                  <button class="btn btn--rollback" @click="downloadWebdavVersion(item.file)">
                    <ph-clock-counter-clockwise class="btn__icon" />
                    回退
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="modal__footer">
            <button class="btn btn--ghost" @click="webdavVersionsVisible = false">
              关闭
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 同步日志 -->
    <Transition name="modal">
      <div v-if="syncLogVisible" class="modal-overlay" @click.self="syncLogVisible = false">
        <div class="modal">
          <div class="modal__header">
            <ph-list-bullets class="modal__icon" />
            <h3 class="modal__title">
              同步日志
            </h3>
          </div>
          <div class="modal__body">
            <div v-if="!syncLogReady" class="tree-loading">
              <ph-circle-notch class="tree-loading__icon" />
              <span>加载日志…</span>
            </div>
            <div v-else-if="syncLogError" class="message" data-state="error">
              日志加载失败：{{ syncLogError }}
            </div>
            <div v-else-if="recentSyncLogs.length === 0" class="message" data-state="info">
              暂无同步记录
            </div>
            <div v-else class="sync-log-list">
              <div v-for="item in recentSyncLogs" :key="item.id" class="sync-log-item" :data-status="item.status">
                <div class="sync-log-main">
                  <div class="sync-log-title">
                    {{ formatSyncLogTitle(item) }}
                  </div>
                  <div class="sync-log-summary">
                    {{ formatSyncLogSummary(item) }}
                  </div>
                </div>
                <div class="sync-log-meta">
                  <span class="sync-log-badge" :data-mode="item.mode">{{ item.mode === 'upload' ? '推送' : '拉取' }}</span>
                  <span class="sync-log-time">
                    {{ formatSyncLogTime(item.time) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div class="modal__footer">
            <button class="btn btn--ghost btn--danger" :disabled="syncLogCount === 0" @click="clearSyncLogs">
              清空日志
            </button>
            <button class="btn btn--ghost" @click="syncLogVisible = false">
              关闭
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </main>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  background: #faf8f5;
  color: #1a1816;
}

:global(body) {
  --bg: #faf8f5;
  --bg-glass: rgba(255, 255, 255, 0.7);
  --ink: #1a1816;
  --ink-soft: #5c5650;
  --ink-muted: #9a918a;
  --card: rgba(255, 255, 255, 0.85);
  --card-border: rgba(0, 0, 0, 0.06);
  --input-bg: rgba(255, 255, 255, 0.9);
  --input-border: rgba(0, 0, 0, 0.08);
  --accent: #e85d3b;
  --accent-soft: rgba(232, 93, 59, 0.12);
  --success: #22a55b;
  --success-soft: rgba(34, 165, 91, 0.12);
  --danger: #dc3545;
  --danger-soft: rgba(220, 53, 69, 0.12);
}

@media (prefers-color-scheme: dark) {
  :global(html),
  :global(body),
  :global(#app) {
    background: #0f0f0f;
    color: #f5f3f0;
    color-scheme: dark;
  }

  :global(body) {
    --bg: #0f0f0f;
    --bg-glass: rgba(40, 40, 40, 0.9);
    --ink: #f5f3f0;
    --ink-soft: #d4cfc8;
    --ink-muted: #a09890;
    --card: rgba(32, 30, 28, 0.95);
    --card-border: rgba(255, 255, 255, 0.08);
    --input-bg: rgba(255, 255, 255, 0.06);
    --input-border: rgba(255, 255, 255, 0.12);
    --accent: #ff7a5c;
    --accent-soft: rgba(255, 122, 92, 0.18);
    --success: #4ade80;
    --success-soft: rgba(74, 222, 128, 0.18);
    --danger: #f87171;
    --danger-soft: rgba(248, 113, 113, 0.18);
  }
}

.panel {
  --bg: #faf8f5;
  --bg-glass: rgba(255, 255, 255, 0.7);
  --ink: #1a1816;
  --ink-soft: #5c5650;
  --ink-muted: #9a918a;
  --card: rgba(255, 255, 255, 0.85);
  --card-border: rgba(0, 0, 0, 0.06);
  --input-bg: rgba(255, 255, 255, 0.9);
  --input-border: rgba(0, 0, 0, 0.08);
  --accent: #e85d3b;
  --accent-soft: rgba(232, 93, 59, 0.12);
  --success: #22a55b;
  --success-soft: rgba(34, 165, 91, 0.12);
  --danger: #dc3545;
  --danger-soft: rgba(220, 53, 69, 0.12);

  height: 100vh;
  min-height: 100vh;
  padding: 18px 16px 28px;
  background:
    radial-gradient(ellipse at 0% 0%, rgba(232, 93, 59, 0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 100% 100%, rgba(232, 93, 59, 0.05) 0%, transparent 50%),
    var(--bg);
  font-family: 'Inter', 'SF Pro Display', -apple-system, sans-serif;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.panel::-webkit-scrollbar {
  width: 0;
  height: 0;
}

:global(html),
:global(body),
:global(#app) {
  height: 100%;
  overflow: hidden;
}

@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #0f0f0f;
    --bg-glass: rgba(40, 40, 40, 0.9);
    --ink: #f5f3f0;
    --ink-soft: #d4cfc8;
    --ink-muted: #a09890;
    --card: rgba(32, 30, 28, 0.95);
    --card-border: rgba(255, 255, 255, 0.08);
    --input-bg: rgba(255, 255, 255, 0.06);
    --input-border: rgba(255, 255, 255, 0.12);
    --accent: #ff7a5c;
    --accent-soft: rgba(255, 122, 92, 0.18);
    --success: #4ade80;
    --success-soft: rgba(74, 222, 128, 0.18);
    --danger: #f87171;
    --danger-soft: rgba(248, 113, 113, 0.18);
    background:
      radial-gradient(ellipse at 0% 0%, rgba(255, 122, 92, 0.12) 0%, transparent 50%),
      radial-gradient(ellipse at 100% 100%, rgba(255, 122, 92, 0.06) 0%, transparent 50%),
      var(--bg);
  }
}

/* Header */
.panel__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 4px;
}

.panel__brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel__logo {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--accent) 0%, #ff8a6a 100%);
  display: grid;
  place-items: center;
  box-shadow: 0 3px 8px rgba(232, 93, 59, 0.25);
}

.panel__logo-icon {
  font-size: 16px;
  color: white;
}

.panel__title {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.panel__subtitle {
  font-size: 10px;
  color: var(--ink-muted);
  margin: 2px 0 0;
}

.panel__status {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 16px;
  font-size: 10px;
  font-weight: 500;
  background: var(--bg-glass);
  border: 1px solid var(--card-border);
  backdrop-filter: blur(8px);
  color: var(--ink-muted);
}

.panel__status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-muted);
}

.panel__status[data-state="checking"] .panel__status-dot {
  background: var(--accent);
  animation: pulse 1s infinite;
}

.panel__status[data-state="ok"] {
  color: var(--success);
}

.panel__status[data-state="ok"] .panel__status-dot {
  background: var(--success);
}

.panel__status[data-state="error"] {
  color: var(--danger);
}

.panel__status[data-state="error"] .panel__status-dot {
  background: var(--danger);
}

/* Card */
.card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 14px;
  padding: 14px;
  backdrop-filter: blur(12px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: slideUp 0.3s ease-out backwards;
  overflow: visible;
}

.card:nth-child(2) { animation-delay: 0.05s; }
.card:nth-child(3) { animation-delay: 0.1s; }
.card:nth-child(4) { animation-delay: 0.15s; }

.card__header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.card__icon {
  font-size: 16px;
  color: var(--accent);
}

.card__title {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  flex: 1;
  color: var(--ink);
}

.card__hint {
  font-size: 11px;
  color: var(--ink-muted);
  margin: -2px 0 0;
}

.provider-tabs {
  display: flex;
  gap: 6px;
  padding: 4px;
  border-radius: 12px;
  background: var(--bg-glass);
  border: 1px solid var(--card-border);
}

.provider-tab {
  flex: 1;
  border: none;
  padding: 6px 10px;
  border-radius: 9px;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-muted);
  cursor: pointer;
  transition: background 180ms ease, color 180ms ease, box-shadow 180ms ease;
}

.provider-tab.is-active {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.04);
}

.provider-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: visible;
}

.version-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
  min-height: 44px;
}

.version-item {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--card-border);
  background: var(--bg-glass);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
}

.version-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.version-time {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  gap: 10px;
}

.version-meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--ink-muted);
  font-size: 11px;
}

.version-count {
  font-weight: 600;
  background: rgba(255, 255, 255, 0.06);
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.version-name {
  opacity: 0.9;
}

.version-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-direction: column;
}

.btn--danger-inline {
  padding: 4px 8px;
  font-size: 10px;
  border-radius: 8px;
  border: 1px dashed rgba(220, 53, 69, 0.5);
  color: var(--danger);
  background: transparent;
}

.btn--danger-inline:not(:disabled):hover {
  color: var(--danger);
  border-color: rgba(220, 53, 69, 0.8);
}

.version-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-muted);
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(3px);
  border-radius: 10px;
}

@media (prefers-color-scheme: dark) {
  .version-loading {
    background: rgba(12, 12, 12, 0.6);
  }
}

.sync-log-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sync-log-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  column-gap: 12px;
  row-gap: 6px;
  align-items: center;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--card-border);
  background: var(--bg-glass);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.02),
    0 10px 30px rgba(0, 0, 0, 0.18);
}

.sync-log-item[data-status="ok"] .sync-log-title {
  color: var(--success);
}

.sync-log-item[data-status="error"] {
  border-color: rgba(220, 53, 69, 0.4);
  background: linear-gradient(140deg, rgba(220, 53, 69, 0.12), rgba(255, 255, 255, 0.02));
}

.sync-log-item[data-status="error"] .sync-log-title {
  color: var(--danger);
}

.sync-log-main {
  display: contents;
}

.sync-log-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  grid-column: 1;
  grid-row: 1;
}

.sync-log-summary {
  font-size: 11px;
  color: var(--ink-muted);
  grid-column: 1;
  grid-row: 2;
}

.sync-log-meta {
  display: contents;
}

.sync-log-badge {
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--card-border);
  font-size: 10px;
  background: rgba(255, 255, 255, 0.06);
  line-height: 1.2;
  min-width: 40px;
  text-align: center;
  justify-self: end;
  grid-column: 2;
  grid-row: 1;
}

.sync-log-badge[data-mode="upload"] {
  color: var(--success);
  border-color: rgba(34, 165, 91, 0.4);
  background: rgba(34, 165, 91, 0.12);
}

.sync-log-badge[data-mode="download"] {
  color: var(--accent);
  border-color: rgba(232, 93, 59, 0.4);
  background: rgba(232, 93, 59, 0.12);
}

.sync-log-time {
  font-size: 11px;
  color: var(--ink-muted);
  white-space: nowrap;
  letter-spacing: 0.01em;
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  justify-self: end;
  grid-column: 2;
  grid-row: 2;
}

.btn--rollback {
  background: linear-gradient(135deg, #ff8866 0%, #ff6f45 100%);
  color: #fff;
  border: none;
  padding: 6px 10px;
  border-radius: 9px;
  box-shadow: 0 8px 18px rgba(255, 136, 102, 0.25);
}

.btn--danger-outline {
  background: transparent;
  color: var(--danger);
  border: 1px dashed rgba(220, 53, 69, 0.55);
  padding: 5px 10px;
  border-radius: 9px;
}

.btn--danger-outline:not(:disabled):hover {
  background: rgba(220, 53, 69, 0.12);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 6px 16px rgba(220, 53, 69, 0.25);
}

/* Field */
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow: visible;
}

.field__label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
}

.link-ghost {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  text-decoration: none;
}

.link-ghost:hover {
  text-decoration: none;
  color: var(--accent);
}

.field__icon {
  font-size: 13px;
  color: var(--ink-muted);
}

.input {
  padding: 9px 11px;
  border-radius: 9px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--ink);
  font-size: 12px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

select.input {
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--ink-muted) 50%),
    linear-gradient(135deg, var(--ink-muted) 50%, transparent 50%);
  background-position: calc(100% - 16px) calc(50% - 2px), calc(100% - 11px) calc(50% - 2px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 26px;
  background-color: var(--card);
  border-color: var(--card-border);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 6px 18px rgba(0, 0, 0, 0.15);
  cursor: pointer;
  color-scheme: light;
}

select.input option,
select.input optgroup {
  background: var(--card);
  color: var(--ink);
  padding: 6px 10px;
}

@media (prefers-color-scheme: dark) {
  select.input {
    color-scheme: dark;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 8px 24px rgba(0, 0, 0, 0.45);
  }
}

.select-input {
  position: relative;
}

.select-input__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  cursor: pointer;
}

.select-input__trigger:focus,
.select-input__trigger:focus-visible,
.select-input__trigger:active {
  box-shadow: none;
  border-color: var(--input-border);
}

.select-input__value {
  font-weight: 600;
}

.select-input__arrow {
  font-size: 14px;
  color: var(--ink-muted);
  transition: transform 0.15s ease;
}

.select-input.is-open .select-input__arrow {
  transform: rotate(180deg);
}

.select-menu {
  position: fixed;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02)), var(--card);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  padding: 6px;
  z-index: 999999;
  backdrop-filter: blur(12px);
  max-height: 260px;
  overflow: auto;
}

@media (prefers-color-scheme: dark) {
  .select-menu {
    background: linear-gradient(160deg, rgba(255, 122, 92, 0.08), rgba(255, 255, 255, 0.01)), var(--card);
  }
}

.select-option {
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ink);
  padding: 10px 12px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease, transform 0.1s ease;
}

.select-option:hover {
  background: var(--accent-soft);
}

.select-option.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: 0 4px 12px rgba(232, 93, 59, 0.18);
}

.select-option__check {
  color: var(--accent);
  font-size: 14px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.input::placeholder {
  color: var(--ink-muted);
}

.input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* Toggle */
.toggles {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.toggle__input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle__switch {
  width: 34px;
  height: 19px;
  border-radius: 10px;
  background: var(--input-border);
  position: relative;
  transition: background 0.2s;
}

.toggle__switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s;
}

.toggle__input:checked + .toggle__switch {
  background: var(--accent);
}

.toggle__input:checked + .toggle__switch::after {
  transform: translateX(15px);
}

.toggle__label {
  font-size: 12px;
  color: var(--ink-soft);
}

/* Button */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 7px 11px;
  border-radius: 9px;
  font-size: 10.5px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
}

.btn--input {
  padding: 9px 11px;
  font-size: 12px;
  border-radius: 9px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn:not(:disabled):hover {
  transform: translateY(-1px);
}

.btn:not(:disabled):active {
  transform: translateY(0);
}

.btn__icon {
  font-size: 12px;
}

.btn__icon--spin {
  animation: spin 1s linear infinite;
}

.btn--primary {
  background: linear-gradient(135deg, var(--accent) 0%, #ff8a6a 100%);
  color: white;
  box-shadow: 0 3px 10px rgba(232, 93, 59, 0.3);
}

.btn--accent {
  background: var(--accent-soft);
  color: var(--accent);
}

.btn--accent:not(:disabled):hover {
  background: var(--accent);
  color: white;
  box-shadow: 0 3px 10px rgba(232, 93, 59, 0.3);
}

.btn--ghost {
  padding: 5px 9px;
  background: transparent;
  color: var(--ink-soft);
  border: 1px dashed var(--input-border);
}

.btn--ghost:not(:disabled):hover {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
}

.btn--danger {
  color: var(--danger);
  border-color: rgba(220, 53, 69, 0.5);
}

.btn--danger:not(:disabled):hover {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: transparent;
}

/* 未保存标志 */
.unsaved-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
  animation: pulse 1s infinite;
  margin-left: 2px;
}

/* Sync Actions */
.sync-actions {
  display: flex;
  gap: 6px;
}

.sync-actions .btn {
  flex: 1;
}

/* Action Grid */
.action-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.action-tile {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 9px;
  border: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  color: white;
  transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
}

.action-tile:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-tile:not(:disabled):hover {
  transform: translateY(-1px);
}

.action-tile:not(:disabled):active {
  transform: translateY(0);
}

.action-tile__icon {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.2);
  display: grid;
  place-items: center;
  font-size: 12px;
  flex-shrink: 0;
}

.action-tile__label {
  flex: 1;
  text-align: left;
}

.action-tile--blue {
  background: linear-gradient(135deg, #5b6eae 0%, #7b8bc8 100%);
  box-shadow: 0 3px 10px rgba(91, 110, 174, 0.3);
}

.action-tile--green {
  background: linear-gradient(135deg, #22a55b 0%, #34d178 100%);
  box-shadow: 0 3px 10px rgba(34, 165, 91, 0.3);
}

.action-tile--cyan {
  background: linear-gradient(135deg, #0891b2 0%, #22d3ee 100%);
  box-shadow: 0 3px 10px rgba(8, 145, 178, 0.3);
}

.action-tile--purple {
  background: linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%);
  box-shadow: 0 3px 10px rgba(124, 58, 237, 0.3);
}

.action-tile--teal {
  background: linear-gradient(135deg, #14b8a6 0%, #5eead4 100%);
  box-shadow: 0 3px 10px rgba(20, 184, 166, 0.3);
}

.action-tile--orange {
  background: linear-gradient(135deg, #f97316 0%, #fb923c 100%);
  box-shadow: 0 3px 10px rgba(249, 115, 22, 0.3);
}

/* Message */
.message {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 6px 0;
  border-radius: 0;
  font-size: 11px;
  color: var(--ink-soft);
}

.message__icon {
  font-size: 13px;
}

.message[data-state="ok"] {
  color: var(--success);
}

.message[data-state="error"] {
  color: var(--danger);
}

/* Meta */
.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 6px;
  background: var(--input-bg);
}

.meta__item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--ink-muted);
}

.meta__icon {
  font-size: 10px;
}

/* Tree */
.tree-container {
  padding: 8px;
  margin: -2px;
  border-radius: 8px;
  background: var(--input-bg);
  transition: opacity 0.15s;
}

.tree-container--loading {
  opacity: 0.5;
  pointer-events: none;
}

.tree-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  font-size: 12px;
  color: var(--ink-muted);
}

.tree-loading__icon {
  font-size: 16px;
  animation: spin 1s linear infinite;
}

/* Animations */
@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Stats */
.stats {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-radius: 11px;
  background: var(--input-bg);
  border: 1px solid var(--card-border);
}

.stats__item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

.stats__label {
  font-size: 10px;
  color: var(--ink-muted);
}

.stats__value {
  font-size: 16px;
  font-weight: 700;
  color: var(--ink);
}

.stats__highlight {
  color: var(--success);
}

.stats__total {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-muted);
}

.stats__value--accent {
  color: var(--accent);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Toast */
.toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  z-index: 2000;
  backdrop-filter: blur(8px);
}

.toast__icon {
  font-size: 16px;
  flex-shrink: 0;
}

.toast__message {
  white-space: nowrap;
}

.toast--success {
  background: linear-gradient(135deg, #22a55b 0%, #34d178 100%);
  color: white;
}

.toast--error {
  background: linear-gradient(135deg, #dc3545 0%, #f87171 100%);
  color: white;
}

/* Toast 动画 */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1500;
  padding: 16px;
}

.modal {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  width: 100%;
  max-width: 320px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.modal__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--card-border);
}

.modal__icon {
  font-size: 16px;
  color: var(--accent);
}

.modal__title {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  color: var(--ink);
}

.modal__body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--card-border);
  background: var(--input-bg);
}

/* Radio Option */
.radio-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.radio-option:hover {
  border-color: var(--accent);
}

.radio-option__input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.radio-option__mark {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--input-border);
  flex-shrink: 0;
  margin-top: 1px;
  transition: border-color 0.15s;
  position: relative;
}

.radio-option__mark::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--accent);
  transform: scale(0);
  transition: transform 0.15s;
}

.radio-option__input:checked + .radio-option__mark {
  border-color: var(--accent);
}

.radio-option__input:checked + .radio-option__mark::after {
  transform: scale(1);
}

.radio-option__content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-option__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}

.radio-option__hint {
  font-size: 11px;
  color: var(--ink-muted);
}

/* Modal 动画 */
.modal-enter-active,
.modal-leave-active {
  transition: all 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal,
.modal-leave-to .modal {
  transform: scale(0.95);
}
</style>
