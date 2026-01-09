<script setup lang="ts">
import { sendMessage } from "webext-bridge/content-script";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import logoUrl from "~/assets/logo.png";
import "uno.css";

type ShortcutPosition = {
  side: "left" | "right";
  y: number;
};

type FeedbackState = "idle" | "loading" | "success" | "error";

const containerRef = ref<HTMLDivElement | null>(null);
const isDragging = ref(false);
const isHoveringShortcut = ref(false);
const isHoveringActions = ref(false);
const isHoveringCloseBtn = ref(false);
const isHovering = computed(
  () => isHoveringShortcut.value || isHoveringActions.value || isHoveringCloseBtn.value,
);
const isReady = ref(false);
const pos = ref({ x: 0, y: 120, side: "right" as ShortcutPosition["side"] });
const dragStart = ref({ x: 0, y: 0, pointerX: 0, pointerY: 0 });
const hoverActivationWidth = 52;
let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;

// 操作反馈状态
const uploadState = ref<FeedbackState>("idle");
const downloadState = ref<FeedbackState>("idle");
const clearState = ref<FeedbackState>("idle");
const showClearHint = ref(false);
let clearClickTimer: ReturnType<typeof setTimeout> | null = null;

// 当前页面隐藏状态
const isHiddenForPage = ref(false);

// 页面暗黑模式检测
const isDarkMode = ref(false);
let darkModeObserver: MutationObserver | null = null;
let darkModeMediaQuery: MediaQueryList | null = null;

const containerStyle = computed(() => ({
  left: `${pos.value.x}px`,
  top: `${pos.value.y}px`,
}));

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getContainerSize() {
  const rect = containerRef.value?.getBoundingClientRect();
  return {
    width: rect?.width || 44,
    height: rect?.height || 44,
  };
}

function getScrollbarMetrics() {
  const doc = document.documentElement;
  const scrollbarWidth = Math.max(0, window.innerWidth - doc.clientWidth);
  const direction = window.getComputedStyle(doc).direction;
  return {
    width: scrollbarWidth,
    onLeft: direction === "rtl",
  };
}

function snapToEdge(side?: ShortcutPosition["side"]) {
  const { width, height } = getContainerSize();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const scrollbar = getScrollbarMetrics();
  const edgePadding = 4;
  // 只有在检测到滚动条时才预留空间
  const scrollbarReserve = scrollbar.width > 0 ? Math.max(scrollbar.width, 4) : 0;
  const inferredSide =
    side || (pos.value.x + width / 2 < viewportWidth / 2 ? "left" : "right");
  const leftInset = scrollbar.onLeft ? scrollbarReserve : 0;
  const rightInset = !scrollbar.onLeft ? scrollbarReserve : 0;
  const x =
    inferredSide === "left"
      ? leftInset + edgePadding
      : viewportWidth - width - rightInset - edgePadding;
  const y = clamp(pos.value.y, 12, Math.max(12, viewportHeight - height - 12));
  pos.value = { x, y, side: inferredSide };
}

function updateHoverByPointer(event: MouseEvent) {
  if (!containerRef.value) return;
  cancelHoverHide();
  const rect = containerRef.value.getBoundingClientRect();
  const distance =
    pos.value.side === "right"
      ? rect.right - event.clientX
      : event.clientX - rect.left;
  isHoveringShortcut.value = distance <= hoverActivationWidth;
}

function delayedHoverHide() {
  cancelHoverHide();
  hoverHideTimer = setTimeout(() => {
    isHoveringShortcut.value = false;
  }, 150);
}

function cancelHoverHide() {
  if (hoverHideTimer) {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
}

async function loadPosition() {
  try {
    const stored = (await browser.storage.local.get("shortcut-position")) as {
      "shortcut-position"?: ShortcutPosition;
    };
    const saved = stored["shortcut-position"];
    if (saved) {
      pos.value.side = saved.side;
      pos.value.y = saved.y;
    }
  } catch {
    // ignore storage failures
  }

  await nextTick();
  snapToEdge(pos.value.side);
}

async function savePosition() {
  try {
    const payload: ShortcutPosition = {
      side: pos.value.side,
      y: pos.value.y,
    };
    await browser.storage.local.set({ "shortcut-position": payload });
  } catch {
    // ignore storage failures
  }
}

function getCurrentPageKey() {
  // 使用域名/IP 作为存储键，不包含路径
  return `hidden-host:${window.location.hostname}`;
}

async function loadHiddenState() {
  try {
    const key = getCurrentPageKey();
    const stored = await browser.storage.local.get(key);
    isHiddenForPage.value = !!stored[key];
  } catch {
    // ignore storage failures
  }
}

async function hideForCurrentPage() {
  try {
    const key = getCurrentPageKey();
    await browser.storage.local.set({ [key]: true });
    isHiddenForPage.value = true;
  } catch {
    // ignore storage failures
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  isDragging.value = false;
  dragStart.value = {
    x: pos.value.x,
    y: pos.value.y,
    pointerX: event.clientX,
    pointerY: event.clientY,
  };
  const target = event.currentTarget as HTMLElement | null;
  target?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (dragStart.value.pointerX === 0 && dragStart.value.pointerY === 0) return;

  const deltaX = event.clientX - dragStart.value.pointerX;
  const deltaY = event.clientY - dragStart.value.pointerY;
  if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) isDragging.value = true;

  if (!isDragging.value) return;

  const { width, height } = getContainerSize();
  const maxX = window.innerWidth - width;
  const maxY = window.innerHeight - height;
  pos.value.x = clamp(dragStart.value.x + deltaX, 0, maxX);
  pos.value.y = clamp(dragStart.value.y + deltaY, 0, maxY);
}

async function onPointerUp(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement | null;
  target?.releasePointerCapture(event.pointerId);

  const wasDragging = isDragging.value;
  isDragging.value = false;
  dragStart.value = { x: 0, y: 0, pointerX: 0, pointerY: 0 };

  if (wasDragging) {
    const nextSide =
      event.clientX < window.innerWidth / 2 ? "left" : "right";
    snapToEdge(nextSide);
    await savePosition();
  }
}

async function uploadBookmarks() {
  if (uploadState.value === "loading") return;
  uploadState.value = "loading";
  try {
    const result = await sendMessage("sync-upload", undefined, "background");
    uploadState.value = result?.ok ? "success" : "error";
  } catch {
    uploadState.value = "error";
  }
  setTimeout(() => (uploadState.value = "idle"), 2000);
}

async function downloadBookmarks() {
  if (downloadState.value === "loading") return;
  downloadState.value = "loading";
  try {
    const result = await sendMessage("sync-download", undefined, "background");
    downloadState.value = result?.ok ? "success" : "error";
  } catch {
    downloadState.value = "error";
  }
  setTimeout(() => (downloadState.value = "idle"), 2000);
}

function requestClearBookmarks() {
  // 显示双击提示
  showClearHint.value = true;
  if (clearClickTimer) clearTimeout(clearClickTimer);
  clearClickTimer = setTimeout(() => {
    showClearHint.value = false;
  }, 2000);
}

async function handleClearDoubleClick() {
  if (clearState.value === "loading") return;
  showClearHint.value = false;
  if (clearClickTimer) clearTimeout(clearClickTimer);
  clearState.value = "loading";
  try {
    const result = await sendMessage("clear-bookmarks", {}, "background");
    clearState.value = (result as { ok?: boolean })?.ok ? "success" : "error";
  } catch {
    clearState.value = "error";
  }
  setTimeout(() => (clearState.value = "idle"), 2000);
}

async function openSidePanel() {
  await sendMessage("open-sidepanel", undefined, "background");
}

function onResize() {
  snapToEdge(pos.value.side);
}

function detectDarkMode() {
  const html = document.documentElement;
  const body = document.body;
  
  // 检测常见的暗黑模式类名和属性
  const darkClasses = ['dark', 'dark-mode', 'theme-dark', 'night'];
  const hasDarkClass = darkClasses.some(cls => 
    html.classList.contains(cls) || body?.classList.contains(cls)
  );
  
  // 检测 data-theme 属性
  const dataTheme = html.getAttribute('data-theme') || body?.getAttribute('data-theme') || '';
  const colorScheme = html.getAttribute('data-color-scheme') || body?.getAttribute('data-color-scheme') || '';
  const hasDarkTheme = ['dark', 'night'].some(t => 
    dataTheme.toLowerCase().includes(t) || colorScheme.toLowerCase().includes(t)
  );
  
  // 检测 style 属性中的 color-scheme
  const styleColorScheme = getComputedStyle(html).colorScheme || '';
  const hasStyleDark = styleColorScheme.includes('dark');
  
  // 检测系统媒体查询
  const prefersColorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  // 检测背景色亮度
  const bgColor = getComputedStyle(body || html).backgroundColor;
  let isBackgroundDark = false;
  if (bgColor && bgColor !== 'transparent' && bgColor !== 'rgba(0, 0, 0, 0)') {
    const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const [, r, g, b] = match.map(Number);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      isBackgroundDark = luminance < 0.5;
    }
  }
  
  // 综合判断：优先使用页面配置，其次是系统配置
  isDarkMode.value = hasDarkClass || hasDarkTheme || hasStyleDark || isBackgroundDark || prefersColorScheme;
}

function setupDarkModeDetection() {
  // 初始检测
  detectDarkMode();
  
  // 监听 DOM 变化
  darkModeObserver = new MutationObserver(() => {
    detectDarkMode();
  });
  
  darkModeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'style'],
  });
  
  if (document.body) {
    darkModeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'style'],
    });
  }
  
  // 监听系统主题变化
  darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  darkModeMediaQuery.addEventListener('change', detectDarkMode);
}

function cleanupDarkModeDetection() {
  if (darkModeObserver) {
    darkModeObserver.disconnect();
    darkModeObserver = null;
  }
  if (darkModeMediaQuery) {
    darkModeMediaQuery.removeEventListener('change', detectDarkMode);
    darkModeMediaQuery = null;
  }
}

onMounted(() => {
  void (async () => {
    await loadHiddenState();
    if (!isHiddenForPage.value) {
      await loadPosition();
      isReady.value = true;
    }
  })();
  window.addEventListener("resize", onResize);
  setupDarkModeDetection();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  cleanupDarkModeDetection();
});
</script>

<template>
  <div
    v-if="!isHiddenForPage"
    ref="containerRef"
    class="shortcut"
    :class="[
      { 'is-dragging': isDragging, 'is-hover': isHovering, 'is-loading': !isReady, 'is-dark': isDarkMode },
      `side-${pos.side}`,
    ]"
    :style="containerStyle"
    @mouseenter="updateHoverByPointer"
    @mousemove="updateHoverByPointer"
    @mouseleave="delayedHoverHide"
  >
    <!-- 关闭按钮（悬浮时显示） -->
    <button 
      class="close-btn" 
      @click.stop="hideForCurrentPage"
      @mouseenter="isHoveringCloseBtn = true; cancelHoverHide()"
      @mouseleave="isHoveringCloseBtn = false; delayedHoverHide()"
    >
      <ph-x class="close-icon" />
    </button>
    <!-- 侧边栏按钮（独立于主按钮） -->
    <div class="sidebar-item">
      <button class="sidebar-btn" @click="openSidePanel">
        <ph-sidebar-simple class="sidebar-icon" />
      </button>
      <span class="sidebar-label">打开侧边栏</span>
    </div>

    <!-- 常驻主按钮 -->
    <div class="main-buttons">
      <button
        class="shortcut-btn"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <img class="icon-logo" :src="logoUrl"/>
      </button>
    </div>

    <!-- 悬浮展示的操作按钮 -->
    <div
      class="actions"
      @pointerdown.stop
      @pointerup.stop
      @mouseenter="isHoveringActions = true"
      @mouseleave="isHoveringActions = false"
    >
      <div class="action-item">
        <button 
          class="action-btn" 
          :class="[`state-${uploadState}`]"
          :disabled="uploadState === 'loading'"
          @click="uploadBookmarks"
        >
          <ph-spinner v-if="uploadState === 'loading'" class="icon spin" />
          <ph-check-circle v-else-if="uploadState === 'success'" class="icon" />
          <ph-x-circle v-else-if="uploadState === 'error'" class="icon" />
          <ph-cloud-arrow-up v-else class="icon" />
        </button>
        <span class="action-label">上传书签</span>
      </div>
      <div class="action-item">
        <button 
          class="action-btn" 
          :class="[`state-${downloadState}`]"
          :disabled="downloadState === 'loading'"
          @click="downloadBookmarks"
        >
          <ph-spinner v-if="downloadState === 'loading'" class="icon spin" />
          <ph-check-circle v-else-if="downloadState === 'success'" class="icon" />
          <ph-x-circle v-else-if="downloadState === 'error'" class="icon" />
          <ph-cloud-arrow-down v-else class="icon" />
        </button>
        <span class="action-label">下载书签</span>
      </div>
      <div class="action-item">
        <button 
          class="action-btn danger" 
          :class="[`state-${clearState}`]"
          :disabled="clearState === 'loading'"
          @click="requestClearBookmarks"
          @dblclick="handleClearDoubleClick"
        >
          <ph-spinner v-if="clearState === 'loading'" class="icon spin" />
          <ph-check-circle v-else-if="clearState === 'success'" class="icon" />
          <ph-x-circle v-else-if="clearState === 'error'" class="icon" />
          <ph-trash v-else class="icon" />
        </button>
        <span class="action-label" :class="{ 'hint-visible': showClearHint }">
          {{ showClearHint ? '双击清除本地书签' : '清除本地书签' }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcut {
  position: fixed;
  z-index: 999999;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-family: "Inter", "SF Pro Display", "Noto Sans SC", system-ui, sans-serif;
  user-select: none;
  transition: opacity 250ms cubic-bezier(0.4, 0, 0.2, 1);
  filter: drop-shadow(0 8px 32px rgba(0, 0, 0, 0.12)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.08));
  
  /* 现代化配色变量 */
  --glass-bg: rgba(255, 255, 255, 0.88);
  --glass-bg-soft: rgba(255, 255, 255, 0.65);
  --glass-border: rgba(255, 255, 255, 0.5);
  --glass-border-outer: rgba(0, 0, 0, 0.06);
  --label-bg: linear-gradient(135deg, rgba(30, 30, 35, 0.95), rgba(20, 20, 25, 0.98));
  --label-text: #f8fafc;
  --accent: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  --accent-solid: #667eea;
  --danger: #ef4444;
  --danger-soft: rgba(239, 68, 68, 0.12);
  --success: #10b981;
  --success-soft: rgba(16, 185, 129, 0.12);
  
  /* 阴影层次 */
  --shadow-elev: 0 20px 40px rgba(0, 0, 0, 0.12), 0 8px 16px rgba(0, 0, 0, 0.08);
  --shadow-soft: 0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04);
  --shadow-glow: 0 0 20px rgba(102, 126, 234, 0.15);
  
  /* 按钮样式 */
  --btn-bg: rgba(0, 0, 0, 0.04);
  --btn-border: rgba(0, 0, 0, 0.08);
  --btn-solid: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  --btn-solid-hover: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
  --btn-solid-loading: linear-gradient(180deg, #eef2ff 0%, #e0e7ff 100%);
  --btn-solid-success: linear-gradient(180deg, #d1fae5 0%, #a7f3d0 100%);
  --btn-solid-error: linear-gradient(180deg, #fee2e2 0%, #fecaca 100%);
  --btn-solid-danger: linear-gradient(180deg, #fee2e2 0%, #fecaca 100%);
}

/* 关闭按钮 */
.close-btn {
  position: absolute;
  top: 65px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: none;
  background: rgba(166, 166, 167, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-shadow: 0 1px 3px rgba(69, 69, 69, 0.1);
  cursor: pointer;
  opacity: 0;
  transform: scale(0.8);
  transition: 
    opacity 200ms ease, 
    transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background 200ms ease,
    box-shadow 200ms ease;
  z-index: 9999;
}

.shortcut.side-right .close-btn {
  left: -30px
}

.shortcut.side-left .close-btn {
  right: -30px;
}

.close-icon {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.85);
  transition: color 200ms ease, transform 200ms ease;
  display: block;
}

.shortcut.is-hover:not(.is-dragging) .close-btn {
  opacity: 1;
  transform: scale(1);
}

/* 拖动时隐藏关闭按钮 */
.shortcut.is-dragging .close-btn {
  opacity: 0;
  pointer-events: none;
}

.close-btn:hover {
  background: rgba(220, 60, 60, 0.9);
  transform: scale(1.15);
  box-shadow: 0 3px 10px rgba(220, 60, 60, 0.4);
}

.close-btn:hover .close-icon {
  color: #fff;
  transform: scale(1.1);
}

.shortcut.is-loading {
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

.shortcut.side-right {
  align-items: flex-end;
}

.shortcut.side-left {
  align-items: flex-start;
}

.shortcut.is-dragging {
  transition: none;
}

/* 常驻按钮组 */
.main-buttons {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  position: relative;
  transition: transform 380ms cubic-bezier(0.22, 0.8, 0.25, 1);
}

.shortcut-btn {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: none;
  background: #ff9a7a;
  color: #333;
  display: grid;
  place-items: center;
  box-shadow: 
    0 3px 12px rgba(0, 0, 0, 0.15),
    0 1px 4px rgba(0, 0, 0, 0.1),
    inset 0 1px 1px rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: 
    transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1), 
    opacity 300ms ease;
  opacity: 0.5;
  touch-action: none;
  position: relative;
  z-index: 2;
}

/* 拖动时立即还原圆形，无动画 */
.shortcut.is-dragging .shortcut-btn {
  border-radius: 999px !important;
  border-color: rgba(0, 0, 0, 0.08) !important;
  transition: none;
}

/* 右侧样式 - 非拖动时显示 */
.shortcut.side-right:not(.is-dragging) .shortcut-btn {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right-color: transparent;
}

/* 左侧样式 - 非拖动时显示 */
.shortcut.side-left:not(.is-dragging) .shortcut-btn {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left-color: transparent;
}

/* 背景延伸效果 - 右侧 */
.shortcut.side-right .shortcut-btn::before {
  content: '';
  position: absolute;
  top: -1px;
  bottom: -1px;
  left: -1px;
  right: -28px;
  background: linear-gradient(150deg, var(--glass-bg), var(--glass-bg-soft));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--glass-border);
  border-top-left-radius: 999px;
  border-bottom-left-radius: 999px;
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
  z-index: -1;
  opacity: 1;
  transition: opacity 280ms ease;
}

/* 背景延伸效果 - 左侧 */
.shortcut.side-left .shortcut-btn::before {
  content: '';
  position: absolute;
  top: -1px;
  bottom: -1px;
  right: -1px;
  left: -28px;
  background: linear-gradient(150deg, var(--glass-bg), var(--glass-bg-soft));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--glass-border);
  border-top-right-radius: 999px;
  border-bottom-right-radius: 999px;
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
  z-index: -1;
  opacity: 1;
  transition: opacity 280ms ease;
}

/* 拖动时立即隐藏延伸部分，无动画 */
.shortcut.is-dragging .shortcut-btn::before {
  opacity: 0;
  transition: none;
}

/* 贴边时保持圆形背景 */
.shortcut.side-right:not(.is-dragging) .shortcut-btn,
.shortcut.side-left:not(.is-dragging) .shortcut-btn {
  border: none;
}

.sidebar-btn {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: none;
  background: linear-gradient(145deg, #ffffff, #f1f5f9);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 
    0 2px 10px rgba(0, 0, 0, 0.11),
    0 1px 3px rgba(0, 0, 0, 0.08),
    inset 0 1px 1px rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: 
    transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1), 
    opacity 300ms ease, 
    background 300ms ease,
    box-shadow 300ms ease;
  opacity: 0.6;
}

.sidebar-item {
  position: relative;
  display: flex;
  align-items: center;
}

.sidebar-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--label-text);
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--label-bg);
  box-shadow: 
    0 8px 24px rgba(0, 0, 0, 0.2),
    0 2px 8px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px) scale(0.95);
  transition: 
    opacity 200ms cubic-bezier(0.4, 0, 0.2, 1), 
    transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  position: absolute;
}

.shortcut.side-right .sidebar-label {
  right: 100%;
  margin-right: 8px;
}

.shortcut.side-left .sidebar-label {
  left: 100%;
  margin-left: 8px;
}

.sidebar-item:hover .sidebar-label {
  opacity: 1;
  transform: translateY(0);
}

.sidebar-icon {
  font-size: 14px;
  color: #64748b;
  display: block;
  transition: color 200ms ease, transform 200ms ease;
}

.shortcut.is-hover .shortcut-btn,
.shortcut.is-dragging .shortcut-btn {
  opacity: 1;
  filter: none;
}

.shortcut.is-hover .sidebar-btn,
.shortcut.is-dragging .sidebar-btn {
  opacity: 1;
}

/* 拖动时隐藏侧边栏按钮 */
.shortcut.is-dragging .sidebar-item {
  opacity: 0;
  pointer-events: none;
  transition: none;
}

.sidebar-btn:hover {
  background: linear-gradient(145deg, rgba(255, 255, 255, 1), rgba(248, 250, 252, 0.95));
  transform: scale(1.08);
  box-shadow: 
    0 8px 20px rgba(0, 0, 0, 0.12),
    0 2px 8px rgba(0, 0, 0, 0.08),
    inset 0 1px 1px rgba(255, 255, 255, 1),
    0 0 0 3px rgba(102, 126, 234, 0.1);
}

.sidebar-btn:hover .sidebar-icon {
  color: var(--accent-solid);
  transform: scale(1.05);
}

.shortcut.is-hover.side-right .main-buttons {
  transform: translateX(-12px);
}

.shortcut.is-hover.side-left .main-buttons {
  transform: translateX(12px);
}

/* 侧边栏按钮独立移动，只移动一小段距离 */
.shortcut.is-hover.side-right .sidebar-item {
  transform: translateX(-4px);
}

.shortcut.is-hover.side-left .sidebar-item {
  transform: translateX(4px);
}

.sidebar-item {
  transition: transform 380ms cubic-bezier(0.22, 0.8, 0.25, 1);
}

.icon {
  font-size: 14px;
  color: #94a3b8;
  pointer-events: none;
  transition: color 200ms ease, transform 200ms ease;
}

.icon-logo {
  width: 24px;
  height: 24px;
  display: block;
  object-fit: contain;
  object-position: center;
  pointer-events: none;
}

/* 悬浮操作按钮 */
.actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-8px) scale(0.95);
  transition: opacity 320ms ease, transform 420ms cubic-bezier(0.22, 0.8, 0.25, 1), visibility 0ms 320ms;
  pointer-events: none;
}

.shortcut.side-right .actions {
  align-self: flex-end;
  transform: translateX(6px) translateY(-8px) scale(0.95);
}

.shortcut.side-left .actions {
  align-self: flex-start;
  transform: translateX(-6px) translateY(-8px) scale(0.95);
}

.action-item {
  display: flex;
  align-items: center;
  position: relative;
}

.shortcut.side-right .action-item {
  flex-direction: row-reverse;
}

.action-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--label-text);
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--label-bg);
  box-shadow: 
    0 8px 24px rgba(0, 0, 0, 0.2),
    0 2px 8px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px) scale(0.95);
  transition: 
    opacity 150ms cubic-bezier(0.4, 0, 0.2, 1), 
    transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1);
  position: absolute;
}

.shortcut.side-right .action-label {
  right: 100%;
  margin-right: 8px;
}

.shortcut.side-left .action-label {
  left: 100%;
  margin-left: 8px;
}

.action-item:hover .action-label {
  opacity: 1;
  transform: translateY(0);
}

.action-label.hint-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: #fff;
  box-shadow: 
    0 8px 24px rgba(239, 68, 68, 0.35),
    0 2px 8px rgba(239, 68, 68, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
  animation: pulse-danger 1.2s ease-in-out infinite;
}

@keyframes pulse-danger {
  0%, 100% { 
    opacity: 1; 
    transform: translateY(0) scale(1);
  }
  50% { 
    opacity: 0.9; 
    transform: translateY(0) scale(1.02);
  }
}

.shortcut.is-hover .actions,
.shortcut.is-dragging .actions {
  opacity: 1;
  visibility: visible;
  transform: translateY(4px) scale(1);
  pointer-events: auto;
  transition: opacity 320ms ease, transform 420ms cubic-bezier(0.22, 0.8, 0.25, 1), visibility 0ms;
}

/* 拖动时隐藏操作按钮 */
.shortcut.is-dragging .actions {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
  transition: none !important;
}

.shortcut.is-hover.side-right .actions,
.shortcut.is-dragging.side-right .actions {
  transform: translateX(-6px) translateY(4px) scale(1);
}

.shortcut.is-hover.side-left .actions,
.shortcut.is-dragging.side-left .actions {
  transform: translateX(6px) translateY(4px) scale(1);
}

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 10px;
  border: none;
  background: linear-gradient(180deg, #ffffff 0%, #f1f5f9 100%);
  backdrop-filter: blur(12px) saturate(150%);
  -webkit-backdrop-filter: blur(12px) saturate(150%);
  color: #1e293b;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 
    0 3px 12px rgba(0, 0, 0, 0.11),
    0 1px 4px rgba(0, 0, 0, 0.08),
    inset 0 1px 1px rgba(255, 255, 255, 0.9);
  cursor: pointer;
  opacity: 0;
  transform: translateY(10px) scale(0.9);
  transition: 
    transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1), 
    opacity 250ms ease, 
    box-shadow 300ms ease, 
    background 300ms ease;
}

.action-btn .icon {
  display: block;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: #475569;
  transition: color 200ms ease, transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.action-btn:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.action-btn.danger {
  background: linear-gradient(180deg, #fef2f2 0%, #fee2e2 100%);
}

.action-btn.danger .icon {
  color: var(--danger);
}

.action-btn.state-loading {
  background: var(--btn-solid-loading);
}

.action-btn.state-success {
  background: var(--btn-solid-success);
}

.action-btn.state-success .icon {
  color: #2f9f5d;
}

.action-btn.state-error {
  background: var(--btn-solid-error);
}

.action-btn.state-error .icon {
  color: var(--danger);
}

.spin {
  animation: spin 0.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.shortcut.is-hover .action-btn,
.shortcut.is-dragging .action-btn {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.shortcut.is-hover .action-item:nth-child(1) .action-btn {
  transition-delay: 60ms;
}

.shortcut.is-hover .action-item:nth-child(2) .action-btn {
  transition-delay: 120ms;
}

.shortcut.is-hover .action-item:nth-child(3) .action-btn {
  transition-delay: 180ms;
}

.action-btn:hover:not(:disabled) {
  transform: translateY(-2px) scale(1.05);
  background: var(--btn-solid-hover);
  box-shadow: 
    0 12px 24px rgba(0, 0, 0, 0.12),
    0 4px 8px rgba(0, 0, 0, 0.08),
    inset 0 1px 1px rgba(255, 255, 255, 0.9),
    0 0 0 3px rgba(102, 126, 234, 0.08);
}

.action-btn:hover:not(:disabled) .icon {
  color: var(--accent-solid);
  transform: scale(1.1);
}

.action-btn.danger:hover:not(:disabled) {
  background: linear-gradient(180deg, #fee2e2 0%, #fecaca 100%);
  box-shadow: 
    0 12px 24px rgba(239, 68, 68, 0.15),
    0 4px 8px rgba(239, 68, 68, 0.1),
    inset 0 1px 1px rgba(255, 255, 255, 0.9),
    0 0 0 3px rgba(239, 68, 68, 0.1);
}

.action-btn.danger:hover:not(:disabled) .icon {
  color: #dc2626;
  transform: scale(1.1);
}

@media (prefers-color-scheme: dark) {
  .shortcut {
    --glass-bg: rgba(52, 52, 52, 0.85);
    --glass-bg-soft: rgba(52, 52, 52, 0.6);
    --glass-border: rgba(255, 255, 255, 0.12);
    --label-bg: rgba(20, 20, 20, 0.92);
    --label-text: #e9efee;
    --btn-bg: rgba(255, 255, 255, 0.12);
    --btn-border: rgba(255, 255, 255, 0.18);
    --btn-solid: #2a2f33;
    --btn-solid-hover: #343a3f;
    --btn-solid-loading: #2a3346;
    --btn-solid-success: #24352c;
    --btn-solid-error: #3a2628;
    --btn-solid-danger: #3c2427;
  }

  .shortcut-btn {
    background: rgba(50, 50, 50, 0.8);
    border-color: rgba(255, 255, 255, 0.12);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .shortcut.is-dragging .shortcut-btn {
    border-color: rgba(255, 255, 255, 0.12) !important;
  }

  .shortcut.side-right .shortcut-btn::before,
  .shortcut.side-left .shortcut-btn::before {
    background: rgba(50, 50, 50, 0.8);
    border-color: rgba(255, 255, 255, 0.12);
  }

  .sidebar-btn {
    background: linear-gradient(145deg, #3f3f46, #27272a);
    box-shadow: 
      0 4px 16px rgba(0, 0, 0, 0.4),
      0 2px 6px rgba(0, 0, 0, 0.3),
      inset 0 1px 1px rgba(255, 255, 255, 0.1);
  }

  .sidebar-icon {
    color: rgba(255, 255, 255, 0.7);
  }

  .sidebar-btn:hover {
    background: linear-gradient(145deg, #52525b, #3f3f46);
    box-shadow: 
      0 6px 20px rgba(0, 0, 0, 0.5),
      0 2px 8px rgba(0, 0, 0, 0.4),
      inset 0 1px 1px rgba(255, 255, 255, 0.15);
  }

  .sidebar-btn:hover .sidebar-icon {
    color: #fff;
  }

  .action-btn {
    background: linear-gradient(180deg, #3f3f46 0%, #27272a 100%);
    box-shadow: 
      0 4px 16px rgba(0, 0, 0, 0.4),
      0 2px 6px rgba(0, 0, 0, 0.3),
      inset 0 1px 1px rgba(255, 255, 255, 0.08);
  }

  .action-btn .icon {
    color: rgba(255, 255, 255, 0.7);
  }

  .action-btn:hover:not(:disabled) {
    background: linear-gradient(180deg, #52525b 0%, #3f3f46 100%);
    box-shadow: 
      0 8px 24px rgba(0, 0, 0, 0.5),
      0 4px 10px rgba(0, 0, 0, 0.4),
      inset 0 1px 1px rgba(255, 255, 255, 0.12);
  }

  .action-btn:hover:not(:disabled) .icon {
    color: #fff;
  }

  .action-btn.danger {
    background: linear-gradient(180deg, #451a1a 0%, #2d1515 100%);
  }

  .action-btn.danger .icon {
    color: #f87171;
  }

  .action-btn.danger:hover:not(:disabled) {
    background: linear-gradient(180deg, #5c2424 0%, #451a1a 100%);
  }

  .action-btn.state-loading {
    background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
  }

  .action-btn.state-success {
    background: linear-gradient(180deg, #14532d 0%, #052e16 100%);
  }

  .action-btn.state-success .icon {
    color: #4ade80;
  }

  .action-btn.state-error {
    background: linear-gradient(180deg, #450a0a 0%, #2d0a0a 100%);
  }

  .action-btn.state-error .icon {
    color: #f87171;
  }

  .icon {
    color: #d4d4d8;
  }

  .action-label {
    color: #e4e4e7;
    background: linear-gradient(135deg, #27272a 0%, #18181b 100%);
    box-shadow: 
      0 8px 24px rgba(0, 0, 0, 0.5),
      0 2px 8px rgba(0, 0, 0, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }

  .confirm-dialog {
    background: #1c1c1c;
  }

  .confirm-title {
    color: #e0e0e0;
  }

  .confirm-desc {
    color: #999;
  }

  .confirm-btn.cancel {
    background: #333;
    color: #e0e0e0;
  }

  .confirm-btn.cancel:hover {
    background: #444;
  }

  /* 关闭按钮暗黑模式 */
  .close-btn {
    background: rgba(60, 60, 70, 0.7);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  }

  .close-icon {
    color: rgba(255, 255, 255, 0.7);
  }

  .close-btn:hover {
    background: rgba(180, 80, 80, 0.85);
  }

  .close-btn:hover .close-icon {
    color: #fff;
  }
}

/* JS 检测的暗黑模式样式 */
.shortcut.is-dark {
  --glass-bg: rgba(52, 52, 52, 0.85);
  --glass-bg-soft: rgba(52, 52, 52, 0.6);
  --glass-border: rgba(255, 255, 255, 0.12);
  --label-bg: rgba(20, 20, 20, 0.92);
  --label-text: #e9efee;
  --btn-bg: rgba(255, 255, 255, 0.12);
  --btn-border: rgba(255, 255, 255, 0.18);
  --btn-solid: #2a2f33;
  --btn-solid-hover: #343a3f;
  --btn-solid-loading: #2a3346;
  --btn-solid-success: #24352c;
  --btn-solid-error: #3a2628;
  --btn-solid-danger: #3c2427;
}

.shortcut.is-dark .shortcut-btn {
  background: rgba(50, 50, 50, 0.8);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.shortcut.is-dark.is-dragging .shortcut-btn {
  border-color: rgba(255, 255, 255, 0.12) !important;
}

.shortcut.is-dark.side-right .shortcut-btn::before,
.shortcut.is-dark.side-left .shortcut-btn::before {
  background: rgba(50, 50, 50, 0.8);
  border-color: rgba(255, 255, 255, 0.12);
}

.shortcut.is-dark .sidebar-btn {
  background: linear-gradient(145deg, #3f3f46, #27272a);
  box-shadow: 
    0 4px 16px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3),
    inset 0 1px 1px rgba(255, 255, 255, 0.1);
}

.shortcut.is-dark .sidebar-icon {
  color: rgba(255, 255, 255, 0.7);
}

.shortcut.is-dark .sidebar-btn:hover {
  background: linear-gradient(145deg, #52525b, #3f3f46);
  box-shadow: 
    0 6px 20px rgba(0, 0, 0, 0.5),
    0 2px 8px rgba(0, 0, 0, 0.4),
    inset 0 1px 1px rgba(255, 255, 255, 0.15);
}

.shortcut.is-dark .sidebar-btn:hover .sidebar-icon {
  color: #fff;
}

.shortcut.is-dark .action-btn {
  background: linear-gradient(180deg, #3f3f46 0%, #27272a 100%);
  box-shadow: 
    0 4px 16px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3),
    inset 0 1px 1px rgba(255, 255, 255, 0.08);
}

.shortcut.is-dark .action-btn .icon {
  color: rgba(255, 255, 255, 0.7);
}

.shortcut.is-dark .action-btn:hover:not(:disabled) {
  background: linear-gradient(180deg, #52525b 0%, #3f3f46 100%);
  box-shadow: 
    0 8px 24px rgba(0, 0, 0, 0.5),
    0 4px 10px rgba(0, 0, 0, 0.4),
    inset 0 1px 1px rgba(255, 255, 255, 0.12);
}

.shortcut.is-dark .action-btn:hover:not(:disabled) .icon {
  color: #fff;
}

.shortcut.is-dark .action-btn.danger {
  background: linear-gradient(180deg, #451a1a 0%, #2d1515 100%);
}

.shortcut.is-dark .action-btn.danger .icon {
  color: #f87171;
}

.shortcut.is-dark .action-btn.danger:hover:not(:disabled) {
  background: linear-gradient(180deg, #5c2424 0%, #451a1a 100%);
}

.shortcut.is-dark .action-btn.state-loading {
  background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
}

.shortcut.is-dark .action-btn.state-success {
  background: linear-gradient(180deg, #14532d 0%, #052e16 100%);
}

.shortcut.is-dark .action-btn.state-success .icon {
  color: #4ade80;
}

.shortcut.is-dark .action-btn.state-error {
  background: linear-gradient(180deg, #450a0a 0%, #2d0a0a 100%);
}

.shortcut.is-dark .action-btn.state-error .icon {
  color: #f87171;
}

.shortcut.is-dark .icon {
  color: #d4d4d8;
}

.shortcut.is-dark .action-label {
  color: #e4e4e7;
  background: linear-gradient(135deg, #27272a 0%, #18181b 100%);
  box-shadow: 
    0 8px 24px rgba(0, 0, 0, 0.5),
    0 2px 8px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.shortcut.is-dark .close-btn {
  background: rgba(60, 60, 70, 0.7);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.shortcut.is-dark .close-icon {
  color: rgba(255, 255, 255, 0.7);
}

.shortcut.is-dark .close-btn:hover {
  background: rgba(180, 80, 80, 0.85);
}

.shortcut.is-dark .close-btn:hover .close-icon {
  color: #fff;
}
</style>
