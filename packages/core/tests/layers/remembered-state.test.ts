import { describe, expect, it, vi, afterEach } from 'vitest'
import { openApp, byPath, exitShells, type App } from './support/app'
import { page, settled } from './support/browser'

const users = page('Users/Index', '/users', {
  props: { errors: {}, users: [] },
})

const editPage = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remembered state per layer', () => {
  const opened = async (options: Parameters<App['router']['visit']>[1] = {}) => {
    const app = await openApp(users, byPath({ '/users/5/edit': editPage, '/users': users }))

    app.router.visit('/users/5/edit', options)
    await settled()

    return { app, layer: app.router.layerHandle()! }
  }

  it("namespaces a layer's remember/restore under its id, leaving the page's bag alone", async () => {
    const { app, layer } = await opened()

    layer.router.remember('typed', 'note')
    await settled()

    expect(layer.router.restore('note')).toBe('typed')
    expect(app.router.restore('note')).toBeUndefined()
    expect(app.entry().layers![0].rememberedState).toEqual({ note: 'typed' })
    expect(app.entry().rememberedState).toEqual({})
    expect((await app.basePage()).rememberedState).toEqual({})
  })

  it('a remember/restore with no layer open keeps the top-level bag it always used', async () => {
    const app = await openApp(users, byPath({}))

    app.router.remember('typed', 'note')

    expect(app.router.restore('note')).toBe('typed')
    expect((await app.basePage()).rememberedState).toEqual({ note: 'typed' })
  })

  it("drops a closed layer's bag once its removal has settled", async () => {
    const { app, layer } = await opened({ preserveUrl: true })
    const id = layer.id

    layer.router.remember('typed', 'note')
    expect(layer.router.restore('note')).toBe('typed')

    const closing = layer.close()

    exitShells(app)
    await closing
    await settled()

    expect(app.router.layerHandle(id)).toBeUndefined()
    expect(app.layers()).toEqual([])
    expect((await app.basePage()).rememberedState).toEqual({})
    expect(app.router.restore('note')).toBeUndefined()
    expect(app.entry()).not.toHaveProperty('layers')
    expect(JSON.stringify(window.history.state)).not.toContain('typed')
  })

  it('holds a remember raised mid-unwind until the browser has answered the step back', async () => {
    const { app, layer } = await opened({ preserveUrl: true })
    const log: {
      kind: 'go' | 'replace' | 'push' | 'answered'
      state?: { page: { layers?: unknown[] } }
    }[] = []
    const { go, replaceState, pushState } = window.history

    window.history.go = (delta: number) => {
      log.push({ kind: 'go' })
      go.call(window.history, delta)
    }
    window.history.replaceState = (state: unknown, title: string, url: string) => {
      log.push({ kind: 'replace', state: state as never })
      replaceState.call(window.history, state, title, url)
    }
    window.history.pushState = (state: unknown, title: string, url: string) => {
      log.push({ kind: 'push', state: state as never })
      pushState.call(window.history, state, title, url)
    }
    window.addEventListener('popstate', () => log.push({ kind: 'answered' }))

    const closing = layer.close()

    exitShells(app)
    await vi.waitFor(() => expect(log.some((entry) => entry.kind === 'go')).toBe(true))
    app.router.remember('during', 'note')
    await closing
    await settled()

    const afterStepBack = log.slice(log.findIndex((entry) => entry.kind === 'go'))

    expect(log.filter((entry) => entry.kind === 'answered')).toHaveLength(1)
    expect(afterStepBack.flatMap((entry) => entry.state?.page.layers ?? [])).toEqual([])
    expect(app.router.restore('note')).toBe('during')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.entry().rememberedState).toEqual({ note: 'during' })
  })

  it("a restored page keeps the layer's bag, so reopening it finds the state", async () => {
    const { app, layer } = await opened()
    const id = layer.id

    layer.router.remember('typed', 'note')
    await settled()
    window.history.back()
    await settled()
    exitShells(app)
    await settled()
    expect(app.layers()).toEqual([])

    window.history.go(1)
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([id])
    expect(app.router.layerHandle(id)!.router.restore('note')).toBe('typed')
    expect(app.router.restore('note')).toBeUndefined()
  })
})

describe('remembering state on the server', () => {
  const withoutWindow = async (run: (history: { remember(data: unknown, key: string): void }) => void) => {
    vi.resetModules()

    const browser = globalThis.window

    // @ts-expect-error the server has none
    delete globalThis.window

    try {
      run((await import('../../../src/history')).history)
    } finally {
      globalThis.window = browser
    }
  }

  it('does nothing, since a render has no history to remember into', async () => {
    await withoutWindow((history) => expect(() => history.remember({ name: 'Joe' }, 'default')).not.toThrow())
  })
})
