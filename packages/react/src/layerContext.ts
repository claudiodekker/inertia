import { layerSlot, router, type LayerInfo, type LayerScope, type Router } from '@inertiajs/core'
import { createContext, use, useSyncExternalStore } from 'react'

export const LayerContext = createContext<LayerScope | null>(null)
LayerContext.displayName = 'InertiaLayerContext'

/** The enclosing layer, or null on the base. */
export function useLayer(): LayerScope | null {
  return use(LayerContext)
}

/** @internal The enclosing layer's router, or the global router itself on the base. */
export function useRouter(): Router {
  return useLayer()?.router ?? router
}

/** The open layers, bottom to top. */
export function useLayers(): readonly LayerInfo[] {
  return useSyncExternalStore((onChange) => layerSlot.subscribe(() => onChange()), layerSlot.info, layerSlot.info)
}
