import type { Page } from '../types'

export interface LayerView<Component = unknown> {
  readonly id: string
  readonly component: Component
  readonly page: Page
  readonly renderKey: number
}

const noViews: readonly LayerView[] = []

/** @internal The adapters' single window onto the layer stack. */
export const layerSlot = {
  views: (): readonly LayerView[] => noViews,
  subscribe:
    (_fn: () => void): (() => void) =>
    () => {},
  topPage: (): Page | null => null,
}
