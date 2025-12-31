<script setup lang="ts">
import { sendMessage } from 'webext-bridge/popup'
import { onMounted, ref } from 'vue'
import { gistAutoCreate, gistCreateIfMissing, gistFileName, gistId, githubToken, gistLastSync, gistLastSyncSummary, syncFolderSelection } from '~/logic/storage'

type FolderNode = {
  id: string
  title: string
  count: number
  children: FolderNode[]
}

const validationState = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const validationMessage = ref('')
const syncState = ref<'idle' | 'syncing' | 'done' | 'error'>('idle')
const syncMessage = ref('')
const folderTree = ref<FolderNode[]>([])
const folderTreeState = ref<'idle' | 'loading' | 'error'>('idle')
const folderTreeMessage = ref('')
const selectedFolderIds = ref(new Set<string>())
const selectionMessage = ref('')

async function validateGistAuth() {
  validationState.value = 'checking'
  validationMessage.value = ''

  try {
    const result = await sendMessage(
      'validate-gist-auth',
      {
        token: githubToken.value,
        gistId: gistId.value,
        fileName: gistFileName.value,
        autoCreate: gistAutoCreate.value,
        createIfMissing: gistCreateIfMissing.value,
      },
      'background',
    )

    if (result.ok) {
      validationState.value = 'ok'
      if (result.gist?.id)
        gistId.value = result.gist.id
      if (result.createdGist)
        validationMessage.value = 'New Gist created and validated'
      else if (result.createdFile)
        validationMessage.value = 'Validated and file created'
      else
        validationMessage.value = 'Validation passed'
      return
    }

    validationState.value = 'error'
    validationMessage.value = result.errors?.join('; ') || 'Validation failed'
    syncState.value = 'idle'
    syncMessage.value = ''
  }
  catch (error) {
    validationState.value = 'error'
    validationMessage.value = error instanceof Error ? error.message : 'Validation failed'
    syncState.value = 'idle'
    syncMessage.value = ''
  }
}

async function syncNow() {
  syncState.value = 'syncing'
  syncMessage.value = ''

  try {
    const result = await sendMessage('sync-upload', undefined, 'background')
    if (result.ok) {
      syncState.value = 'done'
      syncMessage.value = result.summary || 'Sync finished'
      return
    }

    syncState.value = 'error'
    syncMessage.value = result.error || 'Sync failed'
  }
  catch (error) {
    syncState.value = 'error'
    syncMessage.value = error instanceof Error ? error.message : 'Sync failed'
  }
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
  selectionMessage.value = ''

  try {
    const result = await sendMessage('get-bookmark-folders', undefined, 'background')
    if (!result.ok) {
      folderTreeState.value = 'error'
      folderTreeMessage.value = result.error || 'Failed to load bookmarks'
      return
    }

    folderTree.value = result.tree || []
    const stored = Array.isArray(syncFolderSelection.value) ? syncFolderSelection.value : []
    const selected = new Set<string>(stored)
    if (selected.size === 0) {
      for (const id of collectFolderIds(folderTree.value))
        selected.add(id)
    }
    normalizeSelection(folderTree.value, selected, true)
    selectedFolderIds.value = selected
    folderTreeState.value = 'idle'
  }
  catch (error) {
    folderTreeState.value = 'error'
    folderTreeMessage.value = error instanceof Error ? error.message : 'Failed to load bookmarks'
  }
}

function saveFolderSelection() {
  syncFolderSelection.value = Array.from(selectedFolderIds.value)
  selectionMessage.value = 'Selection saved'
}

onMounted(() => {
  void loadFolderTree()
})
</script>

<template>
  <main class="panel">
    <header class="panel__header">
      <div>
        <p class="panel__eyebrow">Gist Sync</p>
        <h1 class="panel__title">书签同步侧边栏</h1>
        <p class="panel__subtitle">配置 Gist 并选择需要同步的文件夹。</p>
      </div>
      <div class="panel__status" :data-state="validationState">
        <span v-if="validationState === 'checking'">校验中</span>
        <span v-else-if="validationState === 'ok'">已验证</span>
        <span v-else-if="validationState === 'error'">验证失败</span>
        <span v-else>未验证</span>
      </div>
    </header>

    <section class="card">
      <h2 class="card__title">连接 Gist</h2>
      <div class="field">
        <label>GitHub Token</label>
        <input v-model="githubToken" type="password" placeholder="ghp_..." class="input">
      </div>
      <div class="field">
        <label>Gist ID</label>
        <input v-model="gistId" placeholder="留空可自动创建" class="input">
      </div>
      <label class="toggle">
        <input v-model="gistCreateIfMissing" type="checkbox">
        <span>自动创建 Gist（当 ID 无效或为空时）</span>
      </label>
      <div class="field">
        <label>Gist 文件名</label>
        <input v-model="gistFileName" placeholder="bookmark" class="input">
      </div>
      <label class="toggle">
        <input v-model="gistAutoCreate" type="checkbox">
        <span>自动创建文件（当文件缺失时）</span>
      </label>
      <button class="btn-primary" :disabled="validationState === 'checking'" @click="validateGistAuth">
        验证连接
      </button>
      <p v-if="validationState !== 'idle'" class="status" :data-state="validationState">
        {{ validationMessage || (validationState === 'checking' ? '正在验证 Gist 权限…' : '') }}
      </p>
    </section>

    <section class="card">
      <h2 class="card__title">同步控制</h2>
      <button class="btn-secondary" :disabled="syncState === 'syncing' || validationState !== 'ok'" @click="syncNow">
        {{ syncState === 'syncing' ? '正在同步…' : '立即同步' }}
      </button>
      <p v-if="syncState !== 'idle'" class="status" :data-state="syncState">
        {{ syncMessage }}
      </p>
      <div class="meta" v-if="gistLastSync || gistLastSyncSummary">
        <div v-if="gistLastSync">上次同步：{{ gistLastSync }}</div>
        <div v-if="gistLastSyncSummary">{{ gistLastSyncSummary }}</div>
      </div>
    </section>

    <section class="card">
      <div class="card__head">
        <h2 class="card__title">选择同步文件夹</h2>
        <button class="btn-ghost" @click="saveFolderSelection">保存</button>
      </div>
      <p class="card__hint">未勾选的文件夹将不会被推送到 Gist。</p>
      <div v-if="folderTreeState === 'loading'" class="status" data-state="idle">加载中…</div>
      <div v-else-if="folderTreeState === 'error'" class="status" data-state="error">{{ folderTreeMessage }}</div>
      <FolderTree
        v-else
        :nodes="folderTree"
        :selected-ids="Array.from(selectedFolderIds)"
        @toggle="toggleFolder"
      />
      <p v-if="selectionMessage" class="status" data-state="ok">{{ selectionMessage }}</p>
    </section>
  </main>
</template>

<style scoped>
.panel {
  --bg: #f7f3e9;
  --bg-accent: #f1e4c5;
  --ink: #1f1c18;
  --muted: #6f655a;
  --card: #fff8e8;
  --border: #e6d9bf;
  --accent: #cb4f2f;
  --accent-dark: #9d3a22;
  --success: #2a7a4b;
  --danger: #b8402d;
  min-height: 100vh;
  padding: 20px 16px 28px;
  color: var(--ink);
  background:
    radial-gradient(circle at top right, #ffe9c2 0%, transparent 45%),
    radial-gradient(circle at 10% 35%, #ffe3a1 0%, transparent 50%),
    linear-gradient(145deg, var(--bg) 0%, var(--bg-accent) 100%);
  font-family: 'Space Grotesk', 'Noto Sans', 'Segoe UI', sans-serif;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #141414;
    --bg-accent: #1d1b19;
    --ink: #f1eee7;
    --muted: #b7ada2;
    --card: #1b1916;
    --border: #2f2a25;
    --accent: #e07955;
    --accent-dark: #c16447;
    --success: #6fd29a;
    --danger: #f08c7c;
    background:
      radial-gradient(circle at top right, rgba(224, 121, 85, 0.25) 0%, transparent 45%),
      radial-gradient(circle at 10% 35%, rgba(224, 121, 85, 0.15) 0%, transparent 50%),
      linear-gradient(145deg, var(--bg) 0%, var(--bg-accent) 100%);
  }
}

.panel__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.panel__eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.2em;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 6px;
}

.panel__title {
  font-size: 20px;
  margin: 0 0 4px;
}

.panel__subtitle {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.panel__status {
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: #f5e7cb;
  color: var(--muted);
  border: 1px solid var(--border);
}

@media (prefers-color-scheme: dark) {
  .panel__status {
    background: #2a241e;
  }
}

.panel__status[data-state="ok"] {
  color: var(--success);
  border-color: rgba(42, 122, 75, 0.3);
  background: #e7f4ed;
}

.panel__status[data-state="error"] {
  color: var(--danger);
  border-color: rgba(184, 64, 45, 0.3);
  background: #fbe9e5;
}

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 16px;
  box-shadow: 0 12px 24px rgba(79, 54, 18, 0.08);
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: lift 240ms ease-out;
}

@media (prefers-color-scheme: dark) {
  .card {
    box-shadow: 0 14px 26px rgba(0, 0, 0, 0.35);
  }
}

.card__title {
  font-size: 15px;
  margin: 0;
}

.card__hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.card__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}

.field label {
  font-size: 12px;
  color: var(--muted);
}

.input {
  border-radius: 12px;
  border: 1px solid var(--border);
  padding: 10px 12px;
  background: #fffdf8;
  color: var(--ink);
  font-size: 13px;
}

@media (prefers-color-scheme: dark) {
  .input {
    background: #141210;
  }
}

.input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(203, 79, 47, 0.2);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}

.btn-primary,
.btn-secondary,
.btn-ghost {
  border-radius: 999px;
  padding: 10px 14px;
  font-size: 13px;
  border: none;
  cursor: pointer;
  font-weight: 600;
  transition: transform 160ms ease, box-shadow 160ms ease;
}

.btn-primary {
  background: var(--accent);
  color: white;
  box-shadow: 0 10px 16px rgba(203, 79, 47, 0.25);
}

.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  box-shadow: none;
}

.btn-secondary {
  background: #fff;
  border: 1px solid var(--border);
  color: var(--ink);
}

@media (prefers-color-scheme: dark) {
  .btn-secondary {
    background: #201c17;
  }
}

.btn-ghost {
  background: transparent;
  color: var(--accent-dark);
  border: 1px dashed rgba(157, 58, 34, 0.3);
  padding: 6px 10px;
}

.btn-primary:hover:not(:disabled),
.btn-secondary:hover:not(:disabled),
.btn-ghost:hover:not(:disabled) {
  transform: translateY(-1px);
}

.status {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.status[data-state="ok"] {
  color: var(--success);
}

.status[data-state="error"] {
  color: var(--danger);
}

.meta {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

@keyframes lift {
  from {
    transform: translateY(4px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
