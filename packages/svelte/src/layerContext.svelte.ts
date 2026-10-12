import { layerSlot, router, type LayerInfo, type LayerScope, type Page, type Router } from '@inertiajs/core'
import { getContext, setContext } from 'svelte'

export interface LayerContext {
  readonly scope: LayerScope
  /** The layer's own page, kept in step with the view by `syncPage`. */
  readonly page: Page
}

const layerKey = Symbol('inertiaLayer')

export function setLayerContext(context: LayerContext): void {
  setContext(layerKey, context)
}

/** The enclosing layer, or null on the base and outside component initialisation (getContext throws there). */
export function useLayerContext(): LayerContext | null {
  try {
    return getContext<LayerContext | undefined>(layerKey) ?? null
  } catch (error) {
    if (error instanceof Error && error.message.includes('lifecycle_outside_component')) {
      return null
    }

    throw error
  }
}

/** Makes `target` equal `source`: keys the source no longer has are removed, the rest assigned. */
export function syncPage(target: Page, source: Page): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete (target as unknown as Record<string, unknown>)[key]
    }
  }

  Object.assign(target, source)
}

export function useLayer(): LayerScope | null {
  return useLayerContext()?.scope ?? null
}

/** @internal The enclosing layer's router, or the global router itself on the base. */
export function useRouter(): Router {
  return useLayer()?.router ?? router
}

let layers: LayerInfo[] | null = null

/** The open layers, bottom to top. */
export function useLayers(): readonly LayerInfo[] {
  if (!layers) {
    const list = $state<LayerInfo[]>([...layerSlot.info()])

    if (typeof window !== 'undefined') {
      layerSlot.subscribe(() => {
        list.splice(0, list.length, ...layerSlot.info())
      })
    }

    layers = list
  }

  return layers
}
