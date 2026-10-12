// The data of one layer: a CurrentPage, a Router and a layout store of its own, bound to the layer by a
// PageScope. Props, errors, flash, once, deferred, optimistic and remembered state are the fields of
// this instance's CurrentPage.

import { get } from 'es-toolkit/compat'
import { createLayoutPropsStore } from '../layout'
import type { Response } from '../response'
import type { Router } from '../router'
import type { Component, LayoutProps, NamedLayoutProps, Page, PageResolver, PendingVisit } from '../types'
import { madeInLayer } from './deferred'
import { LayerMessages } from './handles'
import { LayerHistory } from './layerHistory'
import { createLayerPage, type LayerPage } from './layerPage'
import { createLayerRouter, type LayerRouter } from './layerRouter'
import type { PageScope } from './scope'
import type { LayerId } from './state'
import type { LayerInfo, LayerMessageListener, LayerScope } from './types'

/** What an instance asks of the stack. The stack implements it; tests pass their own. */
export interface StackPort {
  layerCommitting(layer: LayerInstance, page: Page, replace: boolean): Promise<void>
  layerSwapped(layer: LayerInstance): Promise<void>
  route(response: Response): Promise<void> | undefined
  /** The scope captured a visit at dispatch. */
  captured(visit: PendingVisit): void
  /** The placeholder of an instant visit made in the layer could not be shown. */
  placeholderFailed(layer: LayerInstance, visit: PendingVisit): void
  /** Rewrite the live composite in place (remembered state changed). */
  rewriteEntry(layer: LayerInstance): void
  /** A layer page carried `clearHistory`, which clears the whole history. */
  clearHistory(): void
  key(id: LayerId): string
  index(id: LayerId): number
  close(id: LayerId): Promise<void>
  emit(id: LayerId, name: string, payload: unknown): void
}

interface LayerPageView {
  readonly component: Component
  readonly page: Page
  /** Bumped by every swap that does not preserve state, like the base page's key. */
  readonly renderKey: number
}

export class LayerInstance {
  readonly page: LayerPage
  readonly history: LayerHistory
  readonly router: LayerRouter
  readonly scope: PageScope
  readonly public: LayerScope
  readonly layout = createLayoutPropsStore()
  /** Messages this layer's children emit up to it. */
  readonly messages = new LayerMessages()
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
        madeInLayer(visit, id)

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
    this.router = createLayerRouter(this.scope, {
      local: type === 'local',
      placeholderFailed: (visit) => port.placeholderFailed(this, visit),
    })
    this.page = createLayerPage(this)
    this.page.init({
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
  setInitial(page: Page, component: Component): this {
    this.page.setWithoutSwap(page)
    this.historyPage = page
    this.lastWrite = 'replace'
    this.view = { component, page, renderKey: 0 }

    return this
  }

  /** A history entry's snapshot of this layer, set with no request: the layer as it is first restored. */
  restore(page: Page): void {
    this.historyPage = page
    this.lastWrite = 'replace'
    this.page.setQuietly(page).then(() => this.loadMissingDeferred())
  }

  /** The same layer, as another entry stored it. */
  rewind(page: Page): void {
    this.historyPage = page
    this.page.setQuietly(page, { preserveState: false })
  }

  /** Deferred props a page set without a request still lacks load through its router. */
  loadMissingDeferred(): void {
    const page = this.page.get()
    const missing = Object.entries(page.initialDeferredProps ?? page.deferredProps ?? {})
      .map(([group, names]) => [group, names.filter((name) => get(page.props, name) === undefined)] as const)
      .filter(([, names]) => names.length > 0)

    if (missing.length > 0 && !this.disposed) {
      this.router.loadDeferred(Object.fromEntries(missing))
    }
  }

  /**
   * Before a placeholder goes up: the props a placeholder is built from are those of the page it opens
   * over, as they are for a placeholder that takes the page's place.
   */
  openingOver({ props, sharedProps, encryptHistory }: Page): this {
    this.page.setWithoutSwap({ ...this.page.get(), props, sharedProps, encryptHistory })

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
    return this.layer.messages.on(name, listener)
  }

  once(name: string, listener: LayerMessageListener): () => void {
    return this.layer.messages.once(name, listener)
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
