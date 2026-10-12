import { vi } from 'vitest'
import type { HttpRequestConfig, HttpResponse, Page } from '../../../src/types'
import { fakeBrowser, settled } from './runtime'

export { page, settled } from './runtime'

type Answer = Partial<Page> & Record<string, unknown>

export const failure: Answer = { failure: true }
type Routes = Record<string, Answer | ((config: HttpRequestConfig) => Promise<Answer>)>

interface Options {
  boot?: boolean
  resolveComponent?: (name: string, page?: Page) => unknown
  loading?: (url: string, context: { layers: readonly unknown[] }) => unknown
  href?: string
}

export async function ported(initial: Answer, routes: Routes, options: Options = {}) {
  vi.resetModules()
  fakeBrowser(options.href ?? `http://localhost${initial.url}`)

  const store = new Map<string, string>()

  Object.assign(globalThis.window, {
    crypto: globalThis.crypto,
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  })

  const popstates: ((event: { state: unknown }) => void)[] = []
  const addListener = window.addEventListener

  window.addEventListener = ((type: string, listener: (event: { state: unknown }) => void) => {
    if (type === 'popstate') {
      popstates.push(listener)
    }

    addListener(type, listener as never)
  }) as never

  const core = await import('../../../src')
  const { HttpCancelledError, HttpNetworkError } = await import('../../../src/httpErrors')
  const sent: string[] = []
  const swaps: { component: unknown; page: Page }[] = []
  const swap = async ({ component, page }: { component: unknown; page: Page }) => void swaps.push({ component, page })

  core.http.setClient({
    request: (config: HttpRequestConfig): Promise<HttpResponse> => {
      const url = new URL(config.url, 'http://localhost')
      const path = url.pathname + url.search
      const route = routes[`${config.method} ${path}`] ?? routes[path]

      sent.push(`${config.method} ${path}`)

      if (!route) {
        return Promise.reject(new HttpNetworkError('No route'))
      }

      const answered = (answer: Answer): HttpResponse =>
        answer === failure
          ? { status: 500, headers: {}, data: 'Server Error' }
          : { status: 200, headers: { 'x-inertia': 'true' }, data: JSON.stringify(answer) }

      if (typeof route !== 'function') {
        return Promise.resolve(answered(route))
      }

      return new Promise((resolve, reject) => {
        config.signal?.addEventListener('abort', () => reject(new HttpCancelledError()))
        route(config).then((answer) => resolve(answered(answer)), reject)
      })
    },
  })

  const response = { flash: {}, rescuedProps: [], rememberedState: {}, ...initial } as Page
  const resolve = options.resolveComponent ?? ((name: string) => ({ name }))
  const wrapped = core.layerSlot.wrapResolver(
    resolve as never,
    options.loading as never,
    { name: 'Blank' } as never,
  ) as never

  if (options.boot) {
    const plan = core.layerSlot.planBoot(response, window.location.hash)

    core.layerSlot.boot(
      plan,
      await Promise.all(plan.layers.map(({ page: layer }) => wrapped(layer.component, layer, plan.info))),
    )
    core.router.init({ initialPage: plan.base, resolveComponent: wrapped, swapComponent: swap as never })
  } else {
    core.router.init({ initialPage: response, resolveComponent: wrapped, swapComponent: swap as never })
  }

  await settled()

  return {
    core,
    router: core.router,
    layers: () => core.layerSlot.info(),
    views: () => core.layerSlot.views(),
    anchor: async (path: string) => {
      window.history.pushState(null, '', path)
      popstates.forEach((listener) => listener({ state: null }))
      await settled()
    },
    resolve: async (name: string, page?: Page) => (await import('../../../src/page')).page.resolve(name, page),
    basePage: async () => (await import('../../../src/page')).page.get(),
    sent,
    swaps,
    written: () => (window.history as unknown as { written: [string, string][] }).written,
    entry: () => (window.history.state as { page: Page & { layers?: Record<string, any>[] } }).page,
    rawEntry: () => (window.history.state as { page: unknown }).page,
    exitShells: () =>
      core.layerSlot
        .views()
        .filter((view) => !view.shell.open)
        .forEach((view) => view.shell.done()),
  }
}
