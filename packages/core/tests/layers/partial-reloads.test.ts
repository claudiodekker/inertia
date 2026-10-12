import { describe, expect, it } from 'vitest'
import { held, openAppSentCall, type SentCallApp, type Route, openApp, byPath, gate } from './support/app'
import { settled, type Answer, page } from './support/browser'

const usersAnswer = (overrides: Answer = {}): Answer => ({
  component: 'Users/Index',
  url: '/users',
  props: { users: [] },
  version: null,
  ...overrides,
})

const editLayerProps = (props: Record<string, unknown>): Answer =>
  usersAnswer({
    component: 'Users/Edit',
    url: '/users/5/edit',
    layer: { key: 'Users/Edit', base: '/users' },
    props,
  })

const visited = (app: SentCallApp, url: string, options: Record<string, unknown> = {}): Promise<void> =>
  new Promise((resolve) => {
    app.router.visit(url, {
      ...options,
      onSuccess: () => resolve(),
      onError: () => resolve(),
    } as never)
  })

const usersAt = (url = '/users') => page('Users/Index', url, { props: { errors: {}, users: [] } })

const pw = (overrides: Answer = {}): Answer => ({
  component: 'Users/Index',
  url: '/users',
  props: { users: [] },
  version: null,
  ...overrides,
})

const editLayer = (overrides: Answer = {}): Answer =>
  pw({
    component: 'Users/Edit',
    url: '/users/5/edit',
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 } },
    ...overrides,
  })

describe('a partial reload with a cold layer open', () => {
  it("merges a cold layer's props when a partial is answered by the layer, keeping its siblings", async () => {
    const baseFetch = held()
    const routes: Record<string, Route> = {
      'post /login': editLayerProps({ user: { id: 5 } }),
      '/users': () => baseFetch.answer(),
    }
    const app = await openAppSentCall(usersAnswer({ component: 'Auth/Login', url: '/login' }), routes)

    await visited(app, '/login', { method: 'post' })
    await settled()

    expect((await app.basePage()).component).toBe('')

    const [layer] = app.layers()

    routes['/users/5/edit'] = editLayerProps({ stats: [1, 2, 3] })
    await visited(app, '/users/5/edit', { only: ['stats'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      stats: [1, 2, 3],
    })
    expect((await app.basePage()).component).toBe('')
  })
})

describe('a refresh of the page beneath an open stack', () => {
  const warm = async () => {
    const routes: Record<string, Route> = { '/users/5/edit': editLayerProps({ user: { id: 5 } }) }
    const app = await openAppSentCall(usersAnswer(), routes)

    await visited(app, '/users/5/edit')
    await settled()

    return { app, routes, layer: app.layers()[0] }
  }

  const cold = async () => {
    const baseFetch = held()
    let baseFetches = 0
    const routes: Record<string, Route> = {
      'post /login': editLayerProps({ user: { id: 5 } }),
      '/users': () => (baseFetches++ === 0 ? baseFetch.answer() : Promise.resolve(usersAnswer())),
    }
    const app = await openAppSentCall(usersAnswer({ component: 'Auth/Login', url: '/login' }), routes)

    await visited(app, '/login', { method: 'post' })
    await settled()

    expect((await app.basePage()).component).toBe('')

    return { app, routes, layer: app.layers()[0] }
  }

  it('survives a partial that moves the base while a layer stands on it', async () => {
    const { app, routes, layer } = await warm()

    routes['/users?search=x'] = usersAnswer({ url: '/users?search=x' })
    app.router.visit('/users?search=x', { only: ['users'], preserveState: true, async: true })
    await settled()

    expect(app.layers()).toEqual([layer])
  })

  it('keeps a warm layer when a partial moves the base to another url of the same component', async () => {
    const { app, routes, layer } = await warm()
    const written = app.written().length

    routes['/users?search=x'] = usersAnswer({ url: '/users?search=x', props: { users: [{ id: 9 }] } })
    await visited(app, '/users?search=x', { only: ['users'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(await app.basePage()).toMatchObject({ url: '/users?search=x', props: { users: [{ id: 9 }] } })
    expect(app.written().slice(written)).toEqual([['replace', '/users/5/edit']])
    expect(app.entry()).toMatchObject({ url: '/users?search=x', layers: [{ id: layer.id }] })
  })

  it('leaves the stack behind when a background visit that keeps state goes to another path of the component', async () => {
    const { app, routes } = await warm()

    routes['/teams'] = usersAnswer({ url: '/teams' })
    await visited(app, '/teams', { async: true, preserveState: true })
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', url: '/teams' })
    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/teams')
  })

  it('replaces the blank with the real base when a partial is answered by the base, keeping the layer', async () => {
    const { app, routes, layer } = await cold()

    routes['/users'] = usersAnswer({ props: { users: [{ id: 9 }], stats: [1, 2, 3] } })
    await visited(app, '/users', { only: ['stats'], async: true })
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect((await app.basePage()).props).toMatchObject({ stats: [1, 2, 3] })
  })
})

describe('a layer with no url of its own reloading', () => {
  it('drops the carried target for a url-less layer and reloads the base beneath the stack', async () => {
    const app = await openAppSentCall(usersAnswer(), {
      '/users': usersAnswer({ props: { users: [{ id: 9 }], errors: {} } }),
    })
    const handle = app.router.layer({ component: 'Users/Edit', props: { user: { id: 5 } } })

    await settled()
    app.router.layerHandle(handle.id)!.router.reload({ only: ['users'] })
    await settled()

    expect(app.sent()).toEqual(['get /users'])
    expect(app.requests[0].headers['X-Inertia-Partial-Component']).toBe('Users/Index')
    expect((await app.basePage()).props.users).toEqual([{ id: 9 }])
    expect(app.layers()).toEqual([
      { id: handle.id, key: 'Users/Edit', component: 'Users/Edit', url: null, type: 'local' },
    ])
  })

  it('drops the target for a url-less layer reloading through its own router', async () => {
    const app = await openAppSentCall(usersAnswer(), {
      '/users': usersAnswer({ props: { users: [{ id: 9 }], errors: {} } }),
    })
    const handle = app.router.layer({ component: 'Users/Preview' })

    await settled()
    app.router.layerHandle(handle.id)!.router.reload({ only: ['users'] })
    await settled()

    expect(app.sent()).toEqual(['get /users'])
    expect(app.requests[0].headers['X-Inertia-Partial-Component']).toBe('Users/Index')
    expect(app.layers().map((layer) => [layer.id, layer.type])).toEqual([[handle.id, 'local']])
  })
})

describe('the asset version a layer arrives on', () => {
  it('takes the asset version the layer arrived on', async () => {
    const app = await openAppSentCall(usersAnswer({ version: 'old' }), {
      'post /users/5/edit': usersAnswer({
        component: 'Users/Edit',
        url: '/users/5/edit',
        version: 'new',
        layer: { key: 'Users/Edit' },
      }),
      '/users': usersAnswer({ version: 'new' }),
    })

    app.router.post('/users/5/edit')
    await settled()

    expect((await app.basePage()).version).toBe('new')

    app.router.reload()
    await settled()

    expect(app.requests.at(-1)!.headers['X-Inertia-Version']).toBe('new')
  })
})

describe('a partial reload answered while nothing is open', () => {
  it('keeps a layer that opened before the answer was committed', async () => {
    const resolving = gate()
    let held = false
    const app = await openApp(usersAt(), byPath({ '/users?page=2': usersAt('/users?page=2') }), {
      resolveComponent: (name) => (held && name === 'Users/Index' ? resolving.opened.then(() => ({ name })) : { name }),
    })

    held = true
    app.router.visit('/users?page=2', { only: ['users'], preserveState: true, preserveScroll: true })
    await settled()
    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.layers().map((layer) => layer.type)).toEqual(['local'])

    resolving.open()
    await settled()

    expect((await app.basePage()).url).toBe('/users?page=2')
    expect(app.layers().map((layer) => layer.type)).toEqual(['local'])
  })
})

describe('an open layer across a partial or reload', () => {
  const warm = async (layerProps: Record<string, unknown> = { user: { id: 5 } }, base: Answer = pw()) => {
    const routes: Record<string, Route> = {
      '/users/5/edit': editLayer({ props: layerProps }),
    }
    const app = await openAppSentCall(base, routes)

    await visited(app, '/users/5/edit')
    await settled()

    return { app, routes, layer: app.layers()[0] }
  }

  const login = pw({ component: 'Auth/Login', url: '/login', props: {} })

  it('keeps a warm layer when a partial refreshes the base beneath it', async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users'] = pw({ props: { stats: [1, 2, 3] } })
    await visited(app, '/users', { only: ['stats'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, stats: [1] })
    expect((await app.basePage()).props).toEqual({
      users: [],
      stats: [1, 2, 3],
    })
  })

  it('keeps a warm layer when a plain reload refreshes the base beneath it', async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users'] = pw({ props: { users: [{ id: 9 }] } })
    await new Promise<void>((resolve) => {
      app.router.reload({
        onSuccess: () => resolve(),
        onError: () => resolve(),
      })
    })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, stats: [1] })
    expect((await app.basePage()).props).toEqual({ users: [{ id: 9 }] })
  })

  it("drops the stack when a layer's own reload is answered by another page", async () => {
    const { app, routes, layer } = await warm()

    routes['/users/5/edit'] = login
    await new Promise<void>((resolve) => {
      app.router.layerHandle(layer.id)!.router.reload({
        onSuccess: () => resolve(),
        onError: () => resolve(),
      })
    })
    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(app.layers()).toEqual([])
  })

  it('drops the stack when a reload of the base is answered by another page', async () => {
    const { app, routes } = await warm()

    routes['/users'] = login
    await new Promise<void>((resolve) => {
      app.router.reload({
        onSuccess: () => resolve(),
        onError: () => resolve(),
      })
    })
    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(app.layers()).toEqual([])
  })

  it("merges a warm layer's props when a partial is answered by the layer, keeping its siblings", async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users/5/edit'] = editLayer({ props: { stats: [1, 2, 3] } })
    await visited(app, '/users/5/edit', { only: ['stats'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      stats: [1, 2, 3],
    })
  })

  it('starts a layer clean when a partial is answered under its key by another component', async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users/5/edit'] = editLayer({
      component: 'Users/Show',
      props: { stats: [1, 2, 3] },
    })
    await visited(app, '/users/5/edit', { only: ['stats'] })
    await settled()

    expect(app.layers().map(({ id, component }) => [id, component])).toEqual([[layer.id, 'Users/Show']])
    expect(app.views()[0].page.props).toEqual({ stats: [1, 2, 3] })
  })

  it("keeps a layer's scroll and once props across a partial that carried neither", async () => {
    const scrollProps = {
      stats: {
        pageName: 'page',
        previousPage: null,
        nextPage: 2,
        currentPage: 1,
        reset: false,
      },
    }
    const onceProps = { welcome: { prop: 'user', expiresAt: 123 } }
    const { app, routes } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users/5/edit'] = editLayer({
      props: { user: { id: 5 }, stats: [1] },
      scrollProps,
      onceProps,
    })
    await visited(app, '/users/5/edit')
    await settled()

    routes['/users/5/edit'] = editLayer({ props: { stats: [1, 2, 3] } })
    await visited(app, '/users/5/edit', { only: ['stats'] })
    await settled()

    expect(app.views()[0].page.scrollProps).toEqual(scrollProps)
    expect(app.views()[0].page.onceProps).toEqual(onceProps)
  })

  it("preserves a layer's own errors across a partial that carried none", async () => {
    const { app, routes } = await warm({
      user: { id: 5 },
      errors: { name: 'Required' },
    })

    routes['/users/5/edit'] = editLayer({ props: { stats: [1], errors: {} } })
    await visited(app, '/users/5/edit', {
      only: ['stats'],
      preserveErrors: true,
    })
    await settled()

    expect(app.views()[0].page.props.errors).toEqual({ name: 'Required' })
  })

  it('keeps a prop the response to a partial left out, since a partial merges into the layer', async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users/5/edit'] = editLayer({
      props: { stats: [1, 2, 3], notes: ['x'] },
    })
    await visited(app, '/users/5/edit', { only: ['stats'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      stats: [1, 2, 3],
      notes: ['x'],
    })
  })

  it('replaces a layer wholesale when a plain visit is answered by the layer dropping a prop', async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users/5/edit'] = editLayer({ props: { stats: [1, 2, 3] } })
    await visited(app, '/users/5/edit')
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({ stats: [1, 2, 3] })
  })

  it('keeps a sibling inside a nested layer prop when a partial asks for a dotted path', async () => {
    const { app, routes, layer } = await warm({
      user: { id: 5, name: 'Claud' },
    })

    routes['/users/5/edit'] = editLayer({ props: { user: { id: 9 } } })
    await visited(app, '/users/5/edit', { only: ['user.id'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 9, name: 'Claud' },
    })
  })

  it('keeps a layer prop the server left out of an except-only partial, matching the base', async () => {
    const { app, routes, layer } = await warm({
      user: { id: 5, name: 'Claud' },
    })

    routes['/users/5/edit'] = editLayer({ props: { user: { id: 5 } } })
    await visited(app, '/users/5/edit', { except: ['user.name'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5, name: 'Claud' },
    })
  })

  it('keeps a warm layer when a reset-only request refreshes the base beneath it', async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, stats: [1] })

    routes['/users'] = pw({ props: { stats: [1, 2, 3] } })
    await visited(app, '/users', { reset: ['stats'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect((await app.basePage()).props).toEqual({
      users: [],
      stats: [1, 2, 3],
    })
  })

  it('keeps a nested sibling on the base itself across a dotted partial path', async () => {
    const app = await openAppSentCall(pw({ props: { user: { id: 5, name: 'Claud' } } }), {
      '/users': pw({ props: { user: { id: 9 } } }),
    })

    await visited(app, '/users', { only: ['user.id'] })
    await settled()

    expect((await app.basePage()).props).toEqual({
      user: { id: 9, name: 'Claud' },
    })
  })

  it('emits no layers key when a layerless partial reload refreshes the base', async () => {
    const app = await openAppSentCall(pw({ props: { stats: [1] } }), {
      '/users': pw({ props: { stats: [1, 2, 3] } }),
    })

    await new Promise<void>((resolve) => {
      app.router.reload({
        only: ['stats'],
        onSuccess: () => resolve(),
        onError: () => resolve(),
      })
    })
    await settled()

    expect(await app.basePage()).not.toHaveProperty('layers')
    expect(app.entry()).not.toHaveProperty('layers')
    expect((await app.basePage()).props).toEqual({ stats: [1, 2, 3] })
  })

  it('appends a layer partial mergeProps to the open layer items', async () => {
    const { app, routes, layer } = await warm({ user: { id: 5 }, items: [1] })

    routes['/users/5/edit'] = editLayer({
      props: { items: [2, 3] },
      mergeProps: ['items'],
    })
    await visited(app, '/users/5/edit', { only: ['items'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      items: [1, 2, 3],
    })
  })

  it('prepends a layer partial prependProps before the open layer items', async () => {
    const { app, routes } = await warm({ user: { id: 5 }, items: [3] })

    routes['/users/5/edit'] = editLayer({
      props: { items: [1, 2] },
      prependProps: ['items'],
    })
    await visited(app, '/users/5/edit', { only: ['items'] })
    await settled()

    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      items: [1, 2, 3],
    })
  })

  it('deep merges a layer partial deepMergeProps into the open layer', async () => {
    const { app, routes } = await warm({
      user: { id: 5 },
      filters: { status: 'open', sort: 'asc' },
    })

    routes['/users/5/edit'] = editLayer({
      props: { filters: { status: 'closed' } },
      deepMergeProps: ['filters'],
    })
    await visited(app, '/users/5/edit', { only: ['filters'] })
    await settled()

    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      filters: { status: 'closed', sort: 'asc' },
    })
  })

  it('matches layer partial items by matchPropsOn and updates them in place', async () => {
    const { app, routes } = await warm({
      user: { id: 5 },
      items: [
        { id: 1, name: 'old' },
        { id: 2, name: 'keep' },
      ],
    })

    routes['/users/5/edit'] = editLayer({
      props: { items: [{ id: 1, name: 'new' }] },
      mergeProps: ['items'],
      matchPropsOn: ['items.id'],
    })
    await visited(app, '/users/5/edit', { only: ['items'] })
    await settled()

    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      items: [
        { id: 1, name: 'new' },
        { id: 2, name: 'keep' },
      ],
    })
  })

  it('merges a same-component layer partial against the layer, never the base', async () => {
    const filtered = (extra: Answer) =>
      pw({
        component: 'Users/Index',
        url: '/users/filtered',
        layer: { key: 'Users/Index' },
        ...extra,
      })
    const routes: Record<string, Route> = {
      '/users/filtered': filtered({ props: { items: [1], filter: 'open' } }),
    }
    const app = await openAppSentCall(pw({ props: { users: [], items: [10] } }), routes)

    await visited(app, '/users/filtered')
    await settled()

    routes['/users/filtered'] = filtered({
      props: { items: [2, 3] },
      mergeProps: ['items'],
    })
    await visited(app, '/users/filtered', { only: ['items'] })
    await settled()

    expect(app.views()[0].page.props).toEqual({
      items: [1, 2, 3],
      filter: 'open',
    })
    expect(app.views()[0].page.props).not.toHaveProperty('users')
    expect((await app.basePage()).props).toEqual({ users: [], items: [10] })
  })
})

describe('a response that refreshes the base', () => {
  it('does not merge a plain reload into the props already held', async () => {
    const app = await openAppSentCall(
      page('Users/Index', '/users', {
        props: { users: [], stale: true, errors: {} },
      }),
      {
        '/users': page('Users/Index', '/users', {
          props: { users: [{ id: 1 }], errors: {} },
        }),
      },
    )

    app.router.reload()
    await settled()

    expect((await app.basePage()).props).toEqual({
      users: [{ id: 1 }],
      errors: {},
    })
  })
})
