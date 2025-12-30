<script setup lang="ts">
function openPopupHelp() {
  browser.tabs.create({
    url: browser.runtime.getURL('dist/popup/index.html'),
  })
}
</script>

<template>
  <main class="px-4 py-10 text-center text-gray-700 dark:text-gray-200">
    <SharedSubtitle />
    <div class="mt-2 text-sm">
      配置已迁移到 Popup 中，请打开扩展弹窗进行设置。
    </div>
    <button class="btn mt-3" @click="openPopupHelp">
      打开 Popup 页面
    </button>
  </main>
</template>
