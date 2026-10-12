import { describe, expect, it } from 'vitest'
import { exitShells, held, scenario, settled, type Answer, type App } from './a-support'

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

const notesLayer = (overrides: Answer = {}): Answer =>
  pw({
    component: 'Users/Notes',
    url: '/users/5/edit/notes',
    layer: { key: 'Users/Notes' },
    ...overrides,
  })

const teamsLayer = (overrides: Answer = {}): Answer =>
  pw({
    component: 'Teams/Show',
    url: '/teams/9',
    layer: { key: 'Teams/Show' },
    ...overrides,
  })

const visited = (app: App, url: string, options: Record<string, unknown> = {}): Promise<void> =>
  new Promise((resolve) => {
    app.router.visit(url, {
      ...options,
      onSuccess: () => resolve(),
      onError: () => resolve(),
    } as never)
  })

const keys = (app: App) => app.layers().map((layer) => layer.key)

describe('the base a layer response composes onto', () => {
  it('composes onto the stack when the layer the visit was sent from is still open', async () => {
    const answer = held()
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users/5/edit/notes': notesLayer(),
      'post /users/5/promote': () => answer.answer(),
      '/users/5/edit': editLayer(),
    })

    await visited(app, '/users/5/edit')
    await settled()
    const [edit] = app.layers()
    await visited(app, '/users/5/edit/notes')
    await settled()
    const notes = app.layers()[1]

    app.router.layerHandle(edit.id)!.router.post('/users/5/promote')
    await settled()

    const closing = app.router.close(notes.id)
    exitShells(app)
    await settled()
    answer.release(teamsLayer())
    await closing
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index' })
    expect(keys(app)).toEqual(['Users/Edit', 'Teams/Show'])
  })

  it('promotes a layer when the page moved to another url of the same component while it was in flight', async () => {
    const answer = held()
    const app = await scenario(pw(), {
      '/users/5/edit': () => answer.answer(),
      '/users?search=x': pw({
        url: '/users?search=x',
        props: { users: [{ id: 9 }] },
      }),
    })
    const events: string[] = []

    app.router.visit('/users/5/edit', {
      onSuccess: () => events.push('success'),
      onFinish: () => events.push('finish'),
    })
    await settled()
    await visited(app, '/users?search=x', { only: ['users'], async: true })
    answer.release(editLayer())
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users?search=x',
      props: { users: [{ id: 9 }] },
    })
    expect(app.layers()).toEqual([])
    expect(events).toEqual(['finish'])
  })

  it('composes a layer across a background reload that refreshes the base in place', async () => {
    const answer = held()
    const app = await scenario(pw(), {
      '/users/5/edit': () => answer.answer(),
      '/users?page=2': pw({
        url: '/users?page=2',
        props: { users: [{ id: 9 }] },
      }),
    })

    const done = visited(app, '/users/5/edit')
    await settled()
    await new Promise<void>((resolve) => {
      app.router.reload({
        only: ['users'],
        data: { page: 2 },
        preserveUrl: true,
        onSuccess: () => resolve(),
      })
    })
    answer.release(editLayer())
    await done
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      props: { users: [{ id: 9 }] },
    })
    expect(keys(app)).toEqual(['Users/Edit'])
  })

  it('composes a layer opened by a visit that preserves the url', async () => {
    const app = await scenario(pw(), { '/users/5/edit': editLayer() })

    await visited(app, '/users/5/edit', { preserveUrl: true })
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index' })
    expect(keys(app)).toEqual(['Users/Edit'])
  })

  it('gives a layer opened by a visit that preserves the url its own url, but not the address', async () => {
    const app = await scenario(pw(), { '/users/5/edit': editLayer() })

    await visited(app, '/users/5/edit', { preserveUrl: true })
    await settled()

    expect(app.layers().map(({ key, url }) => [key, url])).toEqual([['Users/Edit', '/users/5/edit']])
    expect(app.entry().layers![0]).toMatchObject({
      key: 'Users/Edit',
      url: '/users/5/edit',
      preservesUrl: true,
    })
    expect(window.location.pathname).toBe('/users')
  })

  it('leaves an open layer the url it already had when a preserving reload rewrites it', async () => {
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users/5/edit?page=2': editLayer({
        url: '/users/5/edit?page=2',
        props: { user: { id: 5 }, notes: [1] },
      }),
    })

    await visited(app, '/users/5/edit')
    await settled()

    const [layer] = app.layers()

    await new Promise<void>((resolve) => {
      app.router.layerHandle(layer.id)!.router.visit('/users/5/edit?page=2', {
        only: ['notes'],
        preserveUrl: true,
        onSuccess: () => resolve(),
        onError: () => resolve(),
      })
    })
    await settled()

    expect(app.layers().map(({ id, url }) => [id, url])).toEqual([[layer.id, '/users/5/edit']])
    expect(window.location.pathname + window.location.search).toBe('/users/5/edit')
  })

  it('leaves the address on the layer beneath when a layer opens without moving the url', async () => {
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users/5/edit/notes': notesLayer(),
    })

    await visited(app, '/users/5/edit')
    await settled()
    await visited(app, '/users/5/edit/notes', { preserveUrl: true })
    await settled()

    await new Promise<void>((resolve) => {
      app.router.replace({
        props: { users: [{ id: 1 }] },
        onSuccess: () => resolve(),
      })
    })
    await settled()

    expect(app.written().at(-1)).toEqual(['replace', '/users/5/edit'])
    expect(
      (app.entry().layers as { url: string; preservesUrl?: boolean }[]).map((layer) => [
        layer.url,
        !!layer.preservesUrl,
      ]),
    ).toEqual([
      ['/users/5/edit', false],
      ['/users/5/edit/notes', true],
    ])
    expect(window.location.pathname).toBe('/users/5/edit')
  })

  it('promotes a layer dispatched from a layer the user dismissed while it was in flight', async () => {
    const answer = held()
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users': pw(),
      'post /users/5/promote': () => answer.answer(),
    })

    await visited(app, '/users/5/edit')
    await settled()
    void visited(app, '/users/5/promote', { method: 'post' })
    await settled()

    const closing = app.router.close(app.layers()[0].id)
    exitShells(app)
    await closing
    await settled()
    expect(app.layers()).toEqual([])

    answer.release(teamsLayer())
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Teams/Show',
      url: '/teams/9',
    })
    expect(app.layers()).toEqual([])
  })

  it('does not reopen a layer the user dismissed while a submit inside it was in flight', async () => {
    const answer = held()
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users': pw(),
      'post /users/5': () => answer.answer(),
    })

    await visited(app, '/users/5/edit')
    await settled()
    void visited(app, '/users/5', { method: 'post' })
    await settled()

    const closing = app.router.close(app.layers()[0].id)
    exitShells(app)
    await closing
    await settled()

    answer.release(
      editLayer({
        props: {
          user: { id: 5 },
          errors: { name: 'The name field is required.' },
        },
      }),
    )
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Users/Edit' })
    expect(app.layers()).toEqual([])
  })

  it('promotes a layer to a page when it comes back through a login page', async () => {
    const app = await scenario(pw({ component: 'Auth/Login', url: '/login' }), {
      'post /login': editLayer(),
    })

    await visited(app, '/login', { method: 'post' })
    await settled()

    const base = await app.basePage()

    expect(base).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
    })
    expect(base).not.toHaveProperty('layer')
    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/users/5/edit')
  })

  it('composes a layer router.layer() asked for, whatever url the server answered from', async () => {
    const app = await scenario(pw(), {
      'post /users/5/edit-start': editLayer(),
    })

    const handle = app.router.layer('/users/5/edit-start', { method: 'post' })
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index' })
    expect(app.layers()).toEqual([
      {
        id: handle.id,
        key: 'Users/Edit',
        component: 'Users/Edit',
        url: '/users/5/edit',
        type: 'routed',
      },
    ])
  })

  it('promotes a layer router.layer() asked for when the page beneath it was replaced in flight', async () => {
    const answer = held()
    const app = await scenario(pw(), {
      'post /users/5/edit-start': () => answer.answer(),
      '/users/archive': pw({
        component: 'Users/Archive',
        url: '/users/archive',
      }),
    })

    const handle = app.router.layer('/users/5/edit-start', { method: 'post' })
    await settled()
    app.router.push({
      component: 'Users/Archive',
      url: '/users/archive',
      props: {},
    })
    await settled()
    answer.release(editLayer())
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Archive',
      url: '/users/archive',
    })
    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')
  })

  it('promotes a prefetched layer replayed onto a base an instant swap has since replaced', async () => {
    const app = await scenario(pw(), { '/users/5/edit': editLayer() })

    Object.assign(window, { setTimeout, clearTimeout })
    app.router.prefetch('/users/5/edit', {}, { cacheFor: '30s' })
    await settled()
    expect(app.router.getCached('/users/5/edit', {})).not.toBeNull()

    app.router.push({
      component: 'Users/Archive',
      url: '/users/archive',
      props: {},
    })
    await settled()
    app.router.push({
      component: 'Users/Trash',
      url: '/users/trash',
      props: {},
    })
    await settled()
    await visited(app, '/users/5/edit', { component: 'Users/Edit' })
    await settled()

    expect((await app.basePage()).props).toEqual({ user: { id: 5 } })
    expect(app.layers()).toEqual([])
  })
})

describe('the prefetch cache shared between the page and its layers', () => {
  const openTwo = async () => {
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users/5/edit/notes': notesLayer(),
      '/users/5/edit?tab=2': editLayer({ url: '/users/5/edit?tab=2' }),
    })

    Object.assign(window, { setTimeout, clearTimeout })

    await visited(app, '/users/5/edit')
    await settled()
    await visited(app, '/users/5/edit/notes')
    await settled()

    return app
  }

  it('answers a lookup from the page or another layer with what a layer prefetched', async () => {
    const app = await openTwo()
    const [first, second] = app.layers()

    app.router.layerHandle(first.id)!.router.prefetch('/users/5/edit?tab=2', {}, { cacheFor: '30s' })
    await settled()

    expect(app.sent().at(-1)).toBe('get /users/5/edit?tab=2')
    expect(app.router.getCached('/users/5/edit?tab=2', {})).not.toBeNull()
    expect(app.router.layerHandle(second.id)!.router.getCached('/users/5/edit?tab=2', {})).not.toBeNull()
  })

  it('does not answer a lookup that asks for other props', async () => {
    const app = await openTwo()
    const [first] = app.layers()

    app.router.layerHandle(first.id)!.router.prefetch('/users/5/edit?tab=2', {}, { cacheFor: '30s' })
    await settled()

    expect(app.sent().at(-1)).toBe('get /users/5/edit?tab=2')
    expect(app.router.getCached('/users/5/edit?tab=2', { only: ['user'] })).toBeNull()
  })
})

describe("a layer's own component across a rewrite", () => {
  const openEdit = async () => {
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users/6/edit': editLayer({ props: { user: { id: 6 } } }),
    })

    await visited(app, '/users/5/edit')
    await settled()

    return app
  }

  it('remakes the component when the visit did not preserve state', async () => {
    const app = await openEdit()
    const opened = app.views()[0].renderKey

    await visited(app, '/users/6/edit')
    await settled()

    expect(app.views()[0].page.props).toEqual({ user: { id: 6 } })
    expect(app.views()[0].renderKey).not.toBe(opened)
  })

  it('keeps the component when the visit preserved state', async () => {
    const app = await openEdit()
    const opened = app.views()[0].renderKey

    await visited(app, '/users/6/edit', { preserveState: true })
    await settled()

    expect(app.views()[0].page.props).toEqual({ user: { id: 6 } })
    expect(app.views()[0].renderKey).toBe(opened)
  })
})

describe('a layer response that names an earlier level', () => {
  const stack = async (routes: Record<string, Route> = {}) => {
    const app = await scenario(pw(), {
      '/users/5/edit': editLayer(),
      '/users/5/edit/notes': notesLayer(),
      ...routes,
    })

    await visited(app, '/users/5/edit')
    await settled()
    await visited(app, '/users/5/edit/notes')
    await settled()

    const [edit, notes] = app.layers()

    expect(app.entry().layers!.map((layer) => layer.entries)).toEqual([1, 1])

    return { app, edit, notes }
  }

  it('closes the layers above the one it lands on, rewriting that layer where it stands', async () => {
    const { app, edit, notes } = await stack({
      '/users/6/edit': editLayer({
        url: '/users/6/edit',
        props: { user: { id: 6 } },
      }),
    })
    const closed: string[] = []

    app.router.layerHandle(notes.id)!.onClose(() => closed.push(notes.id))
    await visited(app, '/users/6/edit')
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([edit.id])
    expect(app.views()[0].page.props).toEqual({ user: { id: 6 } })
    expect(window.location.pathname).toBe('/users/6/edit')
    expect(closed).toEqual([notes.id])
  })

  it('gives the layer it lands on the entries the closed layers owned', async () => {
    const { app } = await stack({
      '/users/6/edit': editLayer({ url: '/users/6/edit' }),
    })

    await visited(app, '/users/6/edit')
    await settled()
    exitShells(app)
    await settled()

    expect(app.entry().layers!.map((layer) => layer.entries)).toEqual([3])
  })

  it('does not cancel a reload of the page when the close refreshes the layer beneath', async () => {
    const reload = held()
    const refresh = held()
    let calls = 0
    const { app, notes } = await stack({
      '/users': () => reload.answer(),
      '/users/5/edit': () => (calls++ === 0 ? Promise.resolve(editLayer()) : refresh.answer()),
    })
    let cancelled = false

    app.router.reload({ only: ['users'], onCancel: () => (cancelled = true) })
    await settled()

    const closing = app.router.close(notes.id)
    exitShells(app)
    await settled()

    expect(app.sent().at(-1)).toBe('get /users/5/edit')
    expect(cancelled).toBe(false)

    reload.release(pw())
    refresh.release(editLayer())
    await closing
  })

  it('leaves the layers above alone when a poll refreshes the layer beneath them', async () => {
    const { app, edit, notes } = await stack({
      '/users/5/edit': editLayer({ props: { user: { id: 5, seen: 1 } } }),
    })

    await new Promise<void>((resolve) => {
      app.router.layerHandle(edit.id)!.router.reload({
        onSuccess: () => resolve(),
        onError: () => resolve(),
      })
    })
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([edit.id, notes.id])
    expect(app.views()[0].page.props).toEqual({ user: { id: 5, seen: 1 } })
    expect(window.location.pathname).toBe('/users/5/edit/notes')
  })

  it('leaves the layers above alone when a deferred group fills in the layer beneath them', async () => {
    const { app, edit, notes } = await stack({
      '/users/5/edit': editLayer({ props: { user: { id: 5 }, history: [1] } }),
    })

    await new Promise<void>((resolve) => {
      app.router.layerHandle(edit.id)!.router.reload({
        only: ['history'],
        onSuccess: () => resolve(),
        onError: () => resolve(),
      })
    })
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([edit.id, notes.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      history: [1],
    })
  })

  it('leaves a response that lands on the top layer stacked exactly as it was', async () => {
    const { app, edit, notes } = await stack({
      '/users/5/edit/other-notes': notesLayer({
        url: '/users/5/edit/other-notes',
      }),
    })

    await visited(app, '/users/5/edit/other-notes')
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([edit.id, notes.id])
    expect(window.location.pathname).toBe('/users/5/edit/other-notes')
  })
})

describe('an open layer across a partial or reload', () => {
  const warm = async (layerProps: Record<string, unknown> = { user: { id: 5 } }, base: Answer = pw()) => {
    const routes: Record<string, Route> = {
      '/users/5/edit': editLayer({ props: layerProps }),
    }
    const app = await scenario(base, routes)

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
    const app = await scenario(pw({ props: { user: { id: 5, name: 'Claud' } } }), {
      '/users': pw({ props: { user: { id: 9 } } }),
    })

    await visited(app, '/users', { only: ['user.id'] })
    await settled()

    expect((await app.basePage()).props).toEqual({
      user: { id: 9, name: 'Claud' },
    })
  })

  it('emits no layers key when a layerless partial reload refreshes the base', async () => {
    const app = await scenario(pw({ props: { stats: [1] } }), {
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
    const app = await scenario(pw({ props: { users: [], items: [10] } }), routes)

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
