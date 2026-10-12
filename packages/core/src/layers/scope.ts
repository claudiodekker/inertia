import { router } from '..'
import { history } from '../history'
import { page, type CurrentPage } from '../page'
import type { Response } from '../response'
import type { Router } from '../router'
import type { Page, PendingVisit } from '../types'
import { stack } from './stack'
import type { Origin } from './state'

export type { Origin }

export interface HistoryPort {
  preserveUrl: boolean
  remember(data: unknown, key: string): void
  restore(key: string): unknown
  getState<T>(key: keyof Page, defaultValue?: T): any
}

export interface PageScope {
  readonly page: CurrentPage
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
  reloadUrl: () => stack.baseReloadUrl() ?? window.location.href,
  capture: (visit, previous) => stack.captureBase(visit, previous),
  route: (response) => stack.route(response),
  disposed: false,
}
