// The runtime. It holds the reducer state, the instance map and the views it last painted. It never
// decides: each hook reads its inputs, dispatches one event, and runs the returned effects in order.
// Client only: on the server every hook returns the 3.x value.

import { history } from '../history'
import { page as currentPage } from '../page'
import { RequestParams } from '../requestParams'
import type { Response } from '../response'
import type { Page, PageResolver, PendingVisit, VisitOptions } from '../types'
import { uid } from '../uid'
import { hrefToUrl, isSameUrlWithoutHash } from '../url'
import { compose as composeEntry, type CompositeEntry, type LayerEntry } from './entry'
import type { LayerInstance, StackPort } from './instance'
import { reduce } from './reduce'
import type { PageScope } from './scope'
import {
  idle,
  initialState,
  type Landing,
  type LayerId,
  type LayerRow,
  type Marks,
  type Origin,
  type Outcome,
  type StackEffect,
  type StackEvent,
  type StackState,
} from './state'
import type { LayerHandle, LayerInfo, LayerScope, LayerShellProps, LayerTarget } from './types'

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

interface Connection {
  baseScope: PageScope
  createInstance(
    id: LayerId,
    port: StackPort,
    options: { resolveComponent: PageResolver; version: string | null },
  ): LayerInstance
}

const noViews: readonly LayerView[] = []
const noInfo: readonly LayerInfo[] = []
const isServer = typeof window === 'undefined'

export class Stack implements StackPort {
  protected state: StackState = initialState
  protected instances = new Map<LayerId, LayerInstance>()
  protected connection: Connection | null = null
  protected listeners = new Set<() => void | Promise<void>>()
  protected elements = new WeakMap<Element, LayerId>()
  protected painted: { views: readonly LayerView[]; info: readonly LayerInfo[] } = { views: noViews, info: noInfo }
  protected cache = new Map<LayerId, LayerView>()
  protected shells = new Map<LayerId, Pick<LayerShellProps, 'close' | 'done'>>()
  /** Disposed instances whose close listeners fire once the paint removing them has landed. */
  protected leaving: LayerInstance[] = []

  public connect(connection: Connection): void {
    this.connection = connection
  }

  protected dispatch(event: StackEvent): { outcome: Outcome; waits: Promise<unknown>[] } {
    const step = reduce(this.state, event)

    this.state = step.state

    const waits: Promise<unknown>[] = []

    for (const effect of step.effects) {
      const wait = this.run(effect)

      if (wait) {
        waits.push(wait)
      }
    }

    return { outcome: step.outcome, waits }
  }

  protected run(effect: StackEffect): Promise<unknown> | void {
    switch (effect.type) {
      case 'paint':
        return this.paint()
      case 'writeEntry': {
        const { data, url } = this.compose(currentPage.getWithoutFlashData())

        return history.writeEntry(data, url, effect.mode)
      }
      case 'dispose':
        effect.ids.forEach((id) => {
          const instance = this.instances.get(id)

          if (instance) {
            instance.dispose()
            this.instances.delete(id)
            this.leaving.push(instance)
          }
        })
        return
      default:
        return assertNever(effect)
    }
  }

  protected paint(): Promise<void> {
    const rendered = this.state.rows.filter((row) => this.instances.get(row.id)?.view)
    const ghosts = this.state.ghosts.filter((id) => this.instances.get(id)?.view)
    const views = [
      ...rendered.map((row, index) => this.viewOf(row.id, index, index === rendered.length - 1, true)),
      ...ghosts.map((id, index) => this.viewOf(id, rendered.length + index, false, false)),
    ]
    const leaving = this.leaving

    this.leaving = []
    this.painted = {
      views: views.length > 0 ? views : noViews,
      info: rendered.length > 0 ? rendered.map((row) => this.instances.get(row.id)!.info()) : noInfo,
    }

    for (const id of this.cache.keys()) {
      if (!this.instances.has(id)) {
        this.cache.delete(id)
        this.shells.delete(id)
      }
    }

    return Promise.all([...this.listeners].map((listener) => listener())).then(() =>
      leaving.forEach((instance) => instance.fireClose()),
    )
  }

  protected viewOf(id: LayerId, index: number, isTop: boolean, open: boolean): LayerView {
    const instance = this.instances.get(id)!
    const { component, page, renderKey } = instance.view!
    const cached = this.cache.get(id)

    if (
      cached &&
      cached.component === component &&
      cached.page === page &&
      cached.renderKey === renderKey &&
      cached.shell.index === index &&
      cached.shell.isTop === isTop &&
      cached.shell.open === open
    ) {
      return cached
    }

    const shell = this.shells.get(id) ?? { close: () => void this.close(id), done: () => this.exited(id) }

    this.shells.set(id, shell)

    const view: LayerView = {
      id,
      scope: instance.public,
      component,
      page,
      renderKey,
      layout: instance.layout,
      shell: { open, index, isTop, type: instance.type, ...shell },
      attributes: { 'data-layer-id': id, style: { viewTransitionName: `inertia-layer-${id}` } },
    }

    this.cache.set(id, view)

    return view
  }

  // ---------------------------------------------------------------- hooks called from 3.x seam lines

  public captureBase(_visit: PendingVisit, previous?: Origin): Origin {
    const top = this.state.rows.filter((row) => row.phase === 'open').at(-1)?.id ?? null

    return {
      kind: 'base',
      top,
      gen: this.state.base.gen,
      instantGen: previous ? this.state.base.gen : null,
    }
  }

  /** The decision and its state change happen in one reduce call. */
  public route(response: Response): Promise<void> | undefined {
    if (isServer) {
      return undefined
    }

    const { baseScope } = this.connected()
    const page = response.getPageResponse()
    const marks = marksOf(page)

    if (response.scope === baseScope && idle(this.state) && !marks.layer) {
      return undefined
    }

    const visit = response.getVisit()
    const pageUrl = typeof page === 'object' ? hrefToUrl(page.url) : null
    const { outcome } = this.dispatch({
      type: 'responseArrived',
      origin: response.origin,
      marks,
      facts: {
        aimed: pageUrl !== null && isSameUrlWithoutHash(visit.url, pageUrl),
        baseMatches:
          !!marks.layer?.base && isSameUrlWithoutHash(hrefToUrl(marks.layer.base), hrefToUrl(currentPage.get().url)),
        partial: visit.only.length > 0 || visit.except.length > 0 || visit.reset.length > 0,
        async: visit.async,
        preserveState: typeof page === 'object' && RequestParams.resolvePreserveOption(visit.preserveState, page),
        preserveUrl: visit.preserveUrl,
      },
      newId: uid() as LayerId,
    })

    return this.land((outcome as Extract<Outcome, { kind: 'landing' }>).landing, response, page)
  }

  protected land(landing: Landing, response: Response, page: Page): Promise<void> | undefined {
    const { baseScope } = this.connected()

    switch (landing.kind) {
      case 'pass':
        return undefined
      case 'drop':
        return Promise.resolve()
      case 'base':
        return response.retarget(baseScope).land()
      case 'promote': {
        const { layer: _mark, ...plain } = page as Page & { layer?: unknown }

        return response.retarget(baseScope, plain).land()
      }
      case 'open':
        return response.retarget(this.create(landing.id).scope).land()
      case 'rewrite':
      case 'refresh':
        return response.retarget(this.instance(landing.id).scope).land()
      case 'cold':
        throw new Error('A layer that cannot compose over the page on screen lands cold, which needs the walk.')
      default:
        return assertNever(landing)
    }
  }

  protected create(id: LayerId): LayerInstance {
    history.composer = this

    const instance = this.connected().createInstance(id, this, {
      resolveComponent: (name, page) => currentPage.resolve(name, page),
      version: currentPage.get().version,
    })

    this.instances.set(id, instance)

    return instance
  }

  /** The base CurrentPage.write, before the history write. */
  public baseCommitting(page: Page, replace: boolean, _visitId: string | undefined, _initial: boolean): void {
    if (isServer) {
      return
    }

    const live = currentPage.get()

    this.dispatch({
      type: 'baseCommitting',
      mode: replace ? 'replace' : 'push',
      sameAsLive: !!live && live.component === page.component && sameOriginAndPath(live.url, page.url),
    })
  }

  public baseSwapped(): void {
    if (!isServer) {
      this.dispatch({ type: 'baseSwapped' })
    }
  }

  public layerCommitting(instance: LayerInstance, page: Page, replace: boolean): Promise<void> {
    const urlChanged =
      instance.lastWrite !== null && !isSameUrlWithoutHash(hrefToUrl(page.url), hrefToUrl(instance.page.get().url))

    instance.historyPage = page

    const { outcome, waits } = this.dispatch({ type: 'layerCommitting', id: instance.id, requestedReplace: replace, urlChanged })
    const decision = (outcome as Extract<Outcome, { kind: 'commit' }>).decision

    if (decision.kind === 'write') {
      instance.lastWrite = decision.mode
    }

    return Promise.all(waits).then(() => {})
  }

  public layerSwapped(instance: LayerInstance): Promise<void> {
    if (instance.disposed) {
      return Promise.resolve()
    }

    return Promise.all(this.dispatch({ type: 'layerSwapped', id: instance.id }).waits).then(() => {})
  }

  public exited(id: LayerId): void {
    this.dispatch({ type: 'exited', id })
  }

  public rewriteEntry(instance: LayerInstance): void {
    if (this.row(instance.id)?.phase === 'open') {
      this.run({ type: 'writeEntry', mode: 'replace' })
    }
  }

  public clearHistory(): void {
    this.connected().baseScope.router.clearHistory()
  }

  /** The base location while a layer owns the address, else null (window.location). */
  public baseLocation(): URL | null {
    return this.ownsAddress() ? hrefToUrl(currentPage.get().url) : null
  }

  /** The url a bare base reload() hits while a layer owns the address, else null (window.location.href). */
  public baseReloadUrl(): string | null {
    return this.ownsAddress() ? currentPage.get().url : null
  }

  protected ownsAddress(): boolean {
    return this.state.rows.some((row) => row.phase === 'open' && row.type === 'routed' && row.ownsAddress)
  }

  /** The history composer: the base page with every committed layer. Pure read. */
  public compose(page: Page): { data: CompositeEntry; url: string } {
    return composeEntry(
      page,
      this.state.rows.filter((row) => row.phase === 'open').map((row) => this.snapshot(row)),
    )
  }

  protected snapshot(row: LayerRow): LayerEntry {
    const { flash: _flash, ...page } = this.instance(row.id).historyPage!

    return {
      ...page,
      id: row.id,
      key: row.key,
      type: row.type,
      owner: row.owner === 'base' ? null : row.owner,
      entries: row.entries,
      ...(!row.ownsAddress && { preservesUrl: true as const }),
    }
  }

  public popstate(data: Page): Page | null {
    return data
  }

  public restoreOnLoad(data: Page): Page {
    return data
  }

  /** Walks up to a bound wrapper element. Never an attribute read. */
  public scopeOf(el: Element): LayerScope | null {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const id = this.elements.get(node)

      if (id) {
        return this.instances.get(id)?.public ?? null
      }
    }

    return null
  }

  // ---------------------------------------------------------------- adapters

  public views(): readonly LayerView[] {
    return this.painted.views
  }

  public info(): readonly LayerInfo[] {
    return this.painted.info
  }

  public topPage(): Page | null {
    return this.painted.views.filter((view) => view.shell.open).at(-1)?.page ?? null
  }

  /** A listener may return a promise that settles once its DOM shows the views. */
  public subscribe(listener: () => void | Promise<void>): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  public bindElement(id: string, el: Element | null): void {
    const instance = this.instances.get(id as LayerId)

    if (instance) {
      instance.element = el
    }

    if (el) {
      this.elements.set(el, id as LayerId)
    }
  }

  // ---------------------------------------------------------------- the public surface

  public handle(id?: string): LayerScope | undefined {
    const row = id === undefined ? this.state.rows.at(-1) : this.row(id as LayerId)

    return row ? this.instances.get(row.id)?.public : undefined
  }

  public open(_target: LayerTarget, _options: VisitOptions, _owner: PageScope): LayerHandle {
    throw new Error('Opening a layer by handle is not built yet.')
  }

  public close(_id?: string): Promise<void> {
    throw new Error('Closing a layer is not built yet.')
  }

  public key(id: LayerId): string {
    return this.row(id)?.key ?? ''
  }

  public index(id: LayerId): number {
    return this.state.rows.findIndex((row) => row.id === id)
  }

  public emit(id: LayerId, name: string, payload: unknown): void {
    const owner = this.row(id)?.owner
    const from = this.instances.get(id)?.info()

    if (owner && owner !== 'base' && from) {
      this.instances.get(owner)?.inbox.deliver(name, payload, from)
    }
  }

  protected row(id: LayerId): LayerRow | undefined {
    return this.state.rows.find((row) => row.id === id)
  }

  protected instance(id: LayerId): LayerInstance {
    const instance = this.instances.get(id)

    if (!instance) {
      throw new Error(`Layer ${id} has a row but no instance.`)
    }

    return instance
  }

  protected connected(): Connection {
    if (!this.connection) {
      throw new Error('The layer data plane is not loaded; import @inertiajs/core through its index.')
    }

    return this.connection
  }
}

function marksOf(page: Page | string): Marks {
  const mark = typeof page === 'object' ? (page as Page & { layer?: { key?: string; base?: string } }).layer : undefined

  return {
    layer: mark ? { key: mark.key || (page as Page).component, base: mark.base ?? null } : null,
  }
}

function sameOriginAndPath(a: string, b: string): boolean {
  const left = hrefToUrl(a)
  const right = hrefToUrl(b)

  return left.origin === right.origin && left.pathname === right.pathname
}

function assertNever(x: never): never {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`)
}

export const stack = new Stack()
