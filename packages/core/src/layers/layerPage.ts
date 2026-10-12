import { fireNavigateEvent } from '../events'
import { CurrentPage } from '../page'
import type { Component, Page, PageHandler, RouterInitParams, ScrollRegion } from '../types'
import { hrefToUrl } from '../url'
import { stripMark } from './facts'
import type { LayerInstance } from './instance'

/** A 3.x CurrentPage that overrides only the hooks whose 3.x body touches the browser, the global page or the global history. */
export type LayerPage = CurrentPage & { seed(page: Page): void }

const unopenedUrl = new URL('about:blank')

let LayerPageClass: (new (layer: LayerInstance) => LayerPage) | undefined

export function createLayerPage(layer: LayerInstance): LayerPage {
  LayerPageClass ??= defineLayerPage()

  return new LayerPageClass(layer)
}

/**
 * page.ts imports the stack, and the stack builds instances, so CurrentPage may not exist yet when this
 * module loads. The subclass is defined when the first layer is created.
 */
function defineLayerPage() {
  return class LayerPage extends CurrentPage {
    constructor(protected layer: LayerInstance) {
      super()
    }

    /** The 3.x field setup without the global historyQuotaExceeded listener. */
    public init<ComponentType = Component>({
      initialPage,
      swapComponent,
      resolveComponent,
      onFlash,
    }: RouterInitParams<ComponentType>) {
      this.page = { ...initialPage, flash: initialPage.flash ?? {}, rescuedProps: initialPage.rescuedProps ?? [] }
      this.swapComponent = swapComponent as PageHandler<any>
      this.resolveComponent = resolveComponent
      this.onFlashCallback = onFlash

      return this
    }

    public seed(page: Page): void {
      this.page = withRecords(page)
    }

    /**
     * A layer's page always carries its deferred, once and scroll records, empty when the answer names none,
     * and never the wire mark that made it a layer: the row holds what the mark said.
     */
    public set(page: Page, options?: Parameters<CurrentPage['set']>[1]): Promise<void> {
      return super.set(withRecords(stripMark(page)), options)
    }

    /** Clearing history is global by decision: the stack runs it, never this page. */
    protected clearHistoryFor(page: Page): void {
      if (page.clearHistory) {
        this.layer.port.clearHistory()
      }
    }

    /** Until the first commit, a url nothing matches, so 3.x's same-url replace reduces to visit.replace. */
    protected location(_page: Page): URL {
      return this.layer.lastWrite === null ? unopenedUrl : hrefToUrl(this.page.url)
    }

    protected write(pageForHistory: Page, replace: boolean): Promise<void> {
      return this.layer.port.layerCommitting(this.layer, pageForHistory, replace)
    }

    protected onceChanged(): void {}

    protected swapped(): void {}

    /** The layer's own regions only, never the window; deferred props through the layer's router. */
    protected settle(
      page: Page,
      {
        preserveScroll,
        cached,
        visitId,
      }: {
        preserveScroll: boolean
        scrollRegions: ScrollRegion[]
        replace: boolean
        cached: boolean
        visitId?: string
      },
    ): void {
      // The write that landed found the layer closed: it owes nothing, and asks for no deferred props.
      if (this.layer.disposed) {
        this.pendingDeferredProps = null

        return
      }

      if (!preserveScroll) {
        this.layer.element?.querySelectorAll('[scroll-region]').forEach((region) => region.scrollTo(0, 0))
      }

      if (
        this.pendingDeferredProps &&
        this.pendingDeferredProps.component === page.component &&
        this.pendingDeferredProps.url === page.url
      ) {
        this.layer.router.loadDeferred(this.pendingDeferredProps.deferredProps)
      }

      this.pendingDeferredProps = null

      if (this.layer.lastWrite === 'push') {
        fireNavigateEvent(page, { type: 'visit', cached, visitId })
      }
    }

    /** The 3.x restore without history.setCurrent, which belongs to the base. */
    public setQuietly(page: Page, { preserveState = false }: { preserveState?: boolean } = {}) {
      this.componentId = {}

      return this.resolve(page.component, page).then((component) => {
        this.page = withRecords(page)
        this.cleared = false

        return this.swap({ component, page: this.page, preserveState, viewTransition: false })
      })
    }
  }
}

function withRecords(page: Page): Page {
  page.deferredProps ??= {}
  page.onceProps ??= {}
  page.scrollProps ??= {}

  return page
}
