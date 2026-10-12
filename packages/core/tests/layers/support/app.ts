import { vi } from 'vitest'
import type { HttpRequestConfig, HttpResponse, Page } from '../../../src/types'
import { fakeBrowser, memoryStorage, settled, type Answer } from './browser'

/** A request as the fake server saw it: the client's config, with the path and headers always present. */
export type Sent = HttpRequestConfig & { path: string; headers: Record<string, string> }

/** What a route answers: a page, a response the server did not render as a page, or `failure`. */
export type Reply = Answer | { raw: HttpResponse } | typeof failure
export type Route = Reply | ((request: Sent) => Reply | Promise<Reply>)
type Routes = Record<string, Route>
type Handler = (request: Sent) => Reply | Promise<Reply>

export const failure: Answer = { failure: true }

export const raw = (response: HttpResponse): { raw: HttpResponse } => ({ raw: response })

export interface AppOptions {
  /** The address the browser starts on. Defaults to the url of the initial page. */
  href?: string
  /** Imports the module the graph is entered through before the core is imported. */
  loadFirst?: () => Promise<unknown>
  /** Resolves a component name the way an adapter does. */
  resolveComponent?: (name: string, page?: Page) => unknown
  /** The loading resolver, called with the url of a base that is still blank. */
  loading?: (url: string, context: { layers: readonly unknown[] }) => unknown
  /** Opens the initial page the way a document does: planBoot, then the layers it arrives with. */
  boot?: boolean
  /** How the document was reached. */
  navigation?: 'navigate' | 'reload' | 'back_forward'
  /** A history entry the document was loaded onto. */
  entry?: unknown
  /** Runs once the core is imported, before the document boots. */
  onCore?: (core: typeof import('../../../src')) => void
  onFlash?: (flash: Page['flash']) => void
  /** Answers a request itself, or returns undefined to let the routes answer it. */
  intercept?: (config: HttpRequestConfig) => HttpResponse | Promise<HttpResponse | undefined> | undefined
  /** What a request to a url no route answers does. */
  unrouted?: 'throw' | 'network-error'
  /** What `swaps` records: the component name, or the resolved component with the page. */
  swapsAs?: 'name' | 'resolved'
}

/** Lets a route hold its answer until the test releases it. */
export function held() {
  let release: (answer: Answer) => void = () => {}
  const answer = new Promise<Answer>((resolve) => (release = resolve))

  return { answer: () => answer, release }
}

/** Opens a gate a route can wait on. */
export const gate = () => {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))

  return { opened, open }
}

/** Answers each request from a map of `METHOD path` or `path` to the page to send. */
export const byPath =
  (routes: Record<string, Reply | (() => Reply | Promise<Reply>)>): Handler =>
  (request) => {
    const route = routes[`${request.method} ${request.path}`] ?? routes[request.path]

    if (!route) {
      throw new Error(`No route for ${request.method} ${request.path}`)
    }

    return typeof route === 'function' ? route() : route
  }

/** Reports the exit of every shell that is closing, as the adapters' dialogs do. */
export const exitShells = (app: { views(): { shell: { open: boolean; done(): void } }[] }) =>
  app
    .views()
    .filter((view) => !view.shell.open)
    .forEach((view) => view.shell.done())

/**
 * A fresh core over a fake browser, with the real router, page store and stack, and a server that answers
 * each request from `routes`: a map of `METHOD path` or `path` to an answer or a function returning one,
 * or one function answering every request. A function route may hold its answer.
 */
export async function openApp(initial: Answer, routes: Routes | Handler, options: AppOptions = {}) {
  vi.resetModules()
  fakeBrowser(options.href ?? `http://localhost${initial.url}`)

  const popstates: ((event: { state: unknown }) => void)[] = []
  const addEventListener = window.addEventListener

  window.addEventListener = ((type: string, listener: (event: { state: unknown }) => void) => {
    if (type === 'popstate') {
      popstates.push(listener)
    }

    ;(addEventListener as (...args: unknown[]) => void)(type, listener)
  }) as typeof window.addEventListener
  Object.assign(window, {
    sessionStorage: memoryStorage(),
    crypto: globalThis.crypto,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    innerHeight: 800,
    innerWidth: 800,
    performance: { getEntriesByType: () => [{ type: options.navigation ?? 'navigate' }] },
  })

  if (options.entry !== undefined) {
    window.history.state = { page: options.entry }
  }

  await options.loadFirst?.()

  const core = await import('../../../src')

  options.onCore?.(core)

  const { HttpCancelledError, HttpNetworkError } = await import('../../../src/httpErrors')
  const sent: string[] = []
  const requests: Sent[] = []
  const loadingFor: string[] = []
  const swaps: { component: unknown; preserveState?: boolean; page?: Page }[] = []

  const answered = (answer: Reply): HttpResponse => {
    if (typeof answer === 'object' && 'raw' in answer) {
      return answer.raw as HttpResponse
    }

    return answer === failure
      ? { status: 500, headers: {}, data: 'Server Error' }
      : { status: 200, headers: { 'x-inertia': 'true' }, data: JSON.stringify(answer) }
  }

  const answer = (config: HttpRequestConfig, request: Sent): Promise<HttpResponse> => {
    const route =
      typeof routes === 'function' ? routes : (routes[`${config.method} ${request.path}`] ?? routes[request.path])

    if (!route) {
      if (options.unrouted === 'network-error') {
        return Promise.reject(new HttpNetworkError('No route'))
      }

      throw new Error(`No route for ${config.method} ${request.path}`)
    }

    if (typeof route !== 'function') {
      return Promise.resolve(answered(route))
    }

    return new Promise((resolve, reject) => {
      config.signal?.addEventListener('abort', () => reject(new HttpCancelledError()))
      Promise.resolve(route(request)).then((reply) => resolve(answered(reply)), reject)
    })
  }

  core.http.setClient({
    request: (config: HttpRequestConfig): Promise<HttpResponse> => {
      const url = new URL(config.url, 'http://localhost')
      const request: Sent = {
        ...config,
        path: url.pathname + url.search,
        headers: (config.headers ?? {}) as Record<string, string>,
      }

      requests.push(request)
      sent.push(`${config.method} ${request.path}`)

      if (!options.intercept) {
        return answer(config, request)
      }

      return Promise.resolve(options.intercept(config)).then((response) => response ?? answer(config, request))
    },
  })

  const initialPage = { flash: {}, rescuedProps: [], rememberedState: {}, ...initial } as Page
  const resolve = options.resolveComponent ?? ((name: string) => ({ name }))
  const resolver = core.layerSlot.wrapResolver(
    resolve as never,
    ((url: string, context: { layers: readonly unknown[] }) => {
      loadingFor.push(url)

      return options.loading?.(url, context)
    }) as never,
    { name: 'Blank' } as never,
  ) as never
  const swapComponent = async ({
    component,
    preserveState,
    page,
  }: {
    component: unknown
    preserveState: boolean
    page: Page
  }) => {
    swaps.push(
      options.swapsAs === 'resolved'
        ? { component, page }
        : { component: (component as { name: string }).name, preserveState },
    )
  }

  const flash = options.onFlash ? { onFlash: options.onFlash } : {}

  if (options.boot) {
    const plan = core.layerSlot.planBoot(initialPage, window.location.hash)

    core.layerSlot.boot(
      plan,
      await Promise.all(
        plan.layers.map(({ page: layer }) =>
          (resolver as unknown as (...args: unknown[]) => unknown)(layer.component, layer, plan.info),
        ),
      ),
    )
    core.router.init({
      initialPage: plan.base,
      resolveComponent: resolver,
      swapComponent: swapComponent as never,
      ...flash,
    })
  } else {
    core.router.init({ initialPage, resolveComponent: resolver, swapComponent: swapComponent as never, ...flash })
  }

  await settled()

  const fired: CustomEvent[] = []

  document.dispatchEvent = (event: Event) => {
    fired.push(event as CustomEvent)

    return true
  }

  const modules = {
    history: (await import('../../../src/history')).history,
    currentPage: (await import('../../../src/page')).page,
    prefetchedRequests: (await import('../../../src/prefetched')).prefetchedRequests,
    stack: (await import('../../../src/layers/stack')).stack,
    historySessionStorageKeys: (await import('../../../src/encryption')).historySessionStorageKeys,
  }
  const written = () => (window.history as unknown as { written: [string, string][] }).written
  const views = () => core.layerSlot.views()

  return {
    ...modules,
    core,
    router: core.router,
    interceptors: core.interceptors,
    layerSlot: core.layerSlot,
    Router: (await import('../../../src/router')).Router,
    current: modules.currentPage,
    sent,
    requests,
    swaps,
    fired,
    loadingFor,
    written,
    layers: () => core.layerSlot.info(),
    views,
    subscribe: core.layerSlot.subscribe,
    topPage: () => core.layerSlot.topPage(),
    basePage: async () => (await import('../../../src/page')).page.get(),
    resolve: (name: string, page?: Page) => modules.currentPage.resolve(name, page),
    entry: () => (window.history.state as { page: Page & { layers?: Record<string, any>[] } }).page,
    rawEntry: () => (window.history.state as { page: unknown }).page,
    modules: async () => ({
      page: modules.currentPage,
      history: modules.history,
      eventHandler: (await import('../../../src/eventHandler')).eventHandler,
      prefetchedRequests: modules.prefetchedRequests,
    }),
    paths: () => requests.map((request) => request.path),
    popstate: (state: unknown) => popstates.forEach((listener) => listener({ state })),
    anchor: async (path: string) => {
      window.history.pushState(null, '', path)
      popstates.forEach((listener) => listener({ state: null }))
      await settled()
    },
    go: () => {
      const calls: number[] = []
      const original = window.history.go.bind(window.history)

      window.history.go = (delta: number) => {
        calls.push(delta)
        original(delta)
      }

      return calls
    },
    exitShells: () => exitShells({ views }),
    closing: async (handle: { close(): Promise<void> }) => {
      const closing = handle.close()

      await settled()
      exitShells({ views })
      await settled()

      return closing
    },
    close: async (id?: string) => {
      const closing = core.router.close(id)

      await settled()
      exitShells({ views })

      return closing
    },
  }
}

export type App = Awaited<ReturnType<typeof openApp>>

/** The same app, with `sent` a function returning what was sent, for the tests that read it as a call. */
export async function openAppSentCall(initial: Answer, routes: Routes | Handler, options: AppOptions = {}) {
  const app = await openApp(initial, routes, options)

  return { ...app, sent: () => app.sent.slice() }
}

export type SentCallApp = Awaited<ReturnType<typeof openAppSentCall>>

/** The same app, with `basePage` returning the page itself instead of a promise of it. */
export async function openAppSync(initial: Answer, routes: Routes | Handler, options: AppOptions = {}) {
  const app = await openApp(initial, routes, options)

  return { ...app, basePage: () => app.current.get() }
}

export type SyncApp = Awaited<ReturnType<typeof openAppSync>>
