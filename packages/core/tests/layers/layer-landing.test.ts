import { describe, expect, it } from 'vitest'
import { held, openAppSentCall, type SentCallApp, openApp, byPath, exitShells, gate, type App } from './support/app'
import { type Answer, page, settled } from './support/browser'

const plainUsers = page('Users/Index', '/users')

const plainLogin = page('Auth/Login', '/login')

const layerEdit = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

const teamsShow = page('Teams/Show', '/teams/9', {
  layer: { key: 'Teams/Show' },
})

const teamsIndex = page('Teams/Index', '/teams')

const components = (app: App) => app.layers().map((layer) => layer.component)

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

const visited = (app: SentCallApp, url: string, options: Record<string, unknown> = {}): Promise<void> =>
  new Promise((resolve) => {
    app.router.visit(url, {
      ...options,
      onSuccess: () => resolve(),
      onError: () => resolve(),
    } as never)
  })

describe('a layer response landing', () => {
  const cold = { ...layerEdit, layer: { key: 'Users/Edit', base: '/users' } }

  it('opens a new layer over the base, leaving the base standing', async () => {
    const app = await openApp(plainUsers, byPath({ '/users/5/edit': layerEdit }))
    const before = app.written().length

    app.router.visit('/users/5/edit')
    await settled()

    const [open] = app.layers()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(components(app)).toEqual(['Users/Edit'])
    expect(app.entry()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
      layers: [
        {
          id: open.id,
          component: 'Users/Edit',
          url: '/users/5/edit',
          entries: 1,
        },
      ],
    })
    expect(app.entry().layers![0]).not.toHaveProperty('standalone')
    expect(app.written().slice(before)).toEqual([['push', '/users/5/edit']])
    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/edit'])
  })

  it('rewrites the layer already open under the same key rather than stacking a second', async () => {
    const app = await openApp(
      plainUsers,
      byPath({
        '/users/5/edit': layerEdit,
        '/users/6/edit': {
          ...layerEdit,
          url: '/users/6/edit',
          props: { errors: {}, user: { id: 6 } },
        },
      }),
    )

    app.router.visit('/users/5/edit')
    await settled()

    const [open] = app.layers()

    app.router.layerHandle(open.id)!.router.visit('/users/6/edit')
    await settled()

    expect(app.layers()).toEqual([{ ...open, url: '/users/6/edit' }])
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 6 } })
  })

  it('opens under the id the call created, so its handle answers for it', async () => {
    const app = await openApp(plainUsers, byPath({ '/users/5/edit': layerEdit }))
    const handle = app.router.layer('/users/5/edit')
    const id = handle.id

    await settled()

    expect(handle.state).toBe('open')
    expect(handle.id).toBe(id)
    expect(app.layers()[0].id).toBe(id)
    expect(app.router.layerHandle(id)!.component).toBe('Users/Edit')
    expect(app.entry().layers![0].owner).toBeNull()
  })

  it('closes the stack down to the layer a deeper link named before landing', async () => {
    const app = await openApp(plainUsers, byPath({ '/users/5/edit': layerEdit, '/teams/9': teamsShow }))

    app.router.visit('/users/5/edit')
    await settled()

    const [first] = app.layers()
    const second = app.router.layerHandle(first.id)!.router.layer('/teams/9')

    await settled()
    expect(components(app)).toEqual(['Users/Edit', 'Teams/Show'])

    app.router.layerHandle(first.id)!.router.visit('/users/5/edit')
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([first])
    expect(second.state).toBe('closed')
  })

  it('leaves the stack alone when a refresh in place answers a layer beneath the top', async () => {
    const app = await openApp(plainUsers, byPath({ '/users/5/edit': layerEdit, '/teams/9': teamsShow }))

    app.router.visit('/users/5/edit')
    await settled()

    const [first] = app.layers()
    const second = app.router.layerHandle(first.id)!.router.layer('/teams/9')

    await settled()

    const stacked = app.layers()

    app.router.layerHandle(first.id)!.router.reload({ only: ['user'] })
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual(stacked)
    expect(second.state).toBe('open')
  })

  it('stands a layer with nowhere valid to sit on a cold base and fetches the base', async () => {
    const baseGate = gate()
    const app = await openApp(
      plainLogin,
      byPath({ '/login': cold, '/users': () => baseGate.opened.then(() => plainUsers) }),
    )

    app.router.visit('/login')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: '',
      url: '/users',
    })
    expect(components(app)).toEqual(['Users/Edit'])
    expect(app.entry()).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
    })
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.requests.map((request) => request.path)).toEqual(['/login', '/users'])
    expect(window.location.pathname).toBe('/users/5/edit')

    baseGate.open()
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(components(app)).toEqual(['Users/Edit'])
    expect(app.entry().layers![0]).toMatchObject({
      component: 'Users/Edit',
      standalone: true,
    })
  })

  it('promotes a layer that declares no base and cannot compose to the page', async () => {
    const app = await openApp(plainLogin, byPath({ '/login': layerEdit }))

    app.router.visit('/login')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
    })
    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.requests.map((request) => request.path)).toEqual(['/login'])
  })
})

describe('a page response landing', () => {
  const openOver = async (routes: Parameters<typeof byPath>[0]) => {
    const app = await openApp(plainUsers, byPath({ '/users/5/edit': layerEdit, ...routes }))

    app.router.visit('/users/5/edit')
    await settled()

    return app
  }

  it('replaces the page and takes the stack with it', async () => {
    const app = await openOver({ '/teams': teamsIndex })
    const handle = app.layers()[0]

    expect(handle.component).toBe('Users/Edit')

    app.router.visit('/teams')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Teams/Index',
      url: '/teams',
    })
    expect(await app.basePage()).not.toHaveProperty('layers')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  describe('refreshing the base', () => {
    it('a reload of the same component refreshes it', async () => {
      const app = await openOver({ '/users': plainUsers })
      const stacked = app.layers()

      app.router.reload()
      await settled()

      expect(app.requests.at(-1)).toMatchObject({ path: '/users' })
      expect(app.layers()).toEqual(stacked)
    })

    it('a reload redirected to another component does not', async () => {
      const app = await openOver({ '/users': plainLogin })

      app.router.reload()
      await settled()
      exitShells(app)
      await settled()

      expect(await app.basePage()).toMatchObject({
        component: 'Auth/Login',
        url: '/login',
      })
      expect(app.layers()).toEqual([])
    })

    it('a visit to another url of the same component does not', async () => {
      const app = await openOver({
        '/users?page=2': { ...plainUsers, url: '/users?page=2' },
      })

      app.router.visit('/users?page=2')
      await settled()
      exitShells(app)
      await settled()

      expect(await app.basePage()).toMatchObject({
        component: 'Users/Index',
        url: '/users?page=2',
      })
      expect(app.layers()).toEqual([])
    })

    it('a partial reload of the same component still refreshes it', async () => {
      const app = await openOver({ '/users': plainUsers })
      const stacked = app.layers()

      app.router.reload({ only: ['users'] })
      await settled()

      expect(app.requests.at(-1)).toMatchObject({ path: '/users' })
      expect(app.requests.at(-1)!.headers['X-Inertia-Partial-Data']).toBe('users')
      expect(app.layers()).toEqual(stacked)
    })

    it('a partial reload of another url of the same component does not', async () => {
      const late = gate()
      const app = await openOver({
        '/users?search=x': { ...plainUsers, url: '/users?search=x' },
        '/teams/9': () => late.opened.then(() => teamsShow),
      })
      const stacked = app.layers()

      app.router.visit('/teams/9', { async: true })
      await settled()
      app.router.visit('/users?search=x', { only: ['users'] })
      await settled()
      late.open()
      await settled()

      expect(await app.basePage()).toMatchObject({
        component: 'Users/Index',
        url: '/users?search=x',
      })
      expect(app.layers()).toEqual(stacked)
    })
  })

  it('keeps the stack over a base a reload refreshes', async () => {
    const app = await openOver({
      '/users': { ...plainUsers, props: { errors: {}, users: [1] } },
    })
    const [open] = app.layers()

    app.router.reload()
    await settled()

    expect((await app.basePage()).props).toEqual({ errors: {}, users: [1] })
    expect(app.layers()).toEqual([open])
  })

  it('hands errors back to a local layer submitted from the address beneath it', async () => {
    const app = await openApp(
      plainUsers,
      byPath({
        'post /users': {
          ...plainUsers,
          props: { errors: { name: 'Required' }, users: [] },
          flash: { note: 'x' },
        },
      }),
    )
    const handle = app.router.layer({
      component: 'Prompt',
      props: { step: 1 },
    })

    await settled()
    expect(app.layers()).toEqual([
      {
        id: handle.id,
        key: 'Prompt',
        component: 'Prompt',
        url: null,
        type: 'local',
      },
    ])

    app.router.layerHandle(handle.id)!.router.post('/users')
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([handle.id])
    expect((await app.basePage()).props).toEqual({ errors: {} })
    expect((await app.basePage()).flash).toEqual({})
    expect(app.views()[0].page.props).toEqual({
      errors: { name: 'Required' },
      step: 1,
    })
    expect(app.views()[0].page.flash).toEqual({ note: 'x' })
    expect(handle.state).toBe('open')
  })
})

describe("a layer's own component across a rewrite", () => {
  const openEdit = async () => {
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), {
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
