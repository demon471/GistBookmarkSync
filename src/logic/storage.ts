import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'

export const { data: storageDemo, dataReady: storageDemoReady } = useWebExtensionStorage('webext-demo', 'Storage Demo')

export const { data: githubToken, dataReady: githubTokenReady } = useWebExtensionStorage('github-token', '')
export const { data: gistId, dataReady: gistIdReady } = useWebExtensionStorage('gist-id', '')
export const { data: gistFileName, dataReady: gistFileNameReady } = useWebExtensionStorage('gist-file-name', '')
export const { data: gistAutoCreate, dataReady: gistAutoCreateReady } = useWebExtensionStorage('gist-auto-create', true)
export const { data: gistCreateIfMissing, dataReady: gistCreateIfMissingReady } = useWebExtensionStorage('gist-create-if-missing', false)
export const { data: gistLastSync, dataReady: gistLastSyncReady } = useWebExtensionStorage('gist-last-sync', '')
export const { data: gistLastSyncSummary, dataReady: gistLastSyncSummaryReady } = useWebExtensionStorage('gist-last-sync-summary', '')
export const { data: syncDirection, dataReady: syncDirectionReady } = useWebExtensionStorage('sync-direction', 'pull')
export const { data: syncConflictStrategy, dataReady: syncConflictStrategyReady } = useWebExtensionStorage('sync-conflict-strategy', 'gist-wins')
export const { data: syncFolderSelection, dataReady: syncFolderSelectionReady } = useWebExtensionStorage<string[]>('sync-folder-selection', [])
export const { data: syncProvider, dataReady: syncProviderReady } = useWebExtensionStorage<'gist' | 'webdav'>('sync-provider', 'gist')

export const { data: webdavUrl, dataReady: webdavUrlReady } = useWebExtensionStorage('webdav-url', '')
export const { data: webdavUsername, dataReady: webdavUsernameReady } = useWebExtensionStorage('webdav-username', '')
export const { data: webdavPassword, dataReady: webdavPasswordReady } = useWebExtensionStorage('webdav-password', '')
export const { data: webdavFilePath, dataReady: webdavFilePathReady } = useWebExtensionStorage('webdav-file-path', '')

// 连接验证状态
export const { data: connectionStatus, dataReady: connectionStatusReady } = useWebExtensionStorage<'ok' | 'error' | ''>('connection-status', '')
export const { data: lastValidationTime, dataReady: lastValidationTimeReady } = useWebExtensionStorage<number>('last-validation-time', 0)
export const { data: webdavConnectionStatus, dataReady: webdavConnectionStatusReady } = useWebExtensionStorage<'ok' | 'error' | ''>('webdav-connection-status', '')
export const { data: webdavLastValidationTime, dataReady: webdavLastValidationTimeReady } = useWebExtensionStorage<number>('webdav-last-validation-time', 0)
