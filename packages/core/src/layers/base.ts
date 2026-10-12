// The stack's side of the page beneath it: where a base visit was made, what a base commit does to the
// stack, and the pages and visits the stack asks the page store and the base router for.

import { fireFlashEvent } from '../events'
import { history } from '../history'
import { page as currentPage } from '../page'
import type { Page, PendingVisit, VisitOptions } from '../types'
import { hrefToUrl } from '../url'
import { blankPage, type BootPlan } from './entry'
import { baseChange, isInterstitial, isRefresh } from './facts'
import { reduce } from './reduce'
import { baseScope } from './scope'
import type { Stack } from './stack'
import { idle, type Answer, type Origin, type StackEffect, type StackEvent, type Token, type VisitId } from './state'

const isServer = typeof window === 'undefined'

export class Base {
  /** The base page set aside while an interstitial prompt is on screen, by token. */
  protected held = new Map<Token, Page>()
  /** The next base commit is the document load's restore of a history entry, so it keeps the stack. */
  protected restoredLoad = false
  /** What each response still landing answers, by visit: its base commit reads this. */
  protected answers = new Map<string, 'refresh' | 'navigation'>()
  /** The last refresh that arrived with nothing open, which lands without the stack. Responses land one at a time. */
  protected passedRefresh: string | null = null

  constructor(protected stack: Stack) {}

  public capture(visit: PendingVisit, previous?: Origin): Origin {
    const { state } = this.stack

    if (!previous) {
      this.stack.captured(visit)
    }

    if (previous?.kind === 'base') {
      // After the visit's own placeholder swap: the dispatch-time facts stand, the swap's gen is recorded.
      return { ...previous, instantGen: state.base.gen }
    }

    const top = state.rows.filter((row) => row.phase === 'open').at(-1)?.id ?? null

    return { kind: 'base', top, gen: state.base.gen, instantGen: null }
  }

  /** This response lands without the stack. A layer that opens before it commits still has to read a refresh as one. */
  public passes(visit: PendingVisit): void {
    this.passedRefresh = isRefresh(visit, currentPage.get()) ? visit.id : null
  }

  /** `own` is the page of the scope the visit was made in. */
  public answering(visit: PendingVisit, own: Page): void {
    this.answers.set(visit.id, isRefresh(visit, own) ? 'refresh' : 'navigation')
  }

  public answered(visit: PendingVisit): void {
    this.answers.delete(visit.id)
  }

  public restoringLoad(): void {
    this.restoredLoad = true
  }

  /** The base CurrentPage.write, before the history write. */
  public committing(page: Page, replace: boolean, visitId: string | undefined, initial: boolean): void {
    if (isServer) {
      return
    }

    const restoredLoad = this.restoredLoad
    const held =
      this.stack.state.rows.length > 0 ? this.stack.history.compose(currentPage.getWithoutFlashData()).data : null

    this.restoredLoad = false
    this.stack.dispatch(this.commit(page, replace, visitId, initial || restoredLoad))

    // history skips the write of a page equal to the one it last wrote, and that entry held the stack this commit dropped.
    if (held && this.stack.state.rows.length === 0) {
      history.setCurrent(held)
    }
  }

  protected commit(page: Page, replace: boolean, visitId: string | undefined, initial: boolean): StackEvent {
    return {
      type: 'baseCommitting',
      visit: (visitId ?? null) as VisitId | null,
      mode: replace ? 'replace' : 'push',
      interstitial: isInterstitial(page),
      initial,
      change: baseChange(currentPage.get(), page),
      answer: this.answerOf(visitId),
    }
  }

  protected answerOf(visitId: string | undefined): Answer {
    if (visitId === undefined) {
      return null
    }

    return this.answers.get(visitId) ?? (visitId === this.passedRefresh ? 'refresh' : null)
  }

  public swapped(): void {
    if (isServer) {
      return
    }

    this.stack.dispatch({ type: 'baseSwapped' })

    // A layer with no url of its own reads the address beneath it, which this page may just have moved.
    if (this.stack.hasLocalLayer()) {
      void this.stack.paint()
    }
  }

  /**
   * What a committing base page compares its url with to tell a replace from a push: the base url while a
   * layer owns the address and the commit keeps the stack, else null (window.location), so a navigation
   * that drops the stack pushes unless it lands on the address the layer held. A refresh that moves the
   * base beneath a stack it keeps is compared with its own url, so it rewrites the entry: the address is
   * still the layer's.
   */
  public location(page: Page, replace: boolean, visitId: string | undefined, initial: boolean): URL | null {
    const commit = this.commit(page, replace, visitId, initial || this.restoredLoad)

    if (!this.stack.ownsAddress() || reduce(this.stack.state, commit).state.rows.length === 0) {
      return null
    }

    return hrefToUrl(this.answerOf(visitId) === 'refresh' ? page.url : currentPage.get().url)
  }

  /**
   * The url a bare base reload() hits while the stack holds anything, else null (window.location.href):
   * the address may be a layer's, or a history write the stack queued may not have landed yet.
   */
  public reloadUrl(): string | null {
    return idle(this.stack.state) ? null : currentPage.get().url
  }

  /** Sets the base page the reducer asked for. Its commit carries the token as its visit id. */
  public install({ token, source, mode }: Extract<StackEffect, { type: 'installBase' }>): void {
    void currentPage.set(this.pageFrom(source), {
      replace: mode === 'replace',
      preserveScroll: true,
      preserveState: false,
      visitId: String(token),
    })
  }

  protected pageFrom(source: Extract<StackEffect, { type: 'installBase' }>['source']): Page {
    if (source.kind === 'held') {
      return { ...this.held.get(source.token)!, flash: {} }
    }

    if (source.kind === 'promote') {
      return this.stack.instance(source.layer).page.get()
    }

    // A blank carries the version its layer arrived on: the first base fetch sends it.
    const { expect } = this.stack.state
    const waiting = expect?.kind === 'base' ? this.stack.instance(expect.layer) : null

    return blankPage(source.url, waiting!.historyPage!)
  }

  /** Inside baseCommitting, before the write: still the outgoing base. */
  public hold(token: Token): void {
    this.held.set(token, currentPage.get())
  }

  public release(token: Token): void {
    this.held.delete(token)
  }

  /** A background base visit replacing the blank. A failed fetch shows no overlay. */
  public fetch(tag: { kind: 'fetchBase' | 'recover' }, url: string): void {
    let id: VisitId | null = null
    const failed =
      tag.kind === 'fetchBase'
        ? () => {
            this.stack.dispatch({ type: 'baseFetchFailed', visit: id! })

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

    id = this.stack.visits.follow(tag, options, (followed) => baseScope.router.visit(url, followed))
  }

  /** The blank takes the url fetched next and is resolved again, so the loading resolver sees that url. */
  public setBlankUrl(url: string): void {
    void currentPage.set({ ...currentPage.get(), url }, { replace: true, preserveScroll: true, preserveState: true })
  }

  /**
   * The flash a layer arrived with on the document is announced as the document's own is: after the
   * initial navigate event. A load that restores a history entry announces none.
   */
  public announceFlash(plan: BootPlan): void {
    const flashes = plan.layers.map((layer) => layer.page.flash).filter((flash) => Object.keys(flash).length > 0)

    if (flashes.length === 0) {
      return
    }

    baseScope.router.once('navigate', (event) => {
      if (event.detail.type === 'initial') {
        queueMicrotask(() => flashes.forEach((flash) => fireFlashEvent(flash)))
      }
    })
  }
}
