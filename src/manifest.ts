import fs from 'fs-extra'
import type { Manifest } from 'webextension-polyfill'
import type PkgType from '../package.json'
import { isDev, isFirefox, port, r } from '../scripts/utils'

export async function getManifest() {
  const pkg = await fs.readJSON(r('package.json')) as typeof PkgType

  // update this file to update this manifest.json
  // can also be conditional based on your need
  const manifest: Manifest.WebExtensionManifest = {
    manifest_version: 3,
    name: pkg.displayName || pkg.name,
    version: pkg.version,
    description: pkg.description,
    action: {
      default_icon: {
        16: 'assets/logo-light-16.png',
        32: 'assets/logo-light-32.png',
        48: 'assets/logo-light-48.png',
        128: 'assets/logo-light-128.png',
      },
      theme_icons: [
        {
          light: 'assets/logo-light-16.png',
          dark: 'assets/logo-dark-16.png',
          size: 16,
        },
        {
          light: 'assets/logo-light-32.png',
          dark: 'assets/logo-dark-32.png',
          size: 32,
        },
        {
          light: 'assets/logo-light-48.png',
          dark: 'assets/logo-dark-48.png',
          size: 48,
        },
        {
          light: 'assets/logo-light-128.png',
          dark: 'assets/logo-dark-128.png',
          size: 128,
        },
      ],
    },
    background: isFirefox
      ? {
          scripts: ['dist/background/index.mjs'],
          type: 'module',
        }
      : {
          service_worker: 'dist/background/index.mjs',
        },
    icons: {
      16: 'assets/logo-light-16.png',
      48: 'assets/logo-light-48.png',
      128: 'assets/logo-light-128.png',
    },
    permissions: [
      'tabs',
      'storage',
      'activeTab',
      'sidePanel',
      'bookmarks',
      'alarms',
    ],
    host_permissions: ['*://*/*'],
    content_scripts: [
      {
        matches: [
          'http://*/*',
          'https://*/*',
        ],
        js: [
          'dist/contentScripts/index.global.js',
        ],
      },
    ],
    web_accessible_resources: [
      {
        resources: ['dist/contentScripts/style.css'],
        matches: ['<all_urls>'],
      },
    ],
    content_security_policy: {
      extension_pages: isDev
        // this is required on dev for Vite script to load
        ? `script-src \'self\' http://localhost:${port}; object-src \'self\'`
        : 'script-src \'self\'; object-src \'self\'',
    },
  }

  // add sidepanel
  if (isFirefox) {
    manifest.sidebar_action = {
      default_panel: 'dist/sidepanel/index.html',
    }
  }
  else {
    // the sidebar_action does not work for chromium based
    (manifest as any).side_panel = {
      default_path: 'dist/sidepanel/index.html',
    }
    manifest.permissions?.push('offscreen')
  }

  // FIXME: not work in MV3
  if (isDev && false) {
    // for content script, as browsers will cache them for each reload,
    // we use a background script to always inject the latest version
    // see src/background/contentScriptHMR.ts
    delete manifest.content_scripts
    manifest.permissions?.push('webNavigation')
  }

  return manifest
}
