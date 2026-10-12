<script module lang="ts">
  import type { LayerView } from '@inertiajs/core'
  import type { DefaultLayout } from '../renderPage'
  import type { LayerComponent } from '../types'
  import LayerFrame from './LayerFrame.svelte'

  export { layerStack, noLayers }

  // A restore can reopen a layer under the id of one still playing its exit. A frame provides its scope
  // once, at init, so each instance gets a frame of its own.
  const frames = new WeakMap<object, string>()
  let frameCount = 0

  function frameKey(view: LayerView): string {
    let key = frames.get(view.scope)

    if (!key) {
      key = `${view.id}:${++frameCount}`
      frames.set(view.scope, key)
    }

    return key
  }
</script>

<!--
  The root renders one of these as `{@render}`, not as a component with a block inside: a block would add
  anchor comments to the markup of every page, and this way a page without layers is unchanged.
-->
{#snippet noLayers(_views: readonly LayerView[], _shell: LayerComponent, _defaultLayout?: DefaultLayout)}{/snippet}

{#snippet layerStack(views: readonly LayerView[], shell: LayerComponent, defaultLayout?: DefaultLayout)}
  {#each views as view (frameKey(view))}
    <LayerFrame {view} {shell} {defaultLayout} />
  {/each}
{/snippet}
