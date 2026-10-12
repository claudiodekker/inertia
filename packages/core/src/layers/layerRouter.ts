import { Router } from '../router'
import type { Page, PendingVisit, ReloadOptions, RequestPayload, UrlMethodPair, VisitOptions } from '../types'
import { baseScope, type PageScope } from './scope'

/** A Router on the layer's scope. Shares the module request streams; never init()ed. */
export type LayerRouter = Router & { loadDeferred(deferred: Page['deferredProps']): void }

interface Options {
  /** A layer with no url of its own. */
  readonly local: boolean
  /** The placeholder of an instant visit could not be shown, so its request is never sent. */
  placeholderFailed(visit: PendingVisit): void
}

let LayerRouterClass: (new (scope: PageScope, options: Options) => LayerRouter) | undefined

export function createLayerRouter(scope: PageScope, options: Options): LayerRouter {
  LayerRouterClass ??= defineLayerRouter()

  return new LayerRouterClass(scope, options)
}

/** router.ts reaches this module through the stack, so Router may not exist yet when it loads. */
function defineLayerRouter() {
  return class LayerRouter extends Router {
    constructor(
      scope: PageScope,
      protected options: Options,
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
      return this.options.local ? super.doReload.call(baseScope.router, options as never) : super.doReload(options)
    }

    /** The rejection stays unhandled, as it is for a page placeholder. */
    protected performInstantSwap(visit: PendingVisit): Promise<void> {
      return super.performInstantSwap(visit).catch((error) => {
        this.options.placeholderFailed(visit)

        throw error
      })
    }
  }
}
