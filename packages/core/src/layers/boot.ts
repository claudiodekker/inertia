// The document load as the adapters see it: the server's views of a boot plan, and the resolver that
// answers the blank base. The client's half of the boot is stack.boot.

import type { Component, Page } from '../types'
import type { BootPlan } from './entry'
import { LayerInstance, type StackPort } from './instance'
import { stack } from './stack'
import type { LayerId } from './state'
import type { LayerInfo, LoadingResolver } from './types'
import { viewOf, type LayerView } from './views'

/**
 * The server renders the plan's seeds in fresh instances, never registered with the stack: renders run
 * concurrently and the server keeps no layer state. Ids come from the plan, so hydration finds them.
 */
export function ssrViews(plan: BootPlan, components: readonly unknown[]): LayerView[] {
  const port = new ServerPort(plan)

  return plan.seeds.map(({ row, page }, index) => {
    const instance = new LayerInstance(row.id, row.type, port, {
      resolveComponent: () => Promise.resolve(components[index] as Component),
      version: page.version,
    }).seed(page, components[index] as Component)

    return viewOf(instance, {
      open: true,
      index,
      isTop: index === plan.seeds.length - 1,
      type: row.type,
      close: () => {},
      done: () => {},
    })
  })
}

/** Answers what a seeded layer asks during a server render. Nothing commits, routes or closes there. */
class ServerPort implements StackPort {
  constructor(protected plan: BootPlan) {}

  layerCommitting = () => Promise.resolve()
  layerSwapped = () => Promise.resolve()
  route = () => undefined
  captured() {}
  rewriteEntry() {}
  clearHistory() {}
  close = () => Promise.resolve()
  emit() {}

  key(id: LayerId): string {
    return this.plan.seeds.find((seed) => seed.row.id === id)?.row.key ?? ''
  }

  index(id: LayerId): number {
    return this.plan.seeds.findIndex((seed) => seed.row.id === id)
  }
}

/**
 * The resolver the app and router.init use. The blank base (`component: ''`) goes to the loading
 * resolver, else to `blank`; every other name goes to the user's resolver, which never sees `''`.
 */
export function wrapResolver<C>(
  resolve: (name: string, page?: Page) => C | Promise<C>,
  loading: LoadingResolver<C> | undefined,
  blank: C,
): (name: string, page?: Page, layers?: readonly LayerInfo[]) => Promise<C> {
  return async (name, page, layers = stack.painter.info()) => {
    if (name !== '') {
      return resolve(name, page)
    }

    // A blank with no url is waiting on nothing the resolver could draw.
    const found = page?.url ? await loading?.(page.url, { layers }) : undefined

    if (found && typeof found === 'object' && 'default' in found) {
      return found.default
    }

    return (found as C | undefined) ?? blank
  }
}
