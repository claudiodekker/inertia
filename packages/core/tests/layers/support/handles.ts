import type { HttpResponse } from '../../../src/types'
import type { App } from './app'
import { settled } from './browser'

/**
 * A layer that lands cold: a visit that shows a placeholder page at once is answered by a layer, which
 * cannot stand on the placeholder. Returns the layer's scope.
 */
export async function openCold(app: App, url = 'http://localhost/users/5/edit') {
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
