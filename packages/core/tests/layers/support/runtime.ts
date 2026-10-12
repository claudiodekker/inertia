import { vi } from 'vitest'
import type { HttpRequestConfig, HttpResponse, Page } from '../../../src/types'

type Answer = Partial<Page> & Record<string, unknown>

export const page = (component: string, url: string, extra: Answer = {}): Answer => ({
  component,
  url,
  props: { errors: {} },
  version: 'v1',
  ...extra,
})

/** The window the runtime needs: an address and a session history that record what was written. */
export function fakeBrowser(href: string): void {
  const location = new URL(href)
  const listeners: ((event: { state: unknown }) => void)[] = []
  const entries: { state: unknown; url: string }[] = [{ state: null, url: location.href }]
  let index = 0
  const show = (state: unknown, url: string) => {
    history.state = state
    location.href = new URL(url, location.href).href
    entries[index] = { state, url: location.href }
  }
  const history = {
    state: null as unknown,
    written: [] as [mode: 'push' | 'replace', url: string][],
    scrollRestoration: 'auto',
    pushState(state: unknown, _title: string, url: string) {
      entries.length = ++index
      history.written.push(['push', url])
      show(state, url)
    },
    replaceState(state: unknown, _title: string, url: string) {
      history.written.push(['replace', url])
      show(state, url)
    },
    go(delta: number) {
      setTimeout(() => {
        index += delta
        show(entries[index].state, entries[index].url)
        listeners.forEach((listener) => listener({ state: history.state }))
      }, 0)
    },
    back: () => history.go(-1),
  }

  globalThis.window = {
    location,
    history,
    navigator: { userAgent: 'node' },
    addEventListener: (type: string, listener: (event: { state: unknown }) => void) => {
      if (type === 'popstate') {
        listeners.push(listener)
      }
    },
    removeEventListener: () => {},
    scrollTo: () => {},
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  } as unknown as Window & typeof globalThis

  globalThis.document = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    visibilityState: 'visible',
  } as unknown as Document
}

/**
 * A fresh core over `initial`, with the real router, page store and stack, and a server that answers
 * each url from `routes`. A route that is a function may hold its answer. `loadFirst` imports the module
 * the graph is entered through.
 */
export async function runtime(
  initial: Answer,
  routes: Record<string, Answer | (() => Promise<Answer>)>,
  loadFirst: () => Promise<unknown> = () => import('../../../src'),
) {
  vi.resetModules()
  fakeBrowser(`http://localhost${initial.url}`)

  await loadFirst()

  const core = await import('../../../src')
  const { HttpCancelledError } = await import('../../../src/httpErrors')
  const sent: string[] = []

  core.http.setClient({
    request: (config: HttpRequestConfig): Promise<HttpResponse> => {
      const url = new URL(config.url, 'http://localhost')
      const path = url.pathname + url.search
      const route = routes[`${config.method} ${path}`] ?? routes[path]

      sent.push(`${config.method} ${path}`)

      if (!route) {
        throw new Error(`No route for ${config.method} ${path}`)
      }

      const answered = (answer: Answer): HttpResponse => ({
        status: 200,
        headers: { 'x-inertia': 'true' },
        data: JSON.stringify(answer),
      })

      if (typeof route !== 'function') {
        return Promise.resolve(answered(route))
      }

      return new Promise((resolve, reject) => {
        config.signal?.addEventListener('abort', () => reject(new HttpCancelledError()))
        route().then((answer) => resolve(answered(answer)), reject)
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
    sent,
    written: () => (window.history as unknown as { written: [string, string][] }).written,
    entry: () => (window.history.state as { page: Page & { layers?: unknown[] } }).page,
  }
}

/** Lets every queued request, commit and paint finish. */
export async function settled(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Reports the exit of every shell that is closing, as the adapters' dialogs do. */
export const exitShells = (app: { views(): { shell: { open: boolean; done(): void } }[] }) =>
  app
    .views()
    .filter((view) => !view.shell.open)
    .forEach((view) => view.shell.done())
