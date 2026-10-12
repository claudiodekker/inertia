// The runtime. It holds the reducer state, the instance map and the views it last painted. It never
// decides: each hook reads its inputs, dispatches one event, and runs the returned effects in order.
// Client only: on the server every hook returns the 3.x value.

import { get } from 'es-toolkit/compat'
import { history } from '../history'
import { page as currentPage } from '../page'
import { RequestParams } from '../requestParams'
import { Scroll } from '../scroll'
import type { Response } from '../response'
import type { Page, PageResolver, PendingVisit, VisitOptions } from '../types'
import { uid } from '../uid'
import { hrefToUrl, isSameUrlWithoutHash } from '../url'
import { compose as composeEntry, decompose, isBlank, layerPage, type CompositeEntry, type LayerEntry } from './entry'
import type { LayerInstance, StackPort } from './instance'
import { reduce } from './reduce'
import type { PageScope } from './scope'
import {
  idle,
  initialState,
  type CloseId,
  type EntryFacts,
  type Landing,
  type LayerId,
  type LayerRow,
  type Marks,
  type Origin,
  type Outcome,
  type Owner,
  type StackEffect,
  type StackEvent,
  type StackState,
  type VisitId,
  type VisitTag,
  type WaiterId,
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
    type: 'routed' | 'local',
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
  protected waiters = new Map<WaiterId, () => void>()
  /** Visits the stack started, by visit id, until their scope captures them. */
  protected tags = new Map<string, VisitTag>()
  /** The layers of the entry a popstate is applying, for its reopen and rewind effects. */
  protected restoring: readonly LayerEntry[] = []

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
        return effect.ids.forEach((id) => this.dispose(id))
      case 'historyGo':
        return void history
          .go(effect.delta)
          .then((how) => this.dispatch({ type: 'unwindSettled', token: effect.token, how }))
      case 'startVisit':
        return this.startVisit(effect)
      case 'reopen':
        return effect.ids.forEach((id) => this.reopen(id))
      case 'rewind':
        return effect.ids.forEach((id) => this.rewind(id))
      case 'settle':
        return effect.waiters.forEach((waiter) => {
          this.waiters.get(waiter)?.()
          this.waiters.delete(waiter)
        })
      case 'cancelAll':
        return this.connected().baseScope.router.cancelAll({ prefetch: false })
      case 'warn':
        return console.warn(effect.message)
      case 'installBase':
      case 'capturePin':
      case 'releasePin':
      case 'refuse':
        throw new Error(`The layer effect "${effect.type}" is not wired yet.`)
      default:
        return assertNever(effect)
    }
  }

  protected paint(): Promise<void> {
    const rendered = this.state.rows.filter((row) => this.instances.get(row.id)?.view)
    const ghosts = this.state.ghosts.filter((id) => this.instances.get(id)?.view)
    const views = [
      ...rendered.map((row, index) => this.viewOf(row.id, index, index === rendered.length - 1, row.close === null)),
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

  /** Close listeners fire once the paint that removes the view has landed, or at once when none shows it. */
  protected dispose(id: LayerId): void {
    const instance = this.instances.get(id)

    if (!instance) {
      return
    }

    instance.dispose()
    this.instances.delete(id)

    if (this.painted.views.some((view) => view.id === id)) {
      this.leaving.push(instance)
    } else {
      queueMicrotask(() => instance.fireClose())
    }
  }

  protected startVisit(effect: Extract<StackEffect, { type: 'startVisit' }>): void {
    const { tag } = effect

    if (tag.kind !== 'refresh') {
      throw new Error(`The layer visit "${tag.kind}" is not wired yet.`)
    }

    const router = effect.via === 'base' ? this.connected().baseScope.router : this.instance(effect.via).router
    let id: string | null = null

    router.reload({
      onBefore: (visit) => {
        id = visit.id
        this.tags.set(visit.id, tag)
      },
      onFinish: (visit) => {
        this.dispatch({ type: 'visitFinished', visit: visit.id as VisitId })
      },
    })

    if (id !== null && !this.tags.delete(id)) {
      return
    }

    // A before listener refused it, so its scope never captured it: the refresh is over at once.
    const refused = (id ?? uid()) as VisitId

    queueMicrotask(() => {
      this.dispatch({ type: 'visitDispatched', visit: refused, tag })
      this.dispatch({ type: 'visitFinished', visit: refused })
    })
  }

  /** A scope captured a visit at dispatch: one the stack started reports its tag. */
  public captured(visit: PendingVisit): void {
    const tag = this.tags.get(visit.id)

    if (tag) {
      this.tags.delete(visit.id)
      this.dispatch({ type: 'visitDispatched', visit: visit.id as VisitId, tag })
    }
  }

  /** Recreates a layer from the entry being restored, with no request. */
  protected reopen(id: LayerId): void {
    const entry = this.restoring.find((layer) => layer.id === id)

    if (!entry) {
      return
    }

    const instance = this.create(id, entry.type)
    const page = layerPage(entry)

    instance.historyPage = page
    instance.lastWrite = 'replace'
    instance.page.setQuietly(page).then(() => {
      const props = instance.page.get().props
      const missing = Object.entries(page.initialDeferredProps ?? page.deferredProps ?? {})
        .map(([group, names]) => [group, names.filter((name) => get(props, name) === undefined)] as const)
        .filter(([, names]) => names.length > 0)

      if (missing.length > 0 && !instance.disposed) {
        instance.router.loadDeferred(Object.fromEntries(missing))
      }
    })
  }

  /** Same layer, another snapshot of it: set the entry's page quietly. */
  protected rewind(id: LayerId): void {
    const entry = this.restoring.find((layer) => layer.id === id)
    const instance = this.instances.get(id)

    if (entry && instance) {
      const page = layerPage(entry)

      instance.historyPage = page
      instance.page.setQuietly(page, { preserveState: false })
    }
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

  public captureBase(visit: PendingVisit, previous?: Origin): Origin {
    if (!previous) {
      this.captured(visit)
    }

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
      visit: visit.id as VisitId,
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
        replace: visit.replace,
        cycles: false,
        matchesAddressTier: false,
        hasErrors: false,
      },
      newId: uid() as LayerId,
      newClose: uid() as CloseId,
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
      case 'close':
        return response.succeed(
          landing.beneath === 'base' ? currentPage.get() : this.instance(landing.beneath).page.get(),
        )
      case 'cold':
      case 'handback':
      case 'return':
      case 'walk-base':
      case 'walk-beneath':
        throw new Error(`The layer landing "${landing.kind}" is not wired yet.`)
      default:
        return assertNever(landing)
    }
  }

  protected create(id: LayerId, type: 'routed' | 'local' = 'routed'): LayerInstance {
    history.composer = this

    const instance = this.connected().createInstance(id, type, this, {
      resolveComponent: (name, page) => currentPage.resolve(name, page),
      version: currentPage.get().version,
    })

    this.instances.set(id, instance)

    return instance
  }

  /** The base CurrentPage.write, before the history write. */
  public baseCommitting(page: Page, replace: boolean, visitId: string | undefined, initial: boolean): void {
    if (isServer) {
      return
    }

    const live = currentPage.get()

    this.dispatch({
      type: 'baseCommitting',
      visit: (visitId ?? null) as VisitId | null,
      mode: replace ? 'replace' : 'push',
      interstitial: false,
      initial,
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

    const { outcome, waits } = this.dispatch({
      type: 'layerCommitting',
      id: instance.id,
      requestedReplace: replace,
      urlChanged,
    })
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
      this.state.base.blank,
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
      ...(row.standalone && { standalone: true as const }),
    }
  }

  /** The eventHandler popstate hook. Returns what 3.x restores, or null when the stack handled the entry. */
  public popstate(data: Page): Page | null {
    if (isServer) {
      return data
    }

    const { base, layers } = decompose(data)

    if (idle(this.state) && layers.length === 0) {
      return data
    }

    const unwinding = this.state.expect?.kind === 'unwind'

    this.restoring = layers

    const { outcome } = this.dispatch({ type: 'popstate', entry: this.entryFacts(base, layers) })

    this.restoring = []

    if (unwinding) {
      history.answerGo()
    }

    const { restore } = outcome as Extract<Outcome, { kind: 'restore' }>

    if (restore.kind === 'handled') {
      // 3.x restores the entry's scroll on every traversal it runs; this one the stack ran.
      Scroll.restore(history.getScrollRegions())

      return null
    }

    return restore.kind === 'pass' ? data : base
  }

  protected entryFacts(base: Page, layers: readonly LayerEntry[]): EntryFacts {
    const live = currentPage.get()

    return {
      layers: layers.map((layer) => ({
        id: layer.id as LayerId,
        key: layer.key,
        type: layer.type,
        owner: (layer.owner ?? 'base') as Owner,
        standalone: !!layer.standalone,
        ownsAddress: !layer.preservesUrl,
        entries: layer.entries,
      })),
      url: base.url,
      baseSame: base.component === live.component && base.url === live.url,
      blank: isBlank(base),
      sameSnapshot: new Set(
        layers
          .filter((layer) => {
            const page = this.instances.get(layer.id as LayerId)?.page.get()

            return page?.component === layer.component && page.url === layer.url
          })
          .map((layer) => layer.id as LayerId),
      ),
    }
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

  /** Closes `id` (default: the top open layer) and every layer above it. Settles once they are gone. */
  public close(id?: string): Promise<void> {
    if (isServer) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const waiter = uid() as WaiterId

      this.waiters.set(waiter, resolve)
      this.dispatch({
        type: 'closeRequested',
        target: id === undefined ? 'top' : (id as LayerId),
        close: uid() as CloseId,
        waiter,
      })
    })
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
    close: typeof page === 'object' && (page as Page & { close?: unknown }).close === true,
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
