import type { App } from './app'

export const storeKeys = (app: App) => {
  window.sessionStorage.setItem(app.historySessionStorageKeys.key, '[1,2,3]')
  window.sessionStorage.setItem(app.historySessionStorageKeys.iv, '[4,5,6]')
}

export const keysHeld = (app: App) => window.sessionStorage.getItem(app.historySessionStorageKeys.key) !== null

export const baseGen = (app: App): number =>
  (app.stack as unknown as { state: { base: { gen: number } } }).state.base.gen

export const requestsOf = (router: unknown): { origin: unknown }[] =>
  (router as { syncRequestStream: { requests: { origin: unknown }[] } }).syncRequestStream.requests

export const cached = (app: App) =>
  (
    app.prefetchedRequests as unknown as {
      cached: { response: Promise<{ origin: unknown }> }[]
    }
  ).cached
