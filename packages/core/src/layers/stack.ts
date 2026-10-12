// The runtime. It holds the reducer state and the layer instances. It never decides: each hook reads its
// inputs, dispatches one event, and runs the returned effects in order. Client only: on the server
// every hook returns what an app without layers gets.

import { interceptors } from '../interceptors'
import { page as currentPage, type CurrentPage } from '../page'
import type { Response } from '../response'
import type { Router } from '../router'
import type { Component, Page, PendingVisit } from '../types'
import { uid } from '../uid'
import { hrefToUrl, isSameUrlWithoutHash } from '../url'
import { Base } from './base'
import { isBlank, type BootPlan } from './entry'
import { marksOf, routeFacts } from './facts'
import { LayerInstance, type StackPort } from './instance'
import { land } from './land'
import { OpenRequests } from './openRequests'
import { reduce } from './reduce'
import { baseScope, type PageScope } from './scope'
import { StackHistory } from './stackHistory'
import {
  idle,
  initialState,
  type CloseId,
  type LayerId,
  type LayerRow,
  type Outcome,
  type StackEffect,
  type StackEvent,
  type StackState,
  type VisitId,
  type WaiterId,
} from './state'
import type { LayerScope } from './types'
import { LayerViews } from './views'
import { Visits } from './visits'

const isServer = typeof window === 'undefined'

export class Stack implements StackPort {
  public readonly base = new Base(this)
  public readonly history = new StackHistory(this)
  public readonly requests = new OpenRequests(this)
  /** What the adapters render: the views last painted. */
  public readonly views = new LayerViews((id) => ({ close: () => void this.close(id), done: () => this.exited(id) }))
  public readonly visits = new Visits((event) => void this.dispatch(event))
  protected current: StackState = initialState
  protected instances = new Map<LayerId, LayerInstance>()
  protected elements = new WeakMap<Element, LayerId>()
  protected waiters = new Map<WaiterId, () => void>()

  public get state(): StackState {
    return this.current
  }

  public dispatch(event: StackEvent): { outcome: Outcome; waits: Promise<unknown>[] } {
    const step = reduce(this.current, event)

    this.current = step.state

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
      case 'writeEntry':
        return this.history.write(effect.mode, effect.charged)
      case 'dispose':
        return effect.ids.forEach((id) => this.dispose(id))
      case 'watchBasePush':
        return this.history.watchNextPush(effect.charged)
      case 'historyGo':
        return this.history.go(effect.delta, effect.token)
      case 'startVisit':
        return this.startVisit(effect)
      case 'reopen':
        return effect.ids.forEach((id) => this.history.reopen(id))
      case 'rewind':
        return effect.ids.forEach((id) => this.history.rewind(id))
      case 'settle':
        return effect.waiters.forEach((waiter) => {
          this.waiters.get(waiter)?.()
          this.waiters.delete(waiter)
        })
      case 'cancelAll':
        return baseScope.router.cancelAll({ prefetch: false })
      case 'warn':
        return console.warn(effect.message)
      case 'installBase':
        return this.base.install(effect)
      case 'setBlankUrl':
        return this.base.setBlankUrl(effect.url)
      case 'holdBase':
        return this.base.hold(effect.token)
      case 'releaseBase':
        return this.base.release(effect.token)
      case 'refuse':
        return this.requests.refuse(effect.request)
      default:
        return assertNever(effect)
    }
  }

  public paint(): Promise<void> {
    // The boot paints its layers before the router gives the page beneath them to the page store.
    const baseUrl = currentPage.get()?.url ?? ''

    return this.views.paint(this.state.rows, this.state.dismissed, this.instances, baseUrl)
  }

  protected dispose(id: LayerId): void {
    const instance = this.instances.get(id)

    if (instance) {
      instance.dispose()
      this.instances.delete(id)
      this.views.removed(instance)
    }
  }

  protected startVisit(effect: Extract<StackEffect, { type: 'startVisit' }>): void {
    const { tag } = effect

    if (tag.kind === 'fetchBase' || tag.kind === 'recover') {
      // After the task that asked for it: a popstate's own cancelAll runs right after its dispatch.
      return queueMicrotask(() => this.base.fetch(tag, effect.url!))
    }

    if (tag.kind !== 'refresh') {
      throw new Error(`The stack starts no "${tag.kind}" visit: an open is sent by its caller.`)
    }

    const router = effect.via === 'base' ? baseScope.router : this.instance(effect.via).router

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

  public captured(visit: PendingVisit): void {
    this.visits.captured(visit)
  }

  public placeholderFailed(instance: LayerInstance, visit: PendingVisit): void {
    this.dispatch({ type: 'placeholderFailed', id: instance.id, visit: visit.id as VisitId })
  }

  /** The decision and its state change happen in one reduce call. */
  public route(response: Response): Promise<void> | undefined {
    if (isServer) {
      return undefined
    }

    const page = response.getPageResponse()
    const marks = marksOf(page)

    const visit = response.getVisit()

    if (response.scope === baseScope && idle(this.state) && !marks.layer) {
      this.base.passes(visit)

      return undefined
    }

    const live = this.state.rows.filter((row) => this.instances.has(row.id))
    const addressOwner = live.filter((row) => row.phase === 'open' && row.ownsAddress).at(-1)
    const facts = routeFacts(visit, page, marks, {
      base: currentPage.get(),
      live: live.map((row) => this.instance(row.id).page.get()),
      addressOwner: addressOwner ? this.instance(addressOwner.id).page.get() : currentPage.get(),
    })
    const { outcome } = this.dispatch({
      type: 'responseArrived',
      visit: visit.id as VisitId,
      origin: response.origin,
      marks,
      facts,
      newId: uid() as LayerId,
      newClose: uid() as CloseId,
    })
    const { landing } = outcome as Extract<Outcome, { kind: 'landing' }>

    this.base.answering(visit, response.scope.page.get())

    const targets = {
      base: baseScope,
      create: (id: LayerId) => this.create(id),
      layer: (id: LayerId) => this.instance(id),
    }
    const landed = (land(landing, response, page, targets) ?? response.land()).finally(() => this.base.answered(visit))

    if ('id' in landing && landing.kind !== 'close' && landing.kind !== 'handback') {
      this.requests.bind(this.instance(landing.id), visit.id)
    }

    return landed
  }

  public create(
    id: LayerId,
    type: 'routed' | 'local' = 'routed',
    version: string | null = currentPage.get().version,
  ): LayerInstance {
    this.history.composeWrites()

    const instance = new LayerInstance(id, type, this, {
      resolveComponent: (name, page) => currentPage.resolve(name, page),
      version,
    })

    this.instances.set(id, instance)

    return instance
  }

  public layerCommitting(instance: LayerInstance, page: Page, replace: boolean): Promise<void> {
    const urlChanged =
      instance.lastWrite !== null && !isSameUrlWithoutHash(hrefToUrl(page.url), hrefToUrl(instance.page.get().url))

    instance.historyPage = page

    // One asset version for the whole document: the page's next request sends the one this layer arrived on.
    if (page.version !== currentPage.get().version) {
      currentPage.merge({ version: page.version })
    }

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
      void this.history.write('replace')
    }
  }

  public clearHistory(): void {
    baseScope.router.clearHistory()
  }

  /** A layer's url is the address, so the browser's hash belongs to that layer and not to the base. */
  public ownsAddress(): boolean {
    return this.state.rows.some((row) => row.phase === 'open' && row.type === 'routed' && row.ownsAddress)
  }

  /**
   * A base fetch asks for the page beneath the stack. The blank base carries its url, so a visit would
   * take the fetch for a request aimed at the page it leaves, and cancel it.
   */
  public fetchesBase(visit: string): boolean {
    return this.state.ops.get(visit as VisitId)?.kind === 'fetchBase'
  }

  /**
   * The page whose once props a response would land among: the page's own for a plain answer, the layer
   * open under its key for a layer's, and none for a layer nothing has opened yet.
   */
  public oncePage(response: Page): CurrentPage | null {
    const { layer } = marksOf(response)
    const row = layer && this.state.rows.find((row) => row.type === 'routed' && row.key === layer.key)

    return layer ? ((row && this.instances.get(row.id)?.page) ?? null) : currentPage
  }

  /** True for the router of a layer with no url of its own: nothing it shows can be written to the address. */
  public urlless(router: Router): boolean {
    return [...this.instances.values()].some((instance) => instance.router === router && instance.type === 'local')
  }

  /** The document load: an instance for each layer of the plan, so the first render shows them. Before mount. */
  public boot(plan: BootPlan, components: readonly unknown[]): void {
    if (isServer || plan.layers.length === 0) {
      return
    }

    plan.layers.forEach(({ row, page }, index) => {
      this.create(row.id, row.type, page.version).setInitial(page, components[index] as Component)
    })
    this.dispatch({
      type: 'booted',
      layers: plan.layers.map((layer) => layer.row),
      blank: isBlank(plan.base),
      declaredBase: plan.declaredBase,
    })
    void this.paint()
    queueMicrotask(() => this.instances.forEach((instance) => instance.loadMissingDeferred()))
    this.base.announceFlash(plan)
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

  public bindElement(id: string, el: Element | null): void {
    const instance = this.instances.get(id as LayerId)

    if (instance) {
      instance.element = el
    }

    if (el) {
      this.elements.set(el, id as LayerId)
    }
  }

  public handle(id?: string): LayerScope | undefined {
    const row = id === undefined ? this.state.rows.at(-1) : this.row(id as LayerId)

    return row ? this.instances.get(row.id)?.public : undefined
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
    const to = owner && owner !== 'base' && from ? this.instances.get(owner) : undefined

    interceptors.fireLayerEvent({ type: 'event', from: id, to: to?.id ?? null, name, payload })
    to?.messages.deliver(name, payload, from!)
  }

  protected row(id: LayerId): LayerRow | undefined {
    return this.state.rows.find((row) => row.id === id)
  }

  public find(id: LayerId): LayerInstance | undefined {
    return this.instances.get(id)
  }

  public instanceOf(scope: PageScope): LayerInstance | undefined {
    return [...this.instances.values()].find((instance) => instance.scope === scope)
  }

  /** An instance created for a row that never came to be. */
  public forget(id: LayerId): void {
    this.instances.delete(id)
  }

  public hasLocalLayer(): boolean {
    return [...this.instances.values()].some((instance) => instance.type === 'local')
  }

  public instance(id: LayerId): LayerInstance {
    const instance = this.instances.get(id)

    if (!instance) {
      throw new Error(`Layer ${id} has a row but no instance.`)
    }

    return instance
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`)
}

export const stack = new Stack()
