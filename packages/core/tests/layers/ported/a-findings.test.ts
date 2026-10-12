import { describe, expect, it } from 'vitest'
import { held, scenario, settled, type Answer, type App, type Route } from './a-support'

const users = (overrides: Answer = {}): Answer => ({
  component: 'Users/Index',
  url: '/users',
  props: { users: [] },
  version: null,
  ...overrides,
})

const editLayer = (props: Record<string, unknown>): Answer =>
  users({
    component: 'Users/Edit',
    url: '/users/5/edit',
    layer: { key: 'Users/Edit', base: '/users' },
    props,
  })

const visited = (app: App, url: string, options: Record<string, unknown> = {}): Promise<void> =>
  new Promise((resolve) => {
    app.router.visit(url, {
      ...options,
      onSuccess: () => resolve(),
      onError: () => resolve(),
    } as never)
  })

describe('a partial reload with a cold layer open', () => {
  it("merges a cold layer's props when a partial is answered by the layer, keeping its siblings", async () => {
    const walk = held()
    const routes: Record<string, Route> = {
      'post /login': editLayer({ user: { id: 5 } }),
      '/users': () => walk.answer(),
    }
    const app = await scenario(users({ component: 'Auth/Login', url: '/login' }), routes)

    await visited(app, '/login', { method: 'post' })
    await settled()

    expect((await app.basePage()).component).toBe('')

    const [layer] = app.layers()

    routes['/users/5/edit'] = editLayer({ stats: [1, 2, 3] })
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
    const routes: Record<string, Route> = { '/users/5/edit': editLayer({ user: { id: 5 } }) }
    const app = await scenario(users(), routes)

    await visited(app, '/users/5/edit')
    await settled()

    return { app, routes, layer: app.layers()[0] }
  }

  const cold = async () => {
    const walk = held()
    let hops = 0
    const routes: Record<string, Route> = {
      'post /login': editLayer({ user: { id: 5 } }),
      '/users': () => (hops++ === 0 ? walk.answer() : Promise.resolve(users())),
    }
    const app = await scenario(users({ component: 'Auth/Login', url: '/login' }), routes)

    await visited(app, '/login', { method: 'post' })
    await settled()

    expect((await app.basePage()).component).toBe('')

    return { app, routes, layer: app.layers()[0] }
  }

  it('survives a partial that moves the base while a layer stands on it', async () => {
    const { app, routes, layer } = await warm()

    routes['/users?search=x'] = users({ url: '/users?search=x' })
    app.router.visit('/users?search=x', { only: ['users'], preserveState: true, async: true })
    await settled()

    expect(app.layers()).toEqual([layer])
  })

  it('keeps a warm layer when a partial moves the base to another url of the same component', async () => {
    const { app, routes, layer } = await warm()
    const written = app.written().length

    routes['/users?search=x'] = users({ url: '/users?search=x', props: { users: [{ id: 9 }] } })
    await visited(app, '/users?search=x', { only: ['users'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(await app.basePage()).toMatchObject({ url: '/users?search=x', props: { users: [{ id: 9 }] } })
    expect(app.written().slice(written)).toEqual([['replace', '/users/5/edit']])
    expect(app.entry()).toMatchObject({ url: '/users?search=x', layers: [{ id: layer.id }] })
  })

  it('leaves the stack behind when a background visit that keeps state goes to another path of the component', async () => {
    const { app, routes } = await warm()

    routes['/teams'] = users({ url: '/teams' })
    await visited(app, '/teams', { async: true, preserveState: true })
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', url: '/teams' })
    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/teams')
  })

  it('replaces the blank with the real base when a partial is answered by the base, keeping the layer', async () => {
    const { app, routes, layer } = await cold()

    routes['/users'] = users({ props: { users: [{ id: 9 }], stats: [1, 2, 3] } })
    await visited(app, '/users', { only: ['stats'], async: true })
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect((await app.basePage()).props).toMatchObject({ stats: [1, 2, 3] })
  })
})

describe('a layer with no url of its own reloading', () => {
  it('drops the carried target for a url-less layer and reloads the base beneath the stack', async () => {
    const app = await scenario(users(), { '/users': users({ props: { users: [{ id: 9 }], errors: {} } }) })
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
    const app = await scenario(users(), { '/users': users({ props: { users: [{ id: 9 }], errors: {} } }) })
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
    const app = await scenario(users({ version: 'old' }), {
      'post /users/5/edit': users({
        component: 'Users/Edit',
        url: '/users/5/edit',
        version: 'new',
        layer: { key: 'Users/Edit' },
      }),
      '/users': users({ version: 'new' }),
    })

    app.router.post('/users/5/edit')
    await settled()

    expect((await app.basePage()).version).toBe('new')

    app.router.reload()
    await settled()

    expect(app.requests.at(-1)!.headers['X-Inertia-Version']).toBe('new')
  })
})
