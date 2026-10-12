import type { HttpRequestConfig, HttpResponse, Page } from '../../../src/types'
import { page, runtime, settled } from './runtime'

export { page, settled }

type Answer = Parameters<typeof runtime>[0]
type Routes = Parameters<typeof runtime>[1]
type Raw = (config: HttpRequestConfig) => Promise<HttpResponse> | HttpResponse | undefined

export const base = (extra: Partial<Page> = {}): Answer =>
  page('Users/Index', '/users', { props: { users: [], errors: {} }, ...extra })

export const edit = (extra: Record<string, unknown> = {}): Answer =>
  page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit', base: '/users' },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  })

export const notes = (extra: Record<string, unknown> = {}): Answer =>
  page('Users/Notes', '/users/5/notes', {
    layer: { key: 'Users/Notes', base: '/users' },
    props: { errors: {} },
    ...extra,
  })

/** The runtime of the layers tests, recording every request sent and letting a test answer with a raw response. */
export async function ported(initial: Answer, routes: Routes, raw: Raw = () => undefined) {
  const app = await runtime(initial, routes)
  const session = new Map<string, string>()

  Object.assign(window, {
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
      clear: () => session.clear(),
    },
  })

  const core = await import('../../../src')
  const current = (await import('../../../src/page')).page
  const inner = core.http.getClient()
  const requests: HttpRequestConfig[] = []

  core.http.setClient({
    request: (config: HttpRequestConfig) => {
      requests.push(config)

      return Promise.resolve(raw(config)).then((response) => response ?? inner.request(config))
    },
  })

  return {
    ...app,
    core,
    current,
    requests,
    paths: () =>
      requests.map((config) => new URL(config.url, 'http://localhost')).map((url) => url.pathname + url.search),
    go: () => {
      const calls: number[] = []
      const original = window.history.go.bind(window.history)

      window.history.go = (delta: number) => {
        calls.push(delta)
        original(delta)
      }

      return calls
    },
    exitShells: () =>
      app
        .views()
        .filter((view) => !view.shell.open)
        .forEach((view) => view.shell.done()),
    closing: async (handle: { close(): Promise<void> }) => {
      const closing = handle.close()

      await settled()
      app
        .views()
        .filter((view) => !view.shell.open)
        .forEach((view) => view.shell.done())
      await settled()

      return closing
    },
    close: async (id?: string) => {
      const closing = app.router.close(id)

      await settled()
      app
        .views()
        .filter((view) => !view.shell.open)
        .forEach((view) => view.shell.done())

      return closing
    },
  }
}

/**
 * A layer that lands cold: a visit that shows a placeholder page at once is answered by a layer, which
 * cannot stand on the placeholder. Returns the layer's scope.
 */
export async function openCold(app: Awaited<ReturnType<typeof ported>>, url = 'http://localhost/users/5/edit') {
  app.router.visit(url, { component: 'Users/Loading' })
  await settled()

  return app.router.layerHandle(app.layers()[0].id)!
}

export const counted = (handle: { onClose(listener: () => void): unknown }) => {
  const calls = { closed: 0 }

  handle.onClose(() => calls.closed++)

  return calls
}

export const rawResponse = (
  status: number,
  data: unknown = '',
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  data: typeof data === 'string' ? data : JSON.stringify(data),
  headers,
})

export const layerAt = (component: string, url: string, extra: Record<string, unknown> = {}) =>
  page(component, url, { layer: { key: component, base: '/users' }, props: { errors: {} }, ...extra })

/** The browser keeps the step back until the test answers it. */
export function holdBack() {
  const original = window.history.go.bind(window.history)
  const held: number[] = []

  window.history.go = (delta: number) => {
    held.push(delta)
  }

  return {
    held,
    answer: () => {
      window.history.go = original
      held.forEach((delta) => original(delta))
    },
  }
}

export const veto = (type: string) => {
  document.dispatchEvent = (event: Event) => event.type !== type

  return () => {
    document.dispatchEvent = () => true
  }
}
