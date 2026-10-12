// The runtime. It holds the reducer state, the instance map and the views it last painted. It never
// decides: each hook reads its inputs, dispatches one event, and runs the returned effects in order.
// Client only: on the server every hook returns the 3.x value.

import { get } from 'es-toolkit/compat'
import { history } from '../history'
import { page as currentPage } from '../page'
import type { Response } from '../response'
import { Scroll } from '../scroll'
import type { CancelToken, Component, Page, PageResolver, PendingVisit, VisitOptions } from '../types'
import { uid } from '../uid'
import { hrefToUrl, isSameUrlWithoutHash } from '../url'
import {
  blankPage,
  compose as composeEntry,
  decompose,
  isBlank,
  layerPage,
  type BootPlan,
  type CompositeEntry,
  type LayerEntry,
} from './entry'
import { entryFacts, isInterstitial, marksOf, routeFacts, sameOriginAndPath, snapshot, stripMark } from './facts'
import { TicketHandle } from './handles'
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
  type Origin,
  type Outcome,
  type StackEffect,
  type StackEvent,
  type Owner,
  type StackState,
  type Token,
  type VisitId,
  type VisitTag,
  type WaiterId,
} from './state'
import type { LayerHandle, LayerScope, LayerTarget } from './types'
import { Painter, type LayerView } from './views'
import { Visits } from './visits'

export type { LayerView }

interface Connection {
  baseScope: PageScope
  createInstance(
    id: LayerId,
    type: 'routed' | 'local',
    port: StackPort,
    options: { resolveComponent: PageResolver; version: string | null },
  ): LayerInstance
}

const isServer = typeof window === 'undefined'

export class Stack implements StackPort {
  protected state: StackState = initialState
  protected instances = new Map<LayerId, LayerInstance>()
  protected connection: Connection | null = null
  /** What the adapters render: the views last painted. */
  public readonly painter = new Painter((id) => ({ close: () => void this.close(id), done: () => this.exited(id) }))
  protected elements = new WeakMap<Element, LayerId>()
  protected waiters = new Map<WaiterId, () => void>()
  protected visits = new Visits((event) => void this.dispatch(event))
  /** Handles of programmatic opens no landing has named yet, by ticket. */
  protected pending = new Map<LayerId, TicketHandle>()
  /** The base page each interstitial pin set aside. */
  protected pinned = new Map<Token, Page>()
  /** The layers of the entry a popstate is applying, for its reopen and rewind effects. */
  protected restoring: readonly LayerEntry[] = []
  /** The next base commit is the document load's restore of a history entry, so it keeps the stack. */
  protected restoredLoad = false

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
        const { charged } = effect

        return history.writeEntry(data, url, effect.mode).then((written) => {
          if (!written && charged) {
            this.dispatch({ type: 'writeRefused', id: charged })
          }
        })
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
        return this.installBase(effect)
      case 'capturePin':
        // Inside baseCommitting, before the write: still the outgoing base.
        return void this.pinned.set(effect.token, currentPage.get())
      case 'releasePin':
        return void this.pinned.delete(effect.token)
      case 'refuse': {
        const handle = this.pending.get(effect.ticket)

        this.pending.delete(effect.ticket)

        return queueMicrotask(() => handle?.fireClose())
      }
      default:
        return assertNever(effect)
    }
  }

  protected paint(): Promise<void> {
    return this.painter.paint(this.state.rows, this.state.ghosts, this.instances)
  }

  protected dispose(id: LayerId): void {
    const instance = this.instances.get(id)

    if (instance) {
      instance.dispose()
      this.instances.delete(id)
      this.painter.left(instance)
    }
  }

  protected startVisit(effect: Extract<StackEffect, { type: 'startVisit' }>): void {
    const { tag } = effect

    if (tag.kind === 'walk' || tag.kind === 'recover') {
      // After the task that asked for it: a popstate's own 3.x cancelAll runs right after its dispatch.
      return queueMicrotask(() => this.fetchBase(tag, effect.url!))
    }

    if (tag.kind !== 'refresh') {
      throw new Error(`The stack starts no "${tag.kind}" visit: an open is sent by its caller.`)
    }

    const router = effect.via === 'base' ? this.connected().baseScope.router : this.instance(effect.via).router

    if (this.visits.follow(tag, {}, (options) => router.reload(options))) {
      return
    }

    // A before listener refused it, so its scope never captured it: the refresh is over at once.
    const refused = uid() as VisitId

    queueMicrotask(() => {
      this.dispatch({ type: 'visitDispatched', visit: refused, tag })
      this.dispatch({ type: 'visitFinished', visit: refused })
    })
  }

  /** A walk hop or a recovery: a background base visit replacing the blank. A failed hop shows no overlay. */
  protected fetchBase(tag: Extract<VisitTag, { kind: 'walk' | 'recover' }>, url: string): void {
    let id: VisitId | null = null
    const failed =
      tag.kind === 'walk'
        ? () => {
            this.dispatch({ type: 'walkHopFailed', visit: id! })

            return false
          }
        : undefined
    const options: VisitOptions = {
      async: true,
      replace: true,
      preserveState: true,
      preserveScroll: true,
      onHttpException: failed,
      onNetworkError: failed,
    }

    id = this.visits.follow(tag, options, (followed) => this.connected().baseScope.router.visit(url, followed))
  }

  /** 3.x installs the base page the reducer asked for; its commit carries the token as its visit id. */
  protected installBase({ token, source, mode }: Extract<StackEffect, { type: 'installBase' }>): void {
    // A blank carries the version its layer arrived on: the walk's first hop sends it (L:1136).
    const waiting = this.state.expect?.kind === 'base' ? this.instance(this.state.expect.layer) : null
    const page =
      source.kind === 'blank'
        ? blankPage(source.url, waiting!.historyPage!)
        : source.kind === 'pinned'
          ? { ...this.pinned.get(source.pin)!, flash: {} }
          : stripMark(this.instance(source.layer).page.get())

    void currentPage.set(page, {
      replace: mode === 'replace',
      preserveScroll: true,
      preserveState: false,
      visitId: String(token),
    })
  }

  public captured(visit: PendingVisit): void {
    this.visits.captured(visit)
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
    instance.page.setQuietly(page).then(() => this.loadMissingDeferred(instance))
  }

  /** Deferred props a page restored or seeded without a request still lacks load through its router. */
  protected loadMissingDeferred(instance: LayerInstance): void {
    const page = instance.page.get()
    const missing = Object.entries(page.initialDeferredProps ?? page.deferredProps ?? {})
      .map(([group, names]) => [group, names.filter((name) => get(page.props, name) === undefined)] as const)
      .filter(([, names]) => names.length > 0)

    if (missing.length > 0 && !instance.disposed) {
      instance.router.loadDeferred(Object.fromEntries(missing))
    }
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

  // ---------------------------------------------------------------- hooks called from 3.x seam lines

  public captureBase(visit: PendingVisit, previous?: Origin): Origin {
    if (!previous) {
      this.captured(visit)
    }

    if (previous?.kind === 'base') {
      // After the visit's own placeholder swap: the dispatch-time facts stand, the swap's gen is recorded.
      return { ...previous, instantGen: this.state.base.gen }
    }

    const top = this.state.rows.filter((row) => row.phase === 'open').at(-1)?.id ?? null

    return { kind: 'base', top, gen: this.state.base.gen, instantGen: null }
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
    const live = this.state.rows.filter((row) => this.instances.has(row.id))
    const addressTier = live.filter((row) => row.phase === 'open' && row.ownsAddress).at(-1)
    const { outcome } = this.dispatch({
      type: 'responseArrived',
      visit: visit.id as VisitId,
      origin: response.origin,
      marks,
      facts: routeFacts(visit, page, marks, {
        base: currentPage.get(),
        live: live.map((row) => this.instance(row.id).page.get()),
        addressTier: addressTier ? this.instance(addressTier.id).page.get() : currentPage.get(),
      }),
      newId: uid() as LayerId,
      newClose: uid() as CloseId,
    })
    const { landing } = outcome as Extract<Outcome, { kind: 'landing' }>
    const landed = this.land(landing, response, page)

    if ('id' in landing && landing.kind !== 'close' && landing.kind !== 'handback') {
      this.bindHandles(landing.id, visit.id)
    }

    return landed
  }

  /** The landing named a row: the handle that asked for it by ticket or by this visit is that row's now. */
  protected bindHandles(id: LayerId, visit: string): void {
    for (const [ticket, handle] of this.pending) {
      if (ticket === id || handle.visit === visit) {
        this.pending.delete(ticket)
        handle.bind(this.instance(id))
      }
    }
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
      case 'promote':
      case 'walk-base':
        return response.retarget(baseScope, stripMark(page)).land()
      case 'open':
      case 'cold':
      case 'return':
      case 'walk-beneath':
        return response.retarget(this.create(landing.id).scope).land()
      case 'rewrite':
      case 'refresh':
        return response.retarget(this.instance(landing.id).scope).land()
      case 'close':
        return response.succeed(
          landing.beneath === 'base' ? currentPage.get() : this.instance(landing.beneath).page.get(),
        )
      case 'handback': {
        // The layer keeps its page; only the answer's errors and flash land, on the layer that asked.
        const instance = this.instance(landing.id)
        const own = instance.page.get()

        return response
          .retarget(instance.scope, { ...own, props: { ...own.props, errors: page.props.errors }, flash: page.flash })
          .land()
      }
      default:
        return assertNever(landing)
    }
  }

  protected create(
    id: LayerId,
    type: 'routed' | 'local' = 'routed',
    version: string | null = currentPage.get().version,
  ): LayerInstance {
    history.composer = this

    const instance = this.connected().createInstance(id, type, this, {
      resolveComponent: (name, page) => currentPage.resolve(name, page),
      version,
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
    const restoredLoad = this.restoredLoad

    this.restoredLoad = false
    this.dispatch({
      type: 'baseCommitting',
      visit: (visitId ?? null) as VisitId | null,
      mode: replace ? 'replace' : 'push',
      interstitial: isInterstitial(page),
      initial: initial || restoredLoad,
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

  /**
   * The url a bare base reload() hits while the stack holds anything, else null (window.location.href):
   * the address may be a layer's, or a history write the stack queued may not have landed yet.
   */
  public baseReloadUrl(): string | null {
    return idle(this.state) ? null : currentPage.get().url
  }

  /** A layer's url is the address, so the browser's hash belongs to that layer and not to the base. */
  public ownsAddress(): boolean {
    return this.state.rows.some((row) => row.phase === 'open' && row.type === 'routed' && row.ownsAddress)
  }

  /** The history composer: the base page with every committed layer. Pure read. */
  public compose(page: Page): { data: CompositeEntry; url: string } {
    return composeEntry(
      page,
      this.state.rows
        .filter((row) => row.phase === 'open')
        .map((row) => snapshot(row, this.instance(row.id).historyPage!)),
      this.state.base.blank,
    )
  }

  /** The eventHandler popstate hook. Returns what 3.x restores, or null when the stack handled the entry. */
  public popstate(data: Page): Page | null {
    if (isServer) {
      return data
    }

    const { base, layers } = decompose(data)

    if (idle(this.state) && layers.length === 0 && !isBlank(base)) {
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

  /**
   * The eventHandler hook for an entry the browser wrote itself (an in-page anchor). True when a layer
   * owns the address: the hash went onto that layer's url and the base stays as it is.
   */
  public anchored(hash: string): boolean {
    if (isServer || this.state.rows.length === 0) {
      return false
    }

    const { owner } = this.dispatch({ type: 'anchored' }).outcome as Extract<Outcome, { kind: 'anchor' }>

    if (owner === null) {
      return false
    }

    const instance = this.instance(owner)
    const url = hrefToUrl(instance.page.get().url)

    url.hash = hash
    instance.page.merge({ url: url.href })
    instance.historyPage = { ...instance.historyPage!, url: url.href }
    this.run({ type: 'writeEntry', mode: 'replace' })

    return true
  }

  /** initialVisit's back/forward restore: an entry with layers or a blank base replaces the boot rows. */
  public restoreOnLoad(data: Page): Page {
    if (isServer) {
      return data
    }

    const { base, layers } = decompose(data)

    if (layers.length === 0 && !isBlank(base) && idle(this.state)) {
      return data
    }

    history.composer = this
    this.restoring = layers
    this.dispatch({ type: 'restoredOnLoad', entry: this.entryFacts(base, layers) })
    this.restoring = []
    this.restoredLoad = true

    return base
  }

  /** The document load: seed instances from the plan, so the first render shows them. Before mount. */
  public boot(plan: BootPlan, components: readonly unknown[]): void {
    if (isServer || plan.seeds.length === 0) {
      return
    }

    history.composer = this

    plan.seeds.forEach(({ row, page }, index) => {
      this.create(row.id, row.type, page.version).seed(page, components[index] as Component)
    })
    this.dispatch({
      type: 'booted',
      seeds: plan.seeds.map((seed) => seed.row),
      blank: isBlank(plan.base),
      walkTo: plan.walkTo,
    })
    void this.paint()
    queueMicrotask(() => this.instances.forEach((instance) => this.loadMissingDeferred(instance)))
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

  /** `scope` is the router's that was asked: a layer owns what it opens, the base hands it to the top layer. */
  public open(target: LayerTarget, options: VisitOptions, scope: PageScope): LayerHandle {
    const id = uid() as LayerId
    const handle = new TicketHandle(id, {
      close: (bound) => this.close(bound),
      giveUp: (ticket) => void this.dispatch({ type: 'openRefused', ticket }),
    })
    const asking = [...this.instances.values()].find((instance) => instance.scope === scope)
    const owner: Owner = asking?.id ?? this.state.rows.filter((row) => row.phase === 'open').at(-1)?.id ?? 'base'

    if (typeof target === 'object' && !(target instanceof URL) && !('url' in target)) {
      this.openLocal(handle, id, owner, target)

      return handle
    }

    this.pending.set(id, handle)
    this.dispatch({ type: 'openRequested', ticket: id, owner })

    handle.visit = this.visits.follow(
      { kind: 'open', ticket: id },
      {
        ...options,
        onCancelToken: (token: CancelToken) => {
          handle.abort = token.cancel
          options.onCancelToken?.(token)
        },
      },
      (followed) => scope.router.visit(target, followed),
    )

    if (handle.visit === null) {
      this.dispatch({ type: 'openRefused', ticket: id })
    }

    return handle
  }

  /** No request and no ticket: the row exists once the component resolved, with the instance owning its page. */
  protected openLocal(
    handle: TicketHandle,
    id: LayerId,
    owner: Owner,
    { component, props }: { component: string; props?: Record<string, unknown> },
  ): void {
    handle.abort = () => handle.fireClose()

    const opened = currentPage.resolve(component).then(() => {
      if (handle.state !== 'pending') {
        return
      }

      this.dispatch({ type: 'localOpened', id, owner, key: component })

      const instance = this.create(id, 'local')

      handle.bind(instance)

      return instance.page.set(
        {
          component,
          props: { errors: {}, ...props },
          url: '',
          version: currentPage.get().version,
          flash: {},
          rescuedProps: [],
          rememberedState: {},
        },
        { preserveScroll: true, preserveState: false },
      )
    })

    opened.catch((error) => {
      handle.fireClose()

      throw error
    })
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

  protected entryFacts(base: Page, layers: readonly LayerEntry[]): EntryFacts {
    return entryFacts(base, layers, currentPage.get(), (id) => this.instances.get(id)?.page.get())
  }

  protected connected(): Connection {
    if (!this.connection) {
      throw new Error('The layer data plane is not loaded; import @inertiajs/core through its index.')
    }

    return this.connection
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`)
}

export const stack = new Stack()
