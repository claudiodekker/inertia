import { layerSlot, router, type LayerInfo, type LayerScope, type Page, type Router } from '@inertiajs/core'
import { getCurrentInstance, inject, shallowReactive, type InjectionKey, type Ref } from 'vue'

export interface LayerContext {
  readonly scope: LayerScope
  readonly page: Readonly<Ref<Page>>
}

export const layerKey: InjectionKey<LayerContext> = Symbol('inertiaLayer')

/** The enclosing layer, or null on the base and outside a component (inject() warns there). */
export function useLayerContext(): LayerContext | null {
  return getCurrentInstance() ? inject(layerKey, null) : null
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
    const list = shallowReactive<LayerInfo[]>([...layerSlot.info()])

    layerSlot.subscribe(() => {
      list.splice(0, list.length, ...layerSlot.info())
    })

    layers = list
  }

  return layers
}
