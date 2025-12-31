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
const isHovering = computed(
  () => isHoveringShortcut.value || isHoveringActions.value,
);
const isReady = ref(false);
const pos = ref({ x: 0, y: 120, side: "right" as ShortcutPosition["side"] });
const dragStart = ref({ x: 0, y: 0, pointerX: 0, pointerY: 0 });
const hoverActivationWidth = 52;

// 操作反馈状态
const uploadState = ref<FeedbackState>("idle");
const downloadState = ref<FeedbackState>("idle");
const clearState = ref<FeedbackState>("idle");
const showClearHint = ref(false);
let clearClickTimer: ReturnType<typeof setTimeout> | null = null;

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
  const edgePadding = 8;
  const inferredSide =
    side || (pos.value.x + width / 2 < viewportWidth / 2 ? "left" : "right");
  const leftInset =
    scrollbar.width > 0 && scrollbar.onLeft ? scrollbar.width : 0;
  const rightInset =
    scrollbar.width > 0 && !scrollbar.onLeft ? scrollbar.width : 0;
  const x =
    inferredSide === "left"
      ? leftInset + edgePadding
      : viewportWidth - width - rightInset - edgePadding;
  const y = clamp(pos.value.y, 12, Math.max(12, viewportHeight - height - 12));
  pos.value = { x, y, side: inferredSide };
}

function updateHoverByPointer(event: MouseEvent) {
  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  const distance =
    pos.value.side === "right"
      ? rect.right - event.clientX
      : event.clientX - rect.left;
  isHoveringShortcut.value = distance <= hoverActivationWidth;
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

onMounted(() => {
  void (async () => {
    await loadPosition();
    isReady.value = true;
  })();
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <div
    ref="containerRef"
    class="shortcut"
    :class="[
      { 'is-dragging': isDragging, 'is-hover': isHovering, 'is-loading': !isReady },
      `side-${pos.side}`,
    ]"
    :style="containerStyle"
    @mouseenter="updateHoverByPointer"
    @mousemove="updateHoverByPointer"
    @mouseleave="isHoveringShortcut = false"
  >
    <!-- 常驻按钮组 -->
    <div class="main-buttons">
      <div class="sidebar-item">
        <button class="sidebar-btn" @click="openSidePanel">
          <ph-sidebar-simple class="sidebar-icon" />
        </button>
        <span class="sidebar-label">打开侧边栏</span>
      </div>
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
  gap: 8px;
  font-family: "Space Grotesk", "Noto Sans", "Segoe UI", sans-serif;
  user-select: none;
  transition: opacity 200ms ease;
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
  gap: 6px;
  position: relative;
}

.shortcut-btn {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #333;
  display: grid;
  place-items: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  cursor: pointer;
  transition: transform 280ms ease, opacity 280ms ease, filter 280ms ease, border-radius 280ms ease, border-color 280ms ease;
  opacity: 0.6;
  filter: grayscale(0.2);
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
  right: -16px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-top-left-radius: 999px;
  border-bottom-left-radius: 999px;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
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
  left: -16px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-top-right-radius: 999px;
  border-bottom-right-radius: 999px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  z-index: -1;
  opacity: 1;
  transition: opacity 280ms ease;
}

/* 拖动时立即隐藏延伸部分，无动画 */
.shortcut.is-dragging .shortcut-btn::before {
  opacity: 0;
  transition: none;
}

.sidebar-btn {
  width: 28px;
  height: 28px;
  border-radius: 10px;
  border: none;
  background: rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 12px rgba(9, 20, 18, 0.1);
  cursor: pointer;
  transition: transform 280ms ease, opacity 280ms ease, background 280ms ease;
  opacity: 0.5;
}

.sidebar-item {
  position: relative;
  display: flex;
  align-items: center;
}

.sidebar-label {
  font-size: 12px;
  color: #fff;
  padding: 2px 6px;
  border-radius: 8px;
  background: #1c1c1c;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 150ms ease, transform 150ms ease;
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
  font-size: 16px;
  color: #555;
  display: block;
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
  background: rgba(0, 0, 0, 0.12);
  transform: scale(1.05);
}

.sidebar-btn:hover .sidebar-icon {
  color: #333;
}

.shortcut.is-hover.side-right .main-buttons {
  transform: translateX(-6px);
}

.shortcut.is-hover.side-left .main-buttons {
  transform: translateX(6px);
}

.icon {
  font-size: 16px;
  color: #b7bcbc;
  pointer-events: none;
}

.icon-logo {
  width: 20px;
  height: 20px;
  display: block;
  object-fit: contain;
  pointer-events: none;
}

/* 悬浮操作按钮 */
.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-8px) scale(0.95);
  transition: opacity 250ms ease, transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1), visibility 0ms 250ms;
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
  font-size: 12px;
  color: #fff;
  padding: 2px 6px;
  border-radius: 8px;
  background: #1c1c1c;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 80ms ease, transform 80ms ease;
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
  transform: translateY(0);
  background: #dc3545;
  color: #fff;
  animation: pulse 0.5s ease-in-out infinite alternate;
}

@keyframes pulse {
  from { opacity: 0.8; }
  to { opacity: 1; }
}

.shortcut.is-hover .actions,
.shortcut.is-dragging .actions {
  opacity: 1;
  visibility: visible;
  transform: translateY(4px) scale(1);
  pointer-events: auto;
  transition: opacity 250ms ease, transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1), visibility 0ms;
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
  background: rgba(0, 0, 0, 0.06);
  color: #1c1c1c;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(10, 22, 20, 0.08);
  cursor: pointer;
  opacity: 0;
  transform: translateY(8px);
  transition: transform 280ms ease, opacity 200ms ease, box-shadow 280ms ease, background 280ms ease;
}

.action-btn .icon {
  display: block;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: #555;
}

.action-btn:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.action-btn.danger {
  background: #fce8e8;
}

.action-btn.danger .icon {
  color: #d64545;
}

.action-btn.state-loading {
  background: #f0f4ff;
}

.action-btn.state-success {
  background: #e8f5e9;
}

.action-btn.state-success .icon {
  color: #4caf50;
}

.action-btn.state-error {
  background: #ffebee;
}

.action-btn.state-error .icon {
  color: #f44336;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.shortcut.is-hover .action-btn,
.shortcut.is-dragging .action-btn {
  opacity: 1;
  transform: translateY(0);
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
  transform: translateY(-1px);
  background: rgba(0, 0, 0, 0.12);
}

.action-btn:hover:not(:disabled) .icon {
  color: #333;
}

.action-btn.danger:hover:not(:disabled) {
  background: #f8d5d5;
}

.action-btn.danger:hover:not(:disabled) .icon {
  color: #c0392b;
}

@media (prefers-color-scheme: dark) {
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
    background: rgba(255, 255, 255, 0.1);
  }

  .sidebar-icon {
    color: rgba(255, 255, 255, 0.6);
  }

  .sidebar-btn:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .sidebar-btn:hover .sidebar-icon {
    color: #fff;
  }

  .action-btn {
    background: rgba(255, 255, 255, 0.1);
    box-shadow: 0 10px 18px rgba(0, 0, 0, 0.5);
  }

  .action-btn .icon {
    color: rgba(255, 255, 255, 0.6);
  }

  .action-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .action-btn:hover:not(:disabled) .icon {
    color: #fff;
  }

  .action-btn.danger {
    background: #2d2424;
  }

  .action-btn.danger .icon {
    color: #e57373;
  }

  .action-btn.danger:hover:not(:disabled) {
    background: #3d2e2e;
  }

  .action-btn.state-loading {
    background: #1f2333;
  }

  .action-btn.state-success {
    background: #1f2d1f;
  }

  .action-btn.state-success .icon {
    color: #66bb6a;
  }

  .action-btn.state-error {
    background: #2d1f1f;
  }

  .action-btn.state-error .icon {
    color: #ef5350;
  }

  .icon {
    color: #cfd6d5;
  }

  .action-label {
    color: #d6dfdd;
    background: #1c1c1c;
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
}
</style>
