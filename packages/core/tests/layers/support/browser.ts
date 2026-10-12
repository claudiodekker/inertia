import type { Page } from '../../../src/types'

export type Answer = Partial<Page> & Record<string, unknown>

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

/** Lets every queued request, commit and paint finish. */
export async function settled(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

export function memoryStorage() {
  const items = new Map<string, string>()

  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  }
}
