<script lang="ts">
  import { layerSlot, type LayerView } from '@inertiajs/core'
  import { onDestroy, untrack } from 'svelte'
  import { setLayerContext, syncPage } from '../layerContext.svelte'
  import renderPage, { type DefaultLayout } from '../renderPage'
  import type { LayerComponent } from '../types'
  import Render from './Render.svelte'

  interface Props {
    view: LayerView
    shell: LayerComponent
    defaultLayout?: DefaultLayout
  }

  // A frame belongs to one layer instance: the stack keys it by instance, so the scope never changes.
  // svelte-ignore state_referenced_locally
  const { view, shell: Shell, defaultLayout }: Props = $props()

  // svelte-ignore state_referenced_locally
  const layerPage = $state({ ...view.page })

  // svelte-ignore state_referenced_locally
  setLayerContext({ scope: view.scope, page: layerPage })

  $effect.pre(() => {
    const next = view.page

    untrack(() => syncPage(layerPage, next))
  })

  // svelte-ignore state_referenced_locally
  let layout = $state.raw(view.layout.get())
  // svelte-ignore state_referenced_locally
  const stopLayout = view.layout.subscribe(() => (layout = view.layout.get()))

  onDestroy(stopLayout)

  const snapshot = {
    get shared() {
      return layout.shared
    },
    get named() {
      return layout.named
    },
  }

  const rendered = $derived(renderPage(view.component as any, view.page, view.renderKey, snapshot, defaultLayout))

  function bind(node: HTMLElement, id: string) {
    layerSlot.bindElement(id, node)

    return { destroy: () => layerSlot.bindElement(id, null) }
  }
</script>

<Shell {...view.shell}>
  <div
    data-layer-id={view.attributes['data-layer-id']}
    style:view-transition-name={view.attributes.style.viewTransitionName}
    use:bind={view.id}
  >
    <Render {...rendered} />
  </div>
</Shell>
