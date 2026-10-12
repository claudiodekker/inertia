// The data plane of one layer: the 3.x CurrentPage, Router and layout store, bound to the layer by a
// PageScope. Props, errors, flash, once, deferred, optimistic and remembered state are the 3.x fields
// of this instance's CurrentPage. LayerPage overrides only the hooks whose 3.x body touches the
// browser, the global page or the global history.

import { fireNavigateEvent } from '../events'
import { createLayoutPropsStore } from '../layout'
import { CurrentPage } from '../page'
import type { Response } from '../response'
import { Router } from '../router'
import type {
  Component,
  LayoutProps,
  NamedLayoutProps,
  Page,
  PageHandler,
  PageResolver,
  PendingVisit,
  ReloadOptions,
  RequestPayload,
  RouterInitParams,
  ScrollRegion,
  UrlMethodPair,
  VisitOptions,
} from '../types'
import { hrefToUrl } from '../url'
import { Inbox } from './handles'
import { baseScope, type HistoryPort, type PageScope } from './scope'
import { stack } from './stack'
import type { LayerId } from './state'
import type { LayerInfo, LayerMessageListener, LayerScope } from './types'

/** What an instance asks of the stack. The stack implements it; tests pass their own. */
export interface StackPort {
  layerCommitting(layer: LayerInstance, page: Page, replace: boolean): Promise<void>
  layerSwapped(layer: LayerInstance): Promise<void>
  route(response: Response): Promise<void> | undefined
  /** The scope captured a visit at dispatch. */
  captured(visit: PendingVisit): void
  /** Rewrite the live composite in place (remembered state changed). */
  rewriteEntry(layer: LayerInstance): void
  /** A layer page carried `clearHistory`, which is global by decision. */
  clearHistory(): void
  key(id: LayerId): string
  index(id: LayerId): number
  close(id: LayerId): Promise<void>
  emit(id: LayerId, name: string, payload: unknown): void
}

export interface LayerPageView {
  readonly component: Component
  readonly page: Page
  /** Bumped by every swap that does not preserve state, like the 3.x base key. */
  readonly renderKey: number
}

const unopenedUrl = new URL('about:blank')

export class LayerInstance {
  readonly page: LayerPage
  readonly history: LayerHistory
  readonly router: LayerRouter
  readonly scope: PageScope
  readonly public: LayerScope
  readonly layout = createLayoutPropsStore()
  /** Messages this layer's children emit up to it. */
  readonly inbox = new Inbox()
  readonly closeListeners = new Set<() => void>()
  /** The page last handed to history for this layer. The composer reads this. */
  historyPage: Page | null = null
  /** The decision for the last commit; null until the first one. */
  lastWrite: 'push' | 'replace' | null = null
  view: LayerPageView | null = null
  element: Element | null = null
  disposed = false

  constructor(
    readonly id: LayerId,
    readonly type: 'routed' | 'local',
    readonly port: StackPort,
    { resolveComponent, version }: { resolveComponent: PageResolver; version: string | null },
  ) {
    const layer = this

    this.scope = {
      get page() {
        return layer.page
      },
      get history() {
        return layer.history
      },
      get router() {
        return layer.router
      },
      reloadUrl: () => this.page.get().url,
      capture: (visit, previous) => {
        if (!previous) {
          port.captured(visit)
        }

        return { kind: 'layer', id, instant: previous !== undefined }
      },
      route: (response) => port.route(response),
      get disposed() {
        return layer.disposed
      },
    }

    this.history = new LayerHistory(this)
    this.router = new LayerRouter(this.scope, type === 'local')
    this.page = new LayerPage(this).init({
      initialPage: {
        component: '',
        props: { errors: {} },
        url: '',
        version,
        flash: {},
        rescuedProps: [],
        rememberedState: {},
      },
      resolveComponent,
      swapComponent: ({ component, page, preserveState }) => {
        if (this.disposed) {
          return Promise.resolve()
        }

        const renderKey = (this.view?.renderKey ?? 0) + (preserveState ? 0 : 1)

        if (!preserveState) {
          this.layout.reset()
        }

        this.view = { component, page, renderKey }

        return port.layerSwapped(this)
      },
      onFlash: (flash) => {
        if (this.view && !this.disposed) {
          this.view = { ...this.view, page: { ...this.view.page, flash } }
          port.layerSwapped(this)
        }
      },
    })
    this.public = new PublicScope(this)
  }

  /** Boot: the page and component the document arrived with, set at once with no request and no swap. */
  seed(page: Page, component: Component): this {
    this.page.seed(page)
    this.historyPage = page
    this.lastWrite = 'replace'
    this.view = { component, page, renderKey: 0 }

    return this
  }

  /**
   * Before a placeholder goes up: the props a placeholder is built from are those of the page it opens
   * over, as they are for a placeholder that takes the page's place.
   */
  standingOn({ props, sharedProps, encryptHistory }: Page): this {
    this.page.seed({ ...this.page.get(), props, sharedProps, encryptHistory })

    return this
  }

  /** Idempotent. The scope reads disposed at once; close listeners fire after the next paint. */
  dispose(): void {
    this.disposed = true
  }

  fireClose(): void {
    const listeners = [...this.closeListeners]

    this.closeListeners.clear()
    listeners.forEach((listener) => listener())
  }

  info(): LayerInfo {
    const page = this.page.get()

    return {
      id: this.id,
      key: this.port.key(this.id),
      component: page.component,
      url: this.type === 'routed' ? page.url : null,
      type: this.type,
    }
  }
}

export class LayerPage extends CurrentPage {
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

  /** A layer's page always carries its deferred, once and scroll records, empty when the answer names none. */
  public set(page: Page, options?: Parameters<CurrentPage['set']>[1]): Promise<void> {
    return super.set(withRecords(page), options)
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

function withRecords(page: Page): Page {
  page.deferredProps ??= {}
  page.onceProps ??= {}
  page.scrollProps ??= {}

  return page
}

/** A layer's HistoryPort. Remembered state lives in the layer page and reaches history through the composite. */
export class LayerHistory implements HistoryPort {
  protected requested = false

  constructor(protected layer: LayerInstance) {}

  /**
   * Before the first commit this reads false, so an opening response keeps its own url (the row records
   * that it owns no address instead). After that it is the 3.x flag, scoped to this layer.
   */
  get preserveUrl(): boolean {
    return this.requested && this.layer.lastWrite !== null
  }

  set preserveUrl(value: boolean) {
    this.requested = value
  }

  remember(data: unknown, key: string): void {
    const rememberedState = { ...(this.layer.page.get().rememberedState ?? {}), [key]: data }

    this.layer.page.remember(rememberedState)

    if (this.layer.historyPage) {
      this.layer.historyPage = { ...this.layer.historyPage, rememberedState }
    }

    this.layer.port.rewriteEntry(this.layer)
  }

  restore(key: string): unknown {
    if (typeof window !== 'undefined') {
      return this.layer.page.get().rememberedState?.[key]
    }
  }

  getState<T>(key: keyof Page, defaultValue?: T): any {
    return this.layer.page.get()[key] ?? defaultValue
  }
}

/** A 3.x Router on the layer's scope. Shares the module request streams; never init()ed. */
export class LayerRouter extends Router {
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
    return this.scope.disposed && options.component ? baseScope.router.visit(href, options) : super.visit(href, options)
  }

  /** A layer with no url has nothing of its own to ask the server for: its reload is the page's beneath the stack. */
  protected doReload<T extends RequestPayload = RequestPayload>(
    options?: ReloadOptions<T> & { deferredProps?: boolean; poll?: boolean },
  ): void {
    return this.local ? super.doReload.call(baseScope.router, options as never) : super.doReload(options)
  }
}

/** The public LayerScope: forwards to the instance and the stack, with no state of its own. */
class PublicScope implements LayerScope {
  constructor(protected layer: LayerInstance) {}

  get id() {
    return this.layer.id
  }

  get type() {
    return this.layer.type
  }

  get key() {
    return this.layer.info().key
  }

  get component() {
    return this.layer.info().component
  }

  get url() {
    return this.layer.info().url
  }

  get router(): Router {
    return this.layer.router
  }

  get index() {
    return this.layer.port.index(this.layer.id)
  }

  close(): Promise<void> {
    return this.layer.port.close(this.layer.id)
  }

  emit(name: string, payload?: unknown): void {
    this.layer.port.emit(this.layer.id, name, payload)
  }

  on(name: string, listener: LayerMessageListener): () => void {
    return this.layer.inbox.on(name, listener)
  }

  once(name: string, listener: LayerMessageListener): () => void {
    return this.layer.inbox.once(name, listener)
  }

  onClose(listener: () => void): () => void {
    if (this.layer.disposed) {
      queueMicrotask(listener)

      return () => {}
    }

    this.layer.closeListeners.add(listener)

    return () => this.layer.closeListeners.delete(listener)
  }

  setLayoutProps(props: Partial<LayoutProps>): void
  setLayoutProps<K extends keyof NamedLayoutProps>(name: K, props: Partial<NamedLayoutProps[K]>): void
  setLayoutProps<K extends keyof NamedLayoutProps>(
    nameOrProps: K | Partial<LayoutProps>,
    props?: Partial<NamedLayoutProps[K]>,
  ): void {
    if (typeof nameOrProps === 'object') {
      this.layer.layout.set(nameOrProps)
    } else {
      this.layer.layout.setFor(nameOrProps, props!)
    }
  }

  resetLayoutProps(): void {
    this.layer.layout.reset()
  }
}

// stack.ts cannot import this module: LayerPage and LayerRouter extend 3.x classes, and page.ts imports
// stack.ts, so the classes would be defined before CurrentPage exists. index.ts imports this module
// after ./router, and it hands the stack what it needs to build instances.
stack.connect({
  baseScope,
  createInstance: (id, type, port, options) => new LayerInstance(id, type, port, options),
})
