import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  held,
  openAppSentCall,
  type SentCallApp,
  type Route,
  openApp,
  byPath,
  exitShells,
  gate,
  type App,
  openAppSync,
} from './support/app'
import { type Answer, page, settled } from './support/browser'
import { baseGen, cached, requestsOf } from './support/peek'

const plainLogin = page('Auth/Login', '/login')

const layerEdit = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

const teamsShow = page('Teams/Show', '/teams/9', {
  layer: { key: 'Teams/Show' },
})

const teamsMembers = page('Teams/Members', '/teams/9/members', {
  layer: { key: 'Teams/Members' },
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

const teamsLayer = (overrides: Answer = {}): Answer =>
  pw({
    component: 'Teams/Show',
    url: '/teams/9',
    layer: { key: 'Teams/Show' },
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

const keys = (app: SentCallApp) => app.layers().map((layer) => layer.key)

const users = page('Users/Index', '/users', {
  props: { users: [], errors: {} },
})

const editLayerPage = (extra: Answer = {}) =>
  page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  })

const teams = page('Teams/Show', '/teams/9', {
  layer: { key: 'Teams/Show' },
  props: { errors: {} },
})

const open = async (initial: Answer = users, routes: Record<string, Route> = {}) => {
  const app = await openAppSentCall(initial, {
    '/users/5/edit': editLayerPage(),
    '/teams/9': teams,
    ...routes,
  })

  app.router.visit('/users/5/edit')
  await settled()

  return app
}

const ids = (app: Awaited<ReturnType<typeof openAppSentCall>>) => app.layers().map((layer) => layer.id)

const usersIndex = page('Users/Index', '/users', {
  props: { errors: {}, users: [] },
})

const archive = page('Users/Archive', '/users/archive')

const plainShow = page('Users/Show', '/users/5')

const hold = () => new Promise<never>(() => {})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('whether a layer response composes over the captured base', () => {
  it('holds when the visit was dispatched toward the layer', async () => {
    const app = await openApp(plainLogin, byPath({ '/users/5/edit': layerEdit }))

    app.router.visit('/users/5/edit')
    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(components(app)).toEqual(['Users/Edit'])
  })

  it('holds when the layer is already open', async () => {
    const app = await openApp(
      plainLogin,
      byPath({
        '/users/5/edit': layerEdit,
        '/login': { ...layerEdit, props: { errors: {}, user: { id: 6 } } },
      }),
    )

    app.router.visit('/users/5/edit')
    await settled()

    const [open] = app.layers()

    app.router.visit('/login')
    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(app.layers()).toEqual([open])
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 6 } })
  })

  it('holds when the layer it was dispatched from is still open', async () => {
    const app = await openApp(plainLogin, byPath({ '/teams/9': teamsShow, '/login': layerEdit }))

    app.router.visit('/teams/9')
    await settled()

    const [open] = app.layers()

    app.router.visit('/login')
    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(components(app)).toEqual(['Teams/Show', 'Users/Edit'])
    expect(app.layers()[0]).toEqual(open)
    expect(app.entry().layers!.map((layer) => layer.owner)).toEqual([null, open.id])
  })

  it('holds when the layer declares the page on screen as its base', async () => {
    const app = await openApp(
      plainLogin,
      byPath({
        '/login': { ...layerEdit, layer: { key: 'Users/Edit', base: '/login' } },
      }),
    )

    app.router.visit('/login')
    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(components(app)).toEqual(['Users/Edit'])
    expect(app.requests.map((request) => request.path)).toEqual(['/login'])
  })

  it('holds for an open, whatever the visit was dispatched toward', async () => {
    const app = await openApp(plainLogin, byPath({ '/login': layerEdit }))
    const handle = app.router.layer('/login')

    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(components(app)).toEqual(['Users/Edit'])
    expect(handle.state).toBe('open')
    expect(app.layers()[0].id).toBe(handle.id)
  })

  it('fails once the layer it was dispatched from has been closed', async () => {
    const held = gate()
    const app = await openApp(
      plainLogin,
      byPath({
        '/teams/9': teamsShow,
        '/other': () => held.opened.then(() => layerEdit),
        '/login': plainLogin,
      }),
    )
    const handle = app.router.layer('/teams/9')

    await settled()
    app.router.visit('/other', { async: true })
    await settled()

    const closing = handle.close()

    exitShells(app)
    await closing
    held.open()
    await settled()

    expect(app.layers()).toEqual([])
    expect(await app.basePage()).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
    })
    expect(await app.basePage()).not.toHaveProperty('layer')
  })

  it('fails when the layer it was dispatched from has been closed and another opened', async () => {
    const held = gate()
    const app = await openApp(
      plainLogin,
      byPath({
        '/teams/9': teamsShow,
        '/teams/9/members': teamsMembers,
        '/other': () => held.opened.then(() => layerEdit),
        '/login': plainLogin,
      }),
    )
    const first = app.router.layer('/teams/9')

    await settled()
    app.router.visit('/other', { async: true })
    await settled()

    const closing = first.close()

    exitShells(app)
    await closing
    app.router.layer('/teams/9/members')
    await settled()
    expect(components(app)).toEqual(['Teams/Members'])

    held.open()
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect(await app.basePage()).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
    })
  })

  it('fails for a layer returned through a login page', async () => {
    const app = await openApp(plainLogin, byPath({ '/login': layerEdit }))

    app.router.visit('/login')
    await settled()

    expect(app.layers()).toEqual([])
    expect(await app.basePage()).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
    })
    expect(await app.basePage()).not.toHaveProperty('layer')
  })

  it('fails once the base it captured has been replaced, whatever else holds', async () => {
    const held = gate()
    const app = await openApp(
      plainLogin,
      byPath({
        '/users/5/edit': () => held.opened.then(() => layerEdit),
        '/teams': teamsIndex,
      }),
    )

    app.router.visit('/users/5/edit', { async: true })
    await settled()
    app.router.visit('/teams')
    await settled()
    held.open()
    await settled()

    expect(app.layers()).toEqual([])
    expect(await app.basePage()).toMatchObject({
      component: 'Teams/Index',
      url: '/teams',
    })
  })

  it('never composes a hop of a walk, which is fetching the base beneath', async () => {
    const app = await openApp(
      plainLogin,
      byPath({
        '/login': { ...layerEdit, layer: { key: 'Users/Edit', base: '/users' } },
        '/users': {
          ...layerEdit,
          component: 'Users/Index',
          url: '/users',
          layer: { key: 'Users/Index' },
        },
      }),
    )

    app.router.visit('/login')
    await settled()

    expect(app.requests.map((request) => request.path)).toEqual(['/login', '/users'])
    expect(components(app)).toEqual(['Users/Edit'])
    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(await app.basePage()).not.toHaveProperty('layer')
  })
})

describe('the base a layer response composes onto', () => {
  it('composes onto the stack when the layer the visit was sent from is still open', async () => {
    const answer = held()
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), { '/users/5/edit': editLayer() })

    await visited(app, '/users/5/edit', { preserveUrl: true })
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index' })
    expect(keys(app)).toEqual(['Users/Edit'])
  })

  it('gives a layer opened by a visit that preserves the url its own url, but not the address', async () => {
    const app = await openAppSentCall(pw(), { '/users/5/edit': editLayer() })

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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw({ component: 'Auth/Login', url: '/login' }), {
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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), {
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
    const app = await openAppSentCall(pw(), { '/users/5/edit': editLayer() })

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

describe('the base a layer response composes onto', () => {
  it('composes onto the page a visit aimed at the layer was made from', async () => {
    const app = await open()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect((await app.basePage()).url).toBe('/users')
    expect(app.layers().map((layer) => [layer.key, layer.url])).toEqual([['Users/Edit', '/users/5/edit']])
    expect(app.entry().layers).toHaveLength(1)
  })

  it('composes onto the page it names as its base, when a create redirects to the record', async () => {
    const app = await openAppSentCall(users, {
      'post /users': editLayerPage({
        layer: { key: 'Users/Edit', base: '/users' },
      }),
    })

    app.router.post('/users')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect((await app.basePage()).url).toBe('/users')
    expect(app.layers().map((layer) => [layer.key, layer.url])).toEqual([['Users/Edit', '/users/5/edit']])
    expect(app.sent()).toEqual(['post /users'])
  })

  it('walks a base back for a layer whose base is not the page on screen', async () => {
    const walk = held()
    const app = await openAppSentCall(page('Auth/Login', '/login'), {
      'post /login': editLayerPage({
        layer: { key: 'Users/Edit', base: '/users' },
      }),
      '/users': () => walk.answer(),
    })

    app.router.post('/login')
    await settled()

    expect((await app.basePage()).component).toBe('')
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
    expect(app.entry()).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
    })
    expect(app.sent()).toEqual(['post /login', 'get /users'])

    walk.release(users)
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
    expect(app.entry().layers).toMatchObject([{ key: 'Users/Edit', standalone: true }])
  })

  it('composes onto the page beneath a layer that is already open', async () => {
    const app = await open(users, {
      'post /users/5': editLayerPage({
        props: {
          user: { id: 5 },
          errors: { name: 'The name field is required.' },
        },
      }),
    })
    const before = ids(app)

    app.router.post('/users/5')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect((await app.basePage()).url).toBe('/users')
    expect(ids(app)).toEqual(before)
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      errors: { name: 'The name field is required.' },
    })
  })

  it('composes onto a layer that opened while the visit was in flight', async () => {
    const post = held()
    const app = await openAppSentCall(users, {
      'post /users/5': () => post.answer(),
      '/users/5/edit': editLayerPage(),
    })

    app.router.post('/users/5')
    await settled()
    app.router.layer('/users/5/edit')
    await settled()

    const before = ids(app)

    post.release(editLayerPage({ props: { user: { id: 5 }, errors: {} } }))
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
    expect(ids(app)).toEqual(before)
  })

  it('composes onto the stack when a visit from inside it comes back as a different layer', async () => {
    const app = await open(users, { 'post /users/5/promote': teams })

    app.router.post('/users/5/promote')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit', 'Teams/Show'])
  })
})

describe('the base a visit is dispatched from', () => {
  it('is the page on screen', async () => {
    const app = await openAppSync(usersIndex, {
      '/users/archive': archive,
      '/users/5': hold,
    })

    app.router.visit('/users/archive')
    await settled()
    expect(app.basePage().component).toBe('Users/Archive')
    expect(baseGen(app)).toBe(1)

    app.router.visit('/users/5')
    await vi.waitFor(() => expect(requestsOf(app.router)).toHaveLength(1))

    expect(requestsOf(app.router)[0].origin).toEqual({
      kind: 'base',
      top: null,
      gen: 1,
      instantGen: null,
    })
  })

  it('is the base before an instant swap replaces it', async () => {
    const app = await openAppSync(usersIndex, { '/users/5': hold })

    app.router.visit('/users/5', { component: 'Users/Show' })
    await vi.waitFor(() => expect(requestsOf(app.router)).toHaveLength(1))

    expect(app.basePage().component).toBe('Users/Show')
    expect(baseGen(app)).toBe(1)
    expect(requestsOf(app.router)[0].origin).toEqual({
      kind: 'base',
      top: null,
      gen: 0,
      instantGen: 1,
    })
  })

  it('is the page on screen when a prefetched response is replayed, not the one it was prefetched from', async () => {
    const app = await openAppSync(usersIndex, {
      '/users/5': plainShow,
      '/users/archive': archive,
    })

    app.router.prefetch('/users/5', {}, { cacheFor: '30s' })
    await vi.waitFor(() => expect(cached(app)).toHaveLength(1))

    const prefetched = await cached(app)[0].response

    expect(prefetched.origin).toEqual({
      kind: 'base',
      top: null,
      gen: 0,
      instantGen: null,
    })

    app.router.visit('/users/archive')
    await settled()
    expect(baseGen(app)).toBe(1)

    app.router.visit('/users/5')

    await vi.waitFor(() =>
      expect(prefetched.origin).toEqual({
        kind: 'base',
        top: null,
        gen: 1,
        instantGen: null,
      }),
    )
  })

  it('is the base before an instant swap when the response was prefetched', async () => {
    const app = await openAppSync(usersIndex, {
      '/users/5': plainShow,
      '/users/archive': archive,
    })

    app.router.prefetch('/users/5', {}, { cacheFor: '30s' })
    await vi.waitFor(() => expect(cached(app)).toHaveLength(1))

    const prefetched = await cached(app)[0].response

    app.router.visit('/users/archive')
    await settled()
    expect(baseGen(app)).toBe(1)

    app.router.visit('/users/5', { component: 'Users/Show' })

    await vi.waitFor(() =>
      expect(prefetched.origin).toEqual({
        kind: 'base',
        top: null,
        gen: 1,
        instantGen: 2,
      }),
    )
    expect(baseGen(app)).toBe(2)
  })
})
