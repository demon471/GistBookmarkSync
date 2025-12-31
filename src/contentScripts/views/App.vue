<script setup lang="ts">
import { sendMessage } from "webext-bridge/content-script";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import logoUrl from "~/assets/logo.png";
import "uno.css";

type ShortcutPosition = {
  side: "left" | "right";
  y: number;
};

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
  await sendMessage("sync-upload", undefined, "background");
}

async function downloadBookmarks() {
  await sendMessage("sync-download", undefined, "background");
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
    <div
      class="actions"
      @pointerdown.stop
      @pointerup.stop
      @mouseenter="isHoveringActions = true"
      @mouseleave="isHoveringActions = false"
    >
      <div class="action-item">
        <button class="action-btn" @click="uploadBookmarks">
          <ph-cloud-arrow-up class="icon" />
        </button>
        <span class="action-label">上传书签</span>
      </div>
      <div class="action-item">
        <button class="action-btn" @click="downloadBookmarks">
          <ph-cloud-arrow-down class="icon" />
        </button>
        <span class="action-label">下载书签</span>
      </div>
      <div class="action-item">
        <button class="action-btn" @click="openSidePanel">
          <ph-sidebar-simple class="icon" />
        </button>
        <span class="action-label">打开侧边栏</span>
      </div>
    </div>
    <button
      class="shortcut-btn"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img class="icon-logo" :src="logoUrl" alt="Gist Sync" />
    </button>
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

.shortcut-btn {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: none;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: #fff;
  display: grid;
  place-items: center;
  box-shadow: 0 10px 20px rgba(9, 20, 18, 0.22);
  cursor: pointer;
  transition: transform 180ms ease, opacity 180ms ease, filter 180ms ease;
  opacity: 0.45;
  filter: grayscale(0.35);
  touch-action: none;
}

.shortcut.is-hover .shortcut-btn,
.shortcut.is-dragging .shortcut-btn {
  opacity: 1;
  filter: none;
}

.shortcut.is-hover.side-right .shortcut-btn {
  transform: translateX(-6px);
}

.shortcut.is-hover.side-left .shortcut-btn {
  transform: translateX(6px);
}

.icon {
  font-size: 16px;
  color: #b7bcbc;
  pointer-events: none;
}

.icon-logo {
  width: 16px;
  height: 16px;
  display: block;
  object-fit: contain;
  pointer-events: none;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(8px) scale(0.98);
  transition: opacity 140ms ease, transform 180ms ease, visibility 0ms 140ms;
  pointer-events: none;
}

.shortcut.side-right .actions {
  align-self: flex-end;
  transform: translateX(6px) translateY(8px) scale(0.98);
}

.shortcut.side-left .actions {
  align-self: flex-start;
  transform: translateX(-6px) translateY(8px) scale(0.98);
}

.action-item {
  display: flex;
  align-items: center;
  gap: 8px;
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
}

.action-item:hover .action-label {
  opacity: 1;
  transform: translateY(0);
}

.shortcut.is-hover .actions,
.shortcut.is-dragging .actions {
  opacity: 1;
  visibility: visible;
  transform: translateY(-4px) scale(1);
  pointer-events: auto;
  transition: opacity 140ms ease, transform 180ms ease, visibility 0ms;
}

.shortcut.is-hover.side-right .actions,
.shortcut.is-dragging.side-right .actions {
  transform: translateX(-6px) translateY(-4px) scale(1);
}

.shortcut.is-hover.side-left .actions,
.shortcut.is-dragging.side-left .actions {
  transform: translateX(6px) translateY(-4px) scale(1);
}

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 10px;
  border: none;
  background: #eef9f6;
  color: #1c1c1c;
  display: grid;
  place-items: center;
  box-shadow: 0 10px 18px rgba(10, 22, 20, 0.12);
  cursor: pointer;
  opacity: 0;
  transform: translateY(8px);
  transition: transform 180ms ease, opacity 120ms ease, box-shadow 160ms ease;
}

.shortcut.is-hover .action-btn,
.shortcut.is-dragging .action-btn {
  opacity: 1;
  transform: translateY(0);
}

.shortcut.is-hover .action-btn:nth-child(1) {
  transition-delay: 80ms;
}

.shortcut.is-hover .action-btn:nth-child(2) {
  transition-delay: 40ms;
}

.shortcut.is-hover .action-btn:nth-child(3) {
  transition-delay: 0ms;
}

.action-btn:hover {
  transform: translateY(-1px);
}

@media (prefers-color-scheme: dark) {
  .shortcut-btn {
    border-color: rgba(255, 255, 255, 0.1);
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.5);
  }

  .action-btn {
    background: #1a2623;
    color: #d7efe9;
    box-shadow: 0 10px 18px rgba(0, 0, 0, 0.5);
  }

  .icon {
    color: #cfd6d5;
  }

  .action-label {
    color: #d6dfdd;
    background: #1c1c1c;
  }
}
</style>
