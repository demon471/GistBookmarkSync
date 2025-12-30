import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'

export const { data: storageDemo, dataReady: storageDemoReady } = useWebExtensionStorage('webext-demo', 'Storage Demo')

export const { data: githubToken, dataReady: githubTokenReady } = useWebExtensionStorage('github-token', '')
export const { data: gistId, dataReady: gistIdReady } = useWebExtensionStorage('gist-id', '')
export const { data: gistFileName, dataReady: gistFileNameReady } = useWebExtensionStorage('gist-file-name', '')
export const { data: gistAutoCreate, dataReady: gistAutoCreateReady } = useWebExtensionStorage('gist-auto-create', true)
