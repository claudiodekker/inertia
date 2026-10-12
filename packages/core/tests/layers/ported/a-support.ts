import { vi } from 'vitest'
import type { HttpRequestConfig, HttpResponse, Page } from '../../../src/types'
import { fakeBrowser, settled } from '../runtime'

export { page, settled } from '../runtime'

export type Answer = Partial<Page> & Record<string, unknown>
export type Sent = { method: string; path: string; headers: Record<string, string>; data: unknown }
export type Route = Answer | ((request: Sent) => Answer | Promise<Answer>) | { raw: HttpResponse }

export const raw = (response: HttpResponse): { raw: HttpResponse } => ({ raw: response })

/** A route answer the test releases by hand. */
export function held() {
  let release: (answer: Answer) => void = () => {}
  const answer = new Promise<Answer>((resolve) => (release = resolve))

  return { answer: () => answer, release }
}

/**
 * Like runtime(), but records every request in full and lets a route answer from the request it got.
 */
export async function scenario(initial: Answer, routes: Record<string, Route>) {
  vi.resetModules()
  fakeBrowser(`http://localhost${initial.url}`)

  const core = await import('../../../src')
  const { HttpCancelledError } = await import('../../../src/httpErrors')
  const requests: Sent[] = []

  core.http.setClient({
    request: (config: HttpRequestConfig): Promise<HttpResponse> => {
      const url = new URL(config.url, 'http://localhost')
      const path = url.pathname + url.search
      const route = routes[`${config.method} ${path}`] ?? routes[path]
      const request: Sent = {
        method: config.method,
        path,
        headers: (config.headers ?? {}) as Record<string, string>,
        data: config.data,
      }

      requests.push(request)

      if (!route) {
        throw new Error(`No route for ${config.method} ${path}`)
      }

      const answered = (answer: Answer): HttpResponse => ({
        status: 200,
        headers: { 'x-inertia': 'true' },
        data: JSON.stringify(answer),
      })

      if (typeof route === 'object' && 'raw' in route) {
        return Promise.resolve(route.raw)
      }

      if (typeof route !== 'function') {
        return Promise.resolve(answered(route))
      }

      return new Promise((resolve, reject) => {
        config.signal?.addEventListener('abort', () => reject(new HttpCancelledError()))
        Promise.resolve(route(request)).then((answer) => resolve(answered(answer)), reject)
      })
    },
  })

  core.router.init({
    initialPage: { flash: {}, rescuedProps: [], rememberedState: {}, ...initial } as Page,
    resolveComponent: (name: string) => ({ name }),
    swapComponent: async () => {},
  })

  await settled()

  return {
    router: core.router,
    layers: () => core.layerSlot.info(),
    views: () => core.layerSlot.views(),
    basePage: async () => (await import('../../../src/page')).page.get(),
    requests,
    sent: () => requests.map((request) => `${request.method} ${request.path}`),
    written: () => (window.history as unknown as { written: [string, string][] }).written,
    entry: () => (window.history.state as { page: Page & { layers?: Record<string, unknown>[] } }).page,
    core,
  }
}

export type App = Awaited<ReturnType<typeof scenario>>

/** Reports the exit of every shell that is closing, as the adapters' dialogs do. */
export const exitShells = (app: App) =>
  app
    .views()
    .filter((view) => !view.shell.open)
    .forEach((view) => view.shell.done())
