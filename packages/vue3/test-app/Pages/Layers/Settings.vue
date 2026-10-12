<script setup lang="ts">
import { Link, useLayer } from '@inertiajs/vue3'

const layer = useLayer()!

layer.setLayoutProps({ layerChrome: 'layer' })
</script>

<template>
  <div>Account settings</div>
  <Link href="/layers/settings">Open settings again</Link>
</template>
