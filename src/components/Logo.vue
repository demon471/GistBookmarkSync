<script setup lang="ts">
import logoUrl from '~/assets/logo.png'
</script>

<template>
  <a class="icon-btn mx-2 text-2xl" rel="noreferrer" href="https://github.com/antfu/vitesse-webext" target="_blank" title="GitHub">
    <img class="logo-img" :src="logoUrl" alt="Gist Sync">
  </a>
</template>

<style scoped>
.logo-img {
  width: 20px;
  height: 20px;
  display: block;
  object-fit: contain;
}
</style>
