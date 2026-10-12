// The stack in the browser's history: what an entry stores, the writes and steps back the reducer asks
// for, and applying an entry the browser restored.

import { history } from '../history'
import { page as currentPage } from '../page'
import { Scroll } from '../scroll'
import type { Page } from '../types'
import { hrefToUrl } from '../url'
import { entryRows } from './close'
import { compose, decompose, isBlank, layerPage, type CompositeEntry, type LayerEntry } from './entry'
import { entryFacts, snapshot } from './facts'
import type { Stack } from './stack'
import { idle, type EntryFacts, type LayerId, type LayerRow, type Outcome, type Token } from './state'

const isServer = typeof window === 'undefined'

type Write = (data: Page | ArrayBuffer) => Promise<void>

export class StackHistory {
  /** The layers of the entry a popstate is applying, for its reopen and rewind effects. */
  protected restoring: readonly LayerEntry[] = []
  /** The row that counted the base page's next push. */
  protected chargedForNextPush: LayerId | undefined

  constructor(protected stack: Stack) {}

  /** From the first layer on, every pushState and replaceState stores the stack with the page. */
  public composeWrites(): void {
    history.composer = this
  }

  /** The base page with every committed layer that is not being closed. Pure read. */
  public compose(page: Page): { data: CompositeEntry; url: string } {
    const { stored, addressed } = entryRows(this.stack.state)
    const composed = (rows: readonly LayerRow[]) =>
      compose(
        page,
        rows.map((row) => snapshot(row, this.stack.instance(row.id).historyPage!)),
        this.stack.state.base.blank,
      )

    return { data: composed(stored).data, url: composed(addressed).url }
  }

  /** `charged` is the row that counted this push. */
  public write(mode: 'push' | 'replace', charged?: LayerId): Promise<void> {
    const { data, url } = this.compose(currentPage.getWithoutFlashData())

    return history.writeEntry(data, url, mode, (write) => this.givingBack(charged, write))
  }

  public watchNextPush(charged: LayerId): void {
    this.chargedForNextPush = charged
  }

  /** The history hook for a pushState of the base page. */
  public watchPush(push: Write): Write {
    const charged = this.chargedForNextPush

    this.chargedForNextPush = undefined

    return this.givingBack(charged, push)
  }

  /**
   * A push the browser accepted leaves a new state object behind. One it refused (throttled or over
   * quota) added no entry, so the row that counted it gets it back.
   */
  protected givingBack(charged: LayerId | undefined, push: Write): Write {
    if (!charged) {
      return push
    }

    return (data) => {
      const before = window.history.state

      return push(data).then(() => {
        if (window.history.state === before) {
          this.stack.dispatch({ type: 'writeRefused', id: charged })
        }
      })
    }
  }

  public go(delta: number, token: Token): void {
    void history.go(delta).then((how) => this.stack.dispatch({ type: 'unwindSettled', token, how }))
  }

  /** Recreates a layer from the entry being restored, with no request. */
  public reopen(id: LayerId): void {
    const entry = this.restoring.find((layer) => layer.id === id)

    if (entry) {
      this.stack.create(id, entry.type).restore(layerPage(entry))
    }
  }

  /** Same layer, another snapshot of it: set the entry's page quietly. */
  public rewind(id: LayerId): void {
    const entry = this.restoring.find((layer) => layer.id === id)

    if (entry) {
      this.stack.find(id)?.rewind(layerPage(entry))
    }
  }

  /** The eventHandler popstate hook. Returns the page the handler goes on to restore, or null when the stack handled the entry. */
  public popstate(data: Page): Page | null {
    if (isServer) {
      return data
    }

    const { base, layers } = decompose(data)

    if (idle(this.stack.state) && layers.length === 0 && !isBlank(base)) {
      return data
    }

    const unwinding = this.stack.state.expect?.kind === 'unwind'

    this.restoring = layers

    const { outcome } = this.stack.dispatch({ type: 'popstate', entry: this.entryFacts(base, layers) })

    this.restoring = []

    if (unwinding) {
      history.answerGo()
    }

    const { restore } = outcome as Extract<Outcome, { kind: 'restore' }>

    if (restore.kind === 'handled') {
      // The popstate handler restores the entry's scroll on every traversal it runs; this one the stack ran.
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
    if (isServer || this.stack.state.rows.length === 0) {
      return false
    }

    const { owner } = this.stack.dispatch({ type: 'anchored' }).outcome as Extract<Outcome, { kind: 'anchor' }>

    if (owner === null) {
      return false
    }

    const instance = this.stack.instance(owner)
    const url = hrefToUrl(instance.page.get().url)

    url.hash = hash
    instance.page.merge({ url: url.href })
    instance.historyPage = { ...instance.historyPage!, url: url.href }
    void this.write('replace')

    return true
  }

  /** initialVisit's back/forward restore: an entry with layers or a blank base replaces the boot rows. */
  public restoreOnLoad(data: Page): Page {
    if (isServer) {
      return data
    }

    const { base, layers } = decompose(data)

    if (layers.length === 0 && !isBlank(base) && idle(this.stack.state)) {
      return data
    }

    this.composeWrites()
    this.restoring = layers
    this.stack.dispatch({ type: 'restoredOnLoad', entry: this.entryFacts(base, layers) })
    this.restoring = []
    this.stack.base.restoringLoad()

    return base
  }

  protected entryFacts(base: Page, layers: readonly LayerEntry[]): EntryFacts {
    return entryFacts(base, layers, currentPage.get(), (id) => this.stack.find(id)?.page.get())
  }
}
