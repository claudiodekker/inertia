import type { Page } from '../types'
import type { LayerInstance } from './instance'
import type { HistoryPort } from './scope'

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
