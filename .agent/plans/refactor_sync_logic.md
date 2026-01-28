# Refactor Sync Logic Implementation Plan

## 目标
重构同步逻辑，移除“同步范围（Sync Scope）”功能，简化为默认全量同步，但保留“排除文件夹”的逻辑以防止被误删，并在同步/下载后将排除的文件夹置于列表末尾。

## 已完成的修改

### 1. 移除同步范围功能 (Sync Scope)
- **Background Script (`src/background/main.ts`)**:
    - 修改 `loadLocalNodes` 函数，移除参数，使其始终加载全部本地书签。
    - 修改 `performSync` 函数（Gist 同步），移除 `nodesToLoad` 逻辑，直接调用无参的 `loadLocalNodes`。
    - 修改 `performRandomBackup` 函数，移除 `advancedConcurrentScope` 的读取和处理逻辑，确保备份总是全量的。
    - 更新 `update-advanced-backup-config` 消息处理器，移除 `concurrentScope` 字段的支持。
    - 清理相关类型定义。

- **Side Panel (`src/sidepanel/Sidepanel.vue`)**:
    - 移除 `advancedConcurrentScope` 状态变量及相关计算属性。
    - 移除设置面板中关于“备份范围”的下拉菜单 UI。
    - 更新 `saveConfig` / `loadConfig` / `importConfig` / `exportConfig` 函数，不再读写 `advancedConcurrentScope` 字段。

### 2. 优化排除文件夹逻辑
- **Clear Bookmarks (`clear-bookmarks` handler)**:
    - 确保在清空书签时，读取 `sync-folder-selection`，并传递给 `clearLocalBookmarks`，从而保留排除的文件夹不被删除。

- **WebDAV Restore (`webdav-download-version` handler)**:
    - 增加读取 `sync-folder-selection` 的逻辑。
    - 在调用 `clearLocalBookmarks` 时传入排除列表，保护这些文件夹。
    - 在下载并应用 WebDAV 版本后，如果存在排除文件夹，调用 `moveExcludedToEnd`将其移动到书签栏末尾，保持整洁。

- **Gist Sync (`performSync` / `sync-download`)**:
    - 修复了 Gist 下载逻辑中的代码结构错误。
    - 在合并远程和本地书签后，增加 `moveExcludedToEnd` 调用，确保排除的文件夹在同步后被置底。
    - 确保 `ensureLocalEntries` 在全量加载的上下文下运行，防止误删未同步的文件夹（因为现在是全量加载，所以不会误删）。

### 3. 导出功能
- **Export Bookmarks**:
    - 确认 `export-bookmarks` 消息处理器使用 `toSyncNodes(root.children)`，这本身就是全量导出，无需修改。
    - 移除了 `Sidepanel.vue` 中意外残留的“将导出所有本地书签。”静态文本（该文本应只出现在导出弹窗中）。

## 验证
- **Build**: 通过 `pnpm build` 验证项目构建成功。
- **UI Logic**: 修复了 Sidepanel 中可能导致用户困惑的错误提示文本显示。
