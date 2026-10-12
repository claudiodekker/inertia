import { Router } from '../router'
import type { Page, ReloadOptions, RequestPayload, UrlMethodPair, VisitOptions } from '../types'
import { baseScope, type PageScope } from './scope'

/** A 3.x Router on the layer's scope. Shares the module request streams; never init()ed. */
export type LayerRouter = Router & { loadDeferred(deferred: Page['deferredProps']): void }

let LayerRouterClass: (new (scope: PageScope, local: boolean) => LayerRouter) | undefined

export function createLayerRouter(scope: PageScope, local: boolean): LayerRouter {
  LayerRouterClass ??= defineLayerRouter()

  return new LayerRouterClass(scope, local)
}

/** router.ts reaches this module through the stack, so Router may not exist yet when it loads. */
function defineLayerRouter() {
  return class LayerRouter extends Router {
    constructor(
      scope: PageScope,
      protected local: boolean,
    ) {
      super(scope)
    }

    public loadDeferred(deferred: Page['deferredProps']): void {
      this.loadDeferredProps(deferred)
    }

    /** A closed layer has no page to put a placeholder on, so an instant visit made from it is the page's own. */
    public visit<T extends RequestPayload = RequestPayload>(
      href: string | URL | UrlMethodPair,
      options: VisitOptions<T> = {},
    ): void {
      return this.scope.disposed && options.component
        ? baseScope.router.visit(href, options)
        : super.visit(href, options)
    }

    /** A layer with no url has nothing of its own to ask the server for: its reload is the page's beneath the stack. */
    protected doReload<T extends RequestPayload = RequestPayload>(
      options?: ReloadOptions<T> & { deferredProps?: boolean; poll?: boolean },
    ): void {
      return this.local ? super.doReload.call(baseScope.router, options as never) : super.doReload(options)
    }
  }
}
