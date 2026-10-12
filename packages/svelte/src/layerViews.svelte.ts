import { layerSlot, type LayerView } from '@inertiajs/core'
import { onDestroy, tick } from 'svelte'

/**
 * The views the stack paints, in order. The server shows the boot plan's views. The client starts from the
 * views booted before mount and follows the painter; each publish resolves once the DOM shows it.
 * Call during component initialisation.
 */
export function useLayerViews(initialLayers?: readonly LayerView[]): { readonly list: readonly LayerView[] } {
  const isServer = typeof window === 'undefined'
  let views = $state.raw<readonly LayerView[]>((isServer && initialLayers) || layerSlot.views())

  if (!isServer) {
    onDestroy(
      layerSlot.subscribe(() => {
        views = layerSlot.views()

        return tick()
      }),
    )
  }

  return {
    get list() {
      return views
    },
  }
}
