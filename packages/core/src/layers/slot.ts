import { stack } from './stack'

export type { LayerView } from './stack'

/** @internal The adapters' single window onto the layer stack. */
export const layerSlot = {
  views: () => stack.views(),
  info: () => stack.info(),
  subscribe: (listener: () => void | Promise<void>) => stack.subscribe(listener),
  topPage: () => stack.topPage(),
  bindElement: (id: string, el: Element | null) => stack.bindElement(id, el),
  scopeOf: (el: Element) => stack.scopeOf(el),
}
