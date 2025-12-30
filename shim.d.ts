import type { ProtocolWithReturn } from 'webext-bridge'

declare module 'webext-bridge' {
  export interface ProtocolMap {
    // define message protocol types
    // see https://github.com/antfu/webext-bridge#type-safe-protocols
    'tab-prev': { title: string | undefined }
    'get-current-tab': ProtocolWithReturn<{ tabId: number }, { title?: string }>
    'validate-gist-auth': ProtocolWithReturn<
      { token: string, gistId: string, fileName: string, autoCreate?: boolean, createIfMissing?: boolean },
      { ok: boolean, createdFile?: boolean, createdGist?: boolean, errors?: string[], gist?: { id: string, owner?: string, description?: string, files: string[] } }
    >
    'get-bookmark-folders': ProtocolWithReturn<undefined, { ok: boolean, tree?: { id: string, title: string, count: number, children: unknown[] }[], error?: string }>
    'sync-now': ProtocolWithReturn<undefined, { ok: boolean, summary?: string, timestamp?: string, error?: string }>
    'sync-upload': ProtocolWithReturn<undefined, { ok: boolean, summary?: string, timestamp?: string, error?: string }>
    'sync-download': ProtocolWithReturn<undefined, { ok: boolean, summary?: string, timestamp?: string, error?: string }>
    'open-sidepanel': ProtocolWithReturn<undefined, { ok: boolean, error?: string }>
  }
}
