import { describe, expect, it, vi, afterEach } from 'vitest'
import { openApp, byPath, exitShells, gate, type App, openAppSync } from './support/app'
import { page, settled } from './support/browser'

const users = page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const editPage = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

const partialOf = (app: App) =>
  app.requests.filter((request) => request.headers['X-Inertia-Partial-Data'] !== undefined)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a layer's deferred and rescued props", () => {
  it('drops what a layer was owing when the write that lands has closed it', async () => {
    const resolving = gate()
    const app = await openApp(users, byPath({ '/users/5/edit': { ...editPage, deferredProps: { slow: ['stats'] } } }), {
      resolveComponent: (name) => (name === 'Users/Edit' ? resolving.opened.then(() => ({ name })) : { name }),
    })

    app.router.visit('/users/5/edit')
    await settled()
    app.router.push({ component: 'Teams/Index', url: '/teams', props: {} })
    await settled()
    resolving.open()
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect(partialOf(app)).toEqual([])
    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/edit'])
  })
})

describe("a layer's deferred and rescued props", () => {
  it('loads the deferred props a layer response declared into the layer', async () => {
    let opens = 0
    const app = await openApp(users, (request) => {
      if (request.headers['X-Inertia-Partial-Data'] === undefined && opens++ === 0) {
        return {
          ...editPage,
          deferredProps: { slow: ['stats'] },
          rescuedProps: ['stats'],
        }
      }

      return {
        ...editPage,
        props: { errors: {}, user: { id: 5 }, stats: [1, 2, 3] },
        rescuedProps: [],
      }
    })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/edit', '/users/5/edit'])
    expect(app.requests[1].headers['X-Inertia-Partial-Component']).toBe('Users/Edit')
    expect(app.requests[1].headers['X-Inertia-Partial-Data']).toBe('stats')
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1, 2, 3],
    })
    expect(app.views()[0].page.rescuedProps).toEqual([])
    expect((await app.basePage()).props).toEqual({ errors: {}, users: [] })
  })

  it('aims the deferred follow-up at a layer that preserved the url, not at the page', async () => {
    const app = await openApp(users, (request) =>
      request.headers['X-Inertia-Partial-Data']?.includes('stats')
        ? { ...editPage, props: { errors: {}, user: { id: 5 }, stats: [1] } }
        : { ...editPage, deferredProps: { slow: ['stats'] } },
    )

    app.router.visit('/users/5/edit', { preserveUrl: true })
    await settled()

    expect(app.entry().layers![0]).toMatchObject({
      component: 'Users/Edit',
      preservesUrl: true,
    })
    expect(window.location.pathname).toBe('/users')
    expect(
      partialOf(app).map((request) => ({
        url: request.path,
        component: request.headers['X-Inertia-Partial-Component'],
      })),
    ).toEqual([{ url: '/users/5/edit', component: 'Users/Edit' }])
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1],
    })
    expect((await app.basePage()).props).toEqual({ errors: {}, users: [] })
  })

  it("does not re-fire the page's pending deferred props when a layer opens over it", async () => {
    const app = await openApp(users, (request) => {
      if (request.headers['X-Inertia-Partial-Data']?.includes('stats')) {
        return new Promise(() => {})
      }

      return request.path === '/users/5/edit'
        ? {
            ...editPage,
            deferredProps: { slow: ['stats'] },
            rescuedProps: ['stats'],
          }
        : { ...users, deferredProps: { slow: ['stats'] } }
    })

    app.router.visit('/users')
    await settled()
    expect(partialOf(app).map((request) => request.path)).toEqual(['/users'])

    app.router.visit('/users/5/edit')
    await settled()

    expect(partialOf(app).map((request) => request.path)).toEqual(['/users', '/users/5/edit'])
  })

  it('rescued props travel with the layer and resolve into its props', async () => {
    const follow = gate()
    const app = await openApp(users, (request) =>
      request.headers['X-Inertia-Partial-Data'] === undefined
        ? {
            ...editPage,
            deferredProps: { slow: ['stats'] },
            rescuedProps: ['stats', 'notes'],
          }
        : follow.opened.then(() => ({
            ...editPage,
            props: { errors: {}, user: { id: 5 }, stats: [1, 2, 3] },
            rescuedProps: [],
          })),
    )

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.rescuedProps).toEqual(['stats', 'notes'])
    expect(app.entry().layers![0].rescuedProps).toEqual(['stats', 'notes'])
    expect(partialOf(app)).toHaveLength(1)

    follow.open()
    await settled()

    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1, 2, 3],
    })
    expect(app.views()[0].page.rescuedProps).toEqual(['notes'])
    expect((await app.basePage()).props).toEqual({ errors: {}, users: [] })
  })

  it("re-asks for the deferred props a restored entry's layer is still missing", async () => {
    const app = await openApp(
      {
        ...users,
        props: { errors: {}, users: [], sidebar: ['loaded'] },
        deferredProps: { slow: ['sidebar'] },
      },
      (request) =>
        request.headers['X-Inertia-Partial-Data'] === undefined
          ? { ...editPage, deferredProps: { slow: ['stats'] } }
          : new Promise(() => {}),
    )
    const initial = app.requests.length

    app.router.visit('/users/5/edit')
    await settled()
    window.history.back()
    await settled()
    exitShells(app)
    await settled()
    expect(app.layers()).toEqual([])

    window.history.go(1)
    await settled()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit'])
    expect(
      app.requests
        .slice(initial)
        .map((request) => [request.headers['X-Inertia-Partial-Data'], request.headers['X-Inertia-Partial-Component']]),
    ).toEqual([
      [undefined, undefined],
      ['stats', 'Users/Edit'],
      ['stats', 'Users/Edit'],
    ])
  })
})

describe('the deferred props a page write was carrying', () => {
  const full = (overrides: Record<string, unknown> = {}) => ({
    ...users,
    flash: {},
    rescuedProps: [],
    rememberedState: {},
    ...overrides,
  })

  const listening = async (handle: Parameters<typeof openApp>[1]) => {
    const app = await openApp(users, handle)
    const { page: base, eventHandler } = await app.modules()
    const groups: unknown[] = []
    const stop = eventHandler.on('loadDeferredProps', (deferredProps: unknown) => groups.push(deferredProps))

    return { app, base, groups, stop }
  }

  it('are announced by the write that lands when a newer one supersedes it', async () => {
    const { base, groups, stop } = await listening(() => new Promise(() => {}))

    base.set(full({ deferredProps: { default: ['stats'] } }) as never)
    await base.set(full({ props: { errors: {}, users: [], stats: [] } }) as never)

    stop()

    expect(groups).toEqual([{ default: ['stats'] }])
  })

  it('are dropped when the write that lands is on another page entirely', async () => {
    const { base, groups, stop } = await listening(() => new Promise(() => {}))

    base.set(full({ deferredProps: { default: ['stats'] } }) as never)
    await base.set(full({ component: 'Teams/Index', url: '/teams' }) as never)

    stop()

    expect(groups).toEqual([])
  })

  it('are announced again by a cached prefetch replayed onto the page a second time', async () => {
    const deferred = page('Users/Show', '/users/5', {
      deferredProps: { default: ['stats'] },
    })
    let fetched = 0
    const { app, groups, stop } = await listening((request) => {
      if (request.headers['X-Inertia-Partial-Data'] !== undefined) {
        return new Promise(() => {})
      }

      fetched++

      return request.path === '/users/5' ? deferred : users
    })

    app.router.prefetch('/users/5', {}, { cacheFor: '30s' })
    await vi.waitFor(() => expect(fetched).toBe(1))

    const visit = (url: string) =>
      new Promise<void>((resolve) =>
        app.router.visit(url, {
          onSuccess: () => resolve(),
          onError: () => resolve(),
        }),
      )

    await visit('/users/5')
    await visit('/users')
    await visit('/users/5')

    stop()
    ;(await app.modules()).prefetchedRequests.removeAll()

    expect(groups).toEqual([{ default: ['stats'] }, { default: ['stats'] }])
  })

  it('are left alone by a write that carries them along for another tier', async () => {
    const { app, base, groups, stop } = await listening((request) =>
      request.headers['X-Inertia-Partial-Data'] !== undefined ? new Promise(() => {}) : editPage,
    )

    await base.set(full({ deferredProps: { default: ['stats'] } }) as never)
    app.router.visit('/users/5/edit')
    await settled()

    stop()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit'])
    expect(groups).toEqual([{ default: ['stats'] }])
  })
})

describe('partialReloadFillsDeferred', () => {
  const edit = page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit', base: '/users' },
    props: { errors: {}, user: { id: 5 } },
  })
  const withStats = { props: { errors: {}, stats: 3 } }

  type App = Awaited<ReturnType<typeof openAppSync>>

  const startedOf = (app: App) => app.fired.findLast((event) => event.type === 'inertia:start')!.detail.visit

  it('matches a base reload against the base url while a layer owns the address', async () => {
    const app = await openAppSync(page('Users/Index', '/users'), {
      '/users/5/edit': edit,
      '/users': { ...page('Users/Index', '/users'), ...withStats },
    })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    const layer = app.router.layerHandle(handle.id)!

    app.router.reload({ only: ['stats'] })
    await settled()

    const reload = startedOf(app)

    expect(app.sent).toEqual(['get /users/5/edit', 'get /users'])
    expect(app.basePage().props).toEqual({ errors: {}, stats: 3 })
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 5 } })
    expect(reload.url.pathname).toBe('/users')
    expect(window.location.pathname).toBe('/users/5/edit')
    expect(app.layerSlot.fillsDeferred(reload, null, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(reload, layer, ['stats'])).toBe(false)

    layer.router.reload({ only: ['stats'] })
    await settled()

    expect(app.layerSlot.fillsDeferred(startedOf(app), null, ['stats'])).toBe(false)
  })

  it('matches a base reload against the address when no layer is open', async () => {
    const app = await openAppSync(page('Users/Index', '/users'), {
      '/users': { ...page('Users/Index', '/users'), ...withStats },
    })

    app.router.reload({ only: ['stats'] })
    await settled()

    const reload = startedOf(app)

    expect(app.sent).toEqual(['get /users'])
    expect(reload.url.href).toBe(window.location.href)
    expect(app.layerSlot.fillsDeferred(reload, null, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(reload, null, ['other'])).toBe(false)
  })

  it('matches a layer reload against the layer url, on that layer only', async () => {
    const app = await openAppSync(page('Users/Index', '/users'), {
      '/users/5/edit': () => Promise.resolve(app.sent.length > 1 ? { ...edit, ...withStats } : edit),
    })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    const layer = app.router.layerHandle(handle.id)!

    layer.router.reload({ only: ['stats'] })
    await settled()

    const reload = startedOf(app)

    expect(app.sent).toEqual(['get /users/5/edit', 'get /users/5/edit'])
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: 3,
    })
    expect(app.basePage().props).toEqual({ errors: {} })
    expect(app.layerSlot.fillsDeferred(reload, layer, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(reload, null, ['stats'])).toBe(false)
    expect(app.layerSlot.fillsDeferred(reload, layer, ['other'])).toBe(false)
  })

  it('tells a layer and the page apart when both sit on the same path', async () => {
    const picker = page('Users/Pick', '/users?pick=1', {
      layer: { key: 'Users/Pick', base: '/users' },
      props: { errors: {} },
    })
    const app = await openAppSync(page('Users/Index', '/users'), {
      '/users?pick=1': picker,
      '/users': page('Users/Index', '/users'),
    })
    const handle = app.router.layer('/users?pick=1')

    await settled()

    const layer = app.router.layerHandle(handle.id)!

    layer.router.reload({ only: ['stats'] })
    await settled()

    const ofTheLayer = startedOf(app)

    app.router.reload({ only: ['stats'] })
    await settled()

    const ofThePage = startedOf(app)

    expect(app.sent).toEqual(['get /users?pick=1', 'get /users?pick=1', 'get /users'])
    expect(app.layerSlot.fillsDeferred(ofTheLayer, layer, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(ofTheLayer, null, ['stats'])).toBe(false)
    expect(app.layerSlot.fillsDeferred(ofThePage, null, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(ofThePage, layer, ['stats'])).toBe(false)
  })
})
