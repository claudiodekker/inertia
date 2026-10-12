import type { Page } from '../types'
import type { LayerInstance } from './instance'
import type { LayerScope, LayerShellProps } from './types'

/** Immutable per change. Adapters key the frame on the scope and the page component on `renderKey`. */
export interface LayerView {
  readonly id: string
  readonly scope: LayerScope
  readonly component: unknown
  /** What usePage() returns inside the layer. */
  readonly page: Page
  readonly renderKey: number
  readonly layout: LayerInstance['layout']
  readonly shell: LayerShellProps
  /** On the wrapper inside the shell. */
  readonly attributes: { 'data-layer-id': string; style: { viewTransitionName: string } }
}

export function viewOf(instance: LayerInstance, shell: LayerShellProps): LayerView {
  const { component, page, renderKey } = instance.view!

  return {
    id: instance.id,
    scope: instance.public,
    component,
    page,
    renderKey,
    layout: instance.layout,
    shell,
    attributes: { 'data-layer-id': instance.id, style: { viewTransitionName: `inertia-layer-${instance.id}` } },
  }
}
