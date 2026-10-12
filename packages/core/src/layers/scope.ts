import { router } from '..'
import { history } from '../history'
import { page } from '../page'
import type { Response } from '../response'
import type { Router } from '../router'
import type { Page, PendingVisit } from '../types'

export type Origin =
  | { kind: 'base'; top: string | null; gen: number; instantGen: number | null }
  | { kind: 'layer'; id: string; instant: boolean }

export interface HistoryPort {
  preserveUrl: boolean
  remember(data: unknown, key: string): void
  restore(key: string): unknown
  getState<T>(key: keyof Page, defaultValue?: T): any
}

export interface PageScope {
  readonly page: typeof page
  readonly history: HistoryPort
  readonly router: Router
  reloadUrl(): string
  capture(visit: PendingVisit, previous?: Origin): Origin
  route(response: Response): Promise<void> | undefined
  readonly disposed: boolean
}

export const baseScope: PageScope = {
  get page() {
    return page
  },
  get history() {
    return history
  },
  get router() {
    return router
  },
  reloadUrl: () => window.location.href,
  capture: () => ({ kind: 'base', top: null, gen: 0, instantGen: null }),
  route: () => undefined,
  disposed: false,
}
