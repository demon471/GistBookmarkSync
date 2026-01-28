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

export const { data: syncIntervalMinutes, dataReady: syncIntervalMinutesReady } = useWebExtensionStorage<number>('sync-interval-minutes', 0)
export const { data: syncProvider, dataReady: syncProviderReady } = useWebExtensionStorage<'gist' | 'webdav'>('sync-provider', 'gist')

export interface SyncLogEntry {
  id: string
  time: string
  provider: 'gist' | 'webdav'
  mode: 'upload' | 'download' | 'random-backup' | 'concurrent-sync'
  status: 'ok' | 'error'
  summary: string
}

const syncLogSerializer = {
  read(value: unknown) {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as SyncLogEntry[]
        return Array.isArray(parsed) ? parsed : []
      }
      catch {
        return []
      }
    }
    if (Array.isArray(value))
      return value as SyncLogEntry[]
    return []
  },
  write(value: SyncLogEntry[]) {
    return JSON.stringify(value || [])
  },
}

export const { data: syncLogs, dataReady: syncLogsReady } = useWebExtensionStorage<SyncLogEntry[]>(
  'sync-log',
  [],
  { serializer: syncLogSerializer },
)

export const { data: webdavUrl, dataReady: webdavUrlReady } = useWebExtensionStorage('webdav-url', '')
export const { data: webdavUsername, dataReady: webdavUsernameReady } = useWebExtensionStorage('webdav-username', '')
export const { data: webdavPassword, dataReady: webdavPasswordReady } = useWebExtensionStorage('webdav-password', '')
export const { data: webdavFilePath, dataReady: webdavFilePathReady } = useWebExtensionStorage('webdav-file-path', '')

// 连接验证状态
export const { data: connectionStatus, dataReady: connectionStatusReady } = useWebExtensionStorage<'ok' | 'error' | ''>('connection-status', '')
export const { data: lastValidationTime, dataReady: lastValidationTimeReady } = useWebExtensionStorage<number>('last-validation-time', 0)
export const { data: webdavConnectionStatus, dataReady: webdavConnectionStatusReady } = useWebExtensionStorage<'ok' | 'error' | ''>('webdav-connection-status', '')
export const { data: webdavLastValidationTime, dataReady: webdavLastValidationTimeReady } = useWebExtensionStorage<number>('webdav-last-validation-time', 0)

// 高级备份配置
// 是否启用备用同步方式的随机备份
export const { data: advancedBackupEnabled, dataReady: advancedBackupEnabledReady } = useWebExtensionStorage<boolean>('advanced-backup-enabled', false)
// 备份使用的 provider（与当前主同步方式相反）
export const { data: advancedBackupProvider, dataReady: advancedBackupProviderReady } = useWebExtensionStorage<'gist' | 'webdav' | ''>('advanced-backup-provider', '')
// 随机备份时间区间开始（0-23 小时）
export const { data: advancedBackupStartHour, dataReady: advancedBackupStartHourReady } = useWebExtensionStorage<number>('advanced-backup-start-hour', 9)
// 随机备份时间区间结束（0-23 小时）
export const { data: advancedBackupEndHour, dataReady: advancedBackupEndHourReady } = useWebExtensionStorage<number>('advanced-backup-end-hour', 18)
// 每天随机备份次数
export const { data: advancedBackupCount, dataReady: advancedBackupCountReady } = useWebExtensionStorage<number>('advanced-backup-count', 3)
// 上次随机备份日期（用于判断是否需要重新生成随机时间点）
export const { data: advancedBackupLastDate, dataReady: advancedBackupLastDateReady } = useWebExtensionStorage<string>('advanced-backup-last-date', '')
// 今日已完成的备份次数
export const { data: advancedBackupTodayCount, dataReady: advancedBackupTodayCountReady } = useWebExtensionStorage<number>('advanced-backup-today-count', 0)
