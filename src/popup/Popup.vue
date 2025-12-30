<script setup lang="ts">
function openSidePanelHelp() {
  browser.tabs.create({
    url: browser.runtime.getURL('dist/sidepanel/index.html'),
  })
}
</script>

<template>
  <main class="w-[320px] px-4 py-5 text-center text-gray-700">
    <SharedSubtitle />
    <div class="mt-2 text-sm">
      配置已迁移到侧边栏，请打开侧边栏进行设置。
    </div>
    <button class="btn mt-3" @click="openSidePanelHelp">
      打开侧边栏页面
    </button>
  </main>
</template>
