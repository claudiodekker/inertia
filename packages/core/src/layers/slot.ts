import { ssrViews, wrapResolver } from './boot'
import { fillsDeferred } from './deferred'
import { planBoot, type BootPlan } from './entry'
import { stack } from './stack'

export type { LayerView } from './views'
export type { BootPlan }

/** @internal The adapters' single window onto the layer stack. */
export const layerSlot = {
  views: () => stack.views.current(),
  info: () => stack.views.info(),
  subscribe: (listener: () => void | Promise<void>) => stack.views.subscribe(listener),
  topPage: () => stack.views.topPage(),
  bindElement: (id: string, el: Element | null) => stack.bindElement(id, el),
  scopeOf: (el: Element) => stack.scopeOf(el),
  fillsDeferred,
  planBoot,
  /** Client, before mount. */
  boot: (plan: BootPlan, components: readonly unknown[]) => stack.boot(plan, components),
  /** Server: the layers' views for this render only. */
  ssrViews,
  wrapResolver,
}
