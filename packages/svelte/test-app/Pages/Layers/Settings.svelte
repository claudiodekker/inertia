<script lang="ts">
  import { inertia, useLayer } from '@inertiajs/svelte'

  const layer = useLayer()!

  layer.setLayoutProps({ layerChrome: 'layer' })
</script>

<div>Account settings</div>
<a href="/layers/settings" use:inertia>Open settings again</a>
