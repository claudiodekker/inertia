import { layerSlot } from '@inertiajs/core'
import { ReactNode, useSyncExternalStore } from 'react'

const none: readonly never[] = []

export default function LayerStack(): ReactNode {
  useSyncExternalStore(layerSlot.subscribe, layerSlot.views, () => none)

  return null
}
