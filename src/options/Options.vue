<script setup lang="ts">
import { sendMessage } from 'webext-bridge/options'
import { ref } from 'vue'
import logo from '~/assets/logo.svg'
import { gistAutoCreate, gistFileName, gistId, githubToken, storageDemo } from '~/logic/storage'

const validationState = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const validationMessage = ref('')

async function validateGistAuth() {
  validationState.value = 'checking'
  validationMessage.value = ''

  try {
    const result = await sendMessage(
      'validate-gist-auth',
      {
        token: githubToken.value,
        gistId: gistId.value,
        fileName: gistFileName.value,
        autoCreate: gistAutoCreate.value,
      },
      'background',
    )

    if (result.ok) {
      validationState.value = 'ok'
      validationMessage.value = result.created ? 'Validated and file created' : 'Validation passed'
      return
    }

    validationState.value = 'error'
    validationMessage.value = result.errors?.join('; ') || 'Validation failed'
  }
  catch (error) {
    validationState.value = 'error'
    validationMessage.value = error instanceof Error ? error.message : 'Validation failed'
  }
}
</script>

<template>
  <main class="px-4 py-10 text-center text-gray-700 dark:text-gray-200">
    <img :src="logo" class="icon-btn mx-2 text-2xl" alt="extension icon">
    <div>Options</div>
    <SharedSubtitle />

    <div class="mt-4 text-left space-y-3">
      <label class="block">
        <div class="text-sm mb-1">GitHub Token</div>
        <input v-model="githubToken" type="password" class="border border-gray-400 rounded px-2 py-1 w-full">
      </label>
      <label class="block">
        <div class="text-sm mb-1">Gist ID</div>
        <input v-model="gistId" class="border border-gray-400 rounded px-2 py-1 w-full">
      </label>
      <label class="block">
        <div class="text-sm mb-1">Gist File Name</div>
        <input v-model="gistFileName" class="border border-gray-400 rounded px-2 py-1 w-full">
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="gistAutoCreate" type="checkbox" class="border border-gray-400 rounded">
        Auto-create file if missing
      </label>
      <button class="btn w-full" :disabled="validationState === 'checking'" @click="validateGistAuth">
        Validate
      </button>
      <div v-if="validationState !== 'idle'" class="text-sm">
        <span v-if="validationState === 'checking'">Validating...</span>
        <span v-else-if="validationState === 'ok'" class="text-green-600">{{ validationMessage }}</span>
        <span v-else class="text-red-600">{{ validationMessage }}</span>
      </div>
    </div>

    <div class="mt-4 text-left">
      <div class="text-sm mb-1">Storage Demo</div>
      <input v-model="storageDemo" class="border border-gray-400 rounded px-2 py-1 w-full">
    </div>

    <div class="mt-4">
      Powered by Vite <pixelarticons-zap class="align-middle inline-block" />
    </div>
  </main>
</template>
