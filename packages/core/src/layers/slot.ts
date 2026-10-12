import { ssrViews, wrapResolver } from './boot'
import { planBoot, type BootPlan } from './entry'
import { stack } from './stack'

export type { LayerView } from './views'
export type { BootPlan }

/** @internal The adapters' single window onto the layer stack. */
export const layerSlot = {
  views: () => stack.views(),
  info: () => stack.info(),
  subscribe: (listener: () => void | Promise<void>) => stack.subscribe(listener),
  topPage: () => stack.topPage(),
  bindElement: (id: string, el: Element | null) => stack.bindElement(id, el),
  scopeOf: (el: Element) => stack.scopeOf(el),
  planBoot,
  /** Client, before mount. */
  boot: (plan: BootPlan, components: readonly unknown[]) => stack.boot(plan, components),
  /** Server: the seeds' views for this render only. */
  ssrViews,
  wrapResolver,
}
