<script setup lang="ts">
import { sendMessage } from 'webext-bridge/popup'
import { computed, onMounted, ref } from 'vue'
import { connectionStatus, connectionStatusReady, gistFileName, gistId, gistIdReady, githubToken, githubTokenReady, lastValidationTime, syncFolderSelection } from '~/logic/storage'

type FolderNode = {
  id: string
  title: string
  count: number
  children: FolderNode[]
}

const validationState = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const uploadState = ref<'idle' | 'syncing' | 'done' | 'error'>('idle')
const downloadState = ref<'idle' | 'syncing' | 'done' | 'error'>('idle')
const folderTree = ref<FolderNode[]>([])
const folderTreeState = ref<'idle' | 'loading' | 'error'>('idle')
const folderTreeMessage = ref('')
const selectedFolderIds = ref(new Set<string>())
const savedFolderIds = ref(new Set<string>()) // 已保存的选择，用于统计

// 检测同步范围是否有未保存的变化
const hasUnsavedChanges = computed(() => {
  if (selectedFolderIds.value.size !== savedFolderIds.value.size) return true
  for (const id of selectedFolderIds.value) {
    if (!savedFolderIds.value.has(id)) return true
  }
  return false
})

// Toast 通知
const toastVisible = ref(false)
const toastMessage = ref('')
const toastType = ref<'success' | 'error'>('success')
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(message: string, type: 'success' | 'error' = 'success') {
  if (toastTimer) clearTimeout(toastTimer)
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
    validationState.value = 'idle'
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
        validationState.value = 'ok'
        // 随机校验（10%概率）
        if (Math.random() >= RANDOM_CHECK_RATE) {
          return
        }
      }
    }
    // 如果之前验证失败，短时间内不重复验证（1分钟）
    else if (connectionStatus.value === 'error' && timeSinceLastCheck < 60 * 1000) {
      validationState.value = 'error'
      return
    }
  }

  validationState.value = 'checking'

  try {
    const result = await sendMessage(
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
    validationState.value = status
    connectionStatus.value = status
    lastValidationTime.value = Date.now()
  }
  catch {
    validationState.value = 'error'
    connectionStatus.value = 'error'
    lastValidationTime.value = Date.now()
  }
}

async function validateGistAuth() {
  validationState.value = 'checking'

  // 设置默认文件名
  if (!gistFileName.value.trim()) {
    gistFileName.value = 'bookmarks'
  }

  try {
    const result = await sendMessage(
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
      validationState.value = 'ok'
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

    validationState.value = 'error'
    connectionStatus.value = 'error'
    lastValidationTime.value = Date.now()
    showToast(result.errors?.join('; ') || '保存失败', 'error')
  }
  catch (error) {
    validationState.value = 'error'
    connectionStatus.value = 'error'
    lastValidationTime.value = Date.now()
    showToast(error instanceof Error ? error.message : '保存失败', 'error')
  }
}

async function syncNow() {
  uploadState.value = 'syncing'

  try {
    const result = await sendMessage('sync-upload', undefined, 'background')
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

async function downloadBookmarks() {
  downloadState.value = 'syncing'

  try {
    const result = await sendMessage('sync-download', undefined, 'background')
    if (result.ok) {
      downloadState.value = 'done'
      showToast(result.summary || '拉取成功', 'success')
      void loadFolderTree()
      return
    }

    downloadState.value = 'error'
    showToast(result.error || '拉取失败', 'error')
  }
  catch (error) {
    downloadState.value = 'error'
    showToast(error instanceof Error ? error.message : '拉取失败', 'error')
  }
}

function exportConfig() {
  const config = {
    githubToken: githubToken.value,
    gistId: gistId.value,
    gistFileName: gistFileName.value,
    syncFolderSelection: Array.from(selectedFolderIds.value),
  }
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'gist-sync-config.json'
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
    if (!file) return
    try {
      const text = await file.text()
      const config = JSON.parse(text)
      if (config.githubToken) githubToken.value = config.githubToken
      if (config.gistId) gistId.value = config.gistId
      if (config.gistFileName) gistFileName.value = config.gistFileName
      if (Array.isArray(config.syncFolderSelection)) {
        syncFolderSelection.value = config.syncFolderSelection
        selectedFolderIds.value = new Set(config.syncFolderSelection)
      }
      showToast('配置已导入', 'success')
    }
    catch {
      showToast('配置文件格式错误', 'error')
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
    const result = await sendMessage('get-bookmark-folders', undefined, 'background')
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

function saveFolderSelection() {
  syncFolderSelection.value = Array.from(selectedFolderIds.value)
  savedFolderIds.value = new Set(selectedFolderIds.value)
  showToast('同步范围已保存', 'success')
}

onMounted(() => {
  void loadFolderTree()
  // 等待所有配置数据加载完成后恢复连接状态
  Promise.all([githubTokenReady, gistIdReady, connectionStatusReady]).then(() => {
    // 恢复之前保存的连接状态
    if (connectionStatus.value === 'ok') {
      validationState.value = 'ok'
    }
    else if (connectionStatus.value === 'error') {
      validationState.value = 'error'
    }
    // 如果有配置但没有连接状态，进行一次验证
    else if (githubToken.value?.trim() && gistId.value?.trim()) {
      void checkConnection()
    }
  })
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
          <h1 class="panel__title">Gist Sync</h1>
          <p class="panel__subtitle">书签云同步</p>
        </div>
      </div>
      <div class="panel__status" :data-state="validationState">
        <span class="panel__status-dot" />
        <span v-if="validationState === 'checking'">校验中</span>
        <span v-else-if="validationState === 'ok'">已连接</span>
        <span v-else-if="validationState === 'error'">连接失败</span>
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
        <h2 class="card__title">连接配置</h2>
      </div>
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
      <button class="btn btn--primary" :disabled="validationState === 'checking'" @click="validateGistAuth">
        <ph-floppy-disk v-if="validationState !== 'checking'" class="btn__icon" />
        <ph-circle-notch v-else class="btn__icon btn__icon--spin" />
        {{ validationState === 'checking' ? '保存中…' : '保存配置' }}
      </button>
    </section>

    <section class="card">
      <div class="card__header">
        <ph-squares-four class="card__icon" />
        <h2 class="card__title">快捷操作</h2>
      </div>
      <div class="action-grid">
        <button class="action-tile action-tile--blue" @click="importConfig">
          <span class="action-tile__icon"><ph-download-simple /></span>
          <span class="action-tile__label">导入配置</span>
        </button>
        <button class="action-tile action-tile--green" @click="exportConfig">
          <span class="action-tile__icon"><ph-upload-simple /></span>
          <span class="action-tile__label">导出配置</span>
        </button>
        <button class="action-tile action-tile--cyan" :disabled="downloadState === 'syncing' || validationState !== 'ok'" @click="downloadBookmarks">
          <span class="action-tile__icon">
            <ph-cloud-arrow-down v-if="downloadState !== 'syncing'" />
            <ph-circle-notch v-else class="btn__icon--spin" />
          </span>
          <span class="action-tile__label">拉取云端</span>
        </button>
        <button class="action-tile action-tile--purple" :disabled="uploadState === 'syncing' || validationState !== 'ok'" @click="syncNow">
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
        <ph-folder-open class="card__icon" />
        <h2 class="card__title">同步范围</h2>
        <button class="btn btn--ghost" :disabled="folderTreeState === 'loading'" @click="loadFolderTree">
          <ph-arrows-clockwise class="btn__icon" :class="{ 'btn__icon--spin': folderTreeState === 'loading' }" />
        </button>
        <button class="btn btn--ghost" @click="saveFolderSelection">
          <ph-floppy-disk class="btn__icon" />
          保存
          <span v-if="hasUnsavedChanges" class="unsaved-dot" />
        </button>
      </div>
      <p class="card__hint">选择需要同步的书签文件夹</p>
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
  </main>
</template>


<style scoped>
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
  padding-bottom: 6px;
}

.panel__brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel__logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent) 0%, #ff8a6a 100%);
  display: grid;
  place-items: center;
  box-shadow: 0 3px 10px rgba(232, 93, 59, 0.3);
}

.panel__logo-icon {
  font-size: 18px;
  color: white;
}

.panel__title {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.panel__subtitle {
  font-size: 11px;
  color: var(--ink-muted);
  margin: 2px 0 0;
}

.panel__status {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 16px;
  font-size: 11px;
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

/* Field */
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field__label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
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
  gap: 5px;
  padding: 9px 14px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
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
  font-size: 14px;
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
  gap: 8px;
}

.action-tile {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 11px;
  border: none;
  cursor: pointer;
  font-size: 12px;
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
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.2);
  display: grid;
  place-items: center;
  font-size: 14px;
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

/* Message */
.message {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 11px;
  background: var(--input-bg);
  color: var(--ink-soft);
}

.message__icon {
  font-size: 13px;
}

.message[data-state="ok"] {
  background: var(--success-soft);
  color: var(--success);
}

.message[data-state="error"] {
  background: var(--danger-soft);
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
  z-index: 1000;
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
</style>
