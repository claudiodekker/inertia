import { describe, expect, it, vi, afterEach } from 'vitest'
import { exitShells, openAppSentCall, openAppSync, type SyncApp, openApp } from './support/app'
import { page, settled } from './support/browser'
import { users } from './support/pages'

const usersPage = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const layer = (name: string, url: string) => page(name, url, { layer: { key: name, base: '/users' } })

const usersAt = (url = '/users') => page('Users/Index', url, { props: { errors: {}, users: [] } })

const editOver = (base: string) =>
  page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit', base }, props: { errors: {}, user: { id: 5 } } })

const usersIndex = page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const editOverUsers = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit', base: '/users' },
  props: { errors: {}, user: { id: 5 } },
})

const notes = page('Users/Notes', '/users/5/notes', {
  layer: { key: 'Users/Notes', base: '/users' },
  props: { errors: {} },
})

const walkOnto = async (app: SyncApp, address: string) => {
  window.location.href = address
  app.popstate(null)
  await settled()
  await app.history.processQueue()
}

const show = page('Users/Show', '/users/5', {
  props: { errors: {}, users: [] },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('history entry counting', () => {
  it('counts the entry against the layer that owns the address', async () => {
    const app = await openApp(usersPage(), { '/a': layer('A', '/a') })

    app.router.visit('/a')
    await settled()
    await app.anchor('/a#top')

    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)

    expect(app.entry().layers![0].entries).toBe(2)

    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([-2])
  })

  it('gives the entry back when the browser refused to write it', async () => {
    const app = await openApp(usersPage(), {
      '/a': layer('A', '/a'),
      '/users': usersPage(),
    })
    const reloads: string[] = []
    const pushState = window.history.pushState

    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get: () => 'http://localhost/users',
      set: (value: string) => void reloads.push(value),
    })
    window.history.pushState = () => {
      const error = new Error('quota')

      error.name = 'QuotaExceededError'
      throw error
    }

    app.router.visit('/a')
    await settled()
    window.history.pushState = pushState

    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)
    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([])
  })
})

describe('the entry a page commit writes while a stack is open', () => {
  it('pushes the page a navigation lands when it drops a layer that owned the address', async () => {
    const app = await openAppSentCall(usersAt(), { '/users/5/edit': editOver('/users'), '/users': usersAt() })

    app.router.visit('/users/5/edit')
    await settled()

    const before = app.written().length

    app.router.visit('/users')
    await settled()

    expect(app.layers()).toEqual([])
    expect(app.written().slice(before)).toEqual([['push', '/users']])
  })

  it('rewrites the entry when a navigation to the very same page drops a layer that owned no address', async () => {
    const app = await openAppSentCall(usersAt(), { '/users': usersAt() })

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.entry().layers).toHaveLength(1)

    const before = app.written().length

    app.router.visit('/users')
    await settled()

    expect(app.layers()).toEqual([])
    expect(app.written().slice(before)).toEqual([['replace', '/users']])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('charges the top layer for the entry a refresh pushes beneath a stack that owns no address', async () => {
    const app = await openAppSentCall(usersAt(), { '/users?page=2': usersAt('/users?page=2') })

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.entry().layers!.map((layer) => layer.entries)).toEqual([1])

    app.router.visit('/users?page=2', { only: ['users'], preserveState: true, preserveScroll: true })
    await settled()

    expect(app.written().at(-1)).toEqual(['push', '/users?page=2'])
    expect(app.entry().layers!.map((layer) => layer.entries)).toEqual([2])
  })

  it('gives the entry back when the browser refuses the push a refresh makes beneath a stack', async () => {
    const app = await openAppSentCall(usersAt(), { '/users?page=2': usersAt('/users?page=2') })
    const pushState = window.history.pushState
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    app.router.layer({ component: 'Prompt' })
    await settled()
    window.history.pushState = () => {
      throw Object.assign(new Error('Too many calls to history.pushState'), { name: 'SecurityError' })
    }

    app.router.visit('/users?page=2', { only: ['users'], preserveState: true, preserveScroll: true })
    await settled()
    window.history.pushState = pushState
    logged.mockRestore()

    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)
    void app.router.close()
    await settled()
    exitShells(app)
    await settled()

    expect(deltas).toEqual([-1])
  })
})

describe('the history entry a layer open leaves behind', () => {
  it('gives the count back when the browser refuses the entry', async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusal = new Error('Attempt to use history.pushState() more than 100 times per 10 seconds')

    refusal.name = 'SecurityError'
    vi.spyOn(window.history, 'pushState').mockImplementation(() => {
      throw refusal
    })

    const handle = app.router.layer('/users/5/edit')

    await settled()

    vi.mocked(window.history.pushState).mockRestore()
    app.router.layerHandle(handle.id)!.router.remember({ note: 'x' }, 'note')
    await settled()

    expect(error).toHaveBeenCalledWith(refusal.message)
    expect(app.entry().layers![0].entries).toBe(0)
  })

  it('is pushed, so the entry the base sits on survives', async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })
    const before = app.written().length

    app.router.layer('/users/5/edit')
    await settled()

    expect(app.written().slice(before)).toEqual([['push', '/users/5/edit']])
  })

  it('is still replaced when a page lands where the user already is', async () => {
    const app = await openAppSync(usersIndex, {
      '/users': { ...usersIndex, props: { errors: {}, users: [{ id: 1 }] } },
    })
    const before = app.written().length

    app.router.visit('/users')
    await settled()

    expect(app.written().slice(before)).toEqual([['replace', '/users']])
    expect(app.basePage().props).toEqual({ errors: {}, users: [{ id: 1 }] })
  })

  it("carries the layer's address, so the address bar shows the layer", async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    expect(app.written().at(-1)).toEqual(['push', '/users/5/edit'])
    expect(window.location.pathname).toBe('/users/5/edit')
    expect(app.entry()).toMatchObject({
      url: '/users',
      layers: [{ id: handle.id, url: '/users/5/edit' }],
    })
  })

  it("carries the page's own url when there are no layers", async () => {
    const app = await openAppSync(usersIndex, { '/users/5': show })

    app.router.visit('/users/5')
    await settled()

    expect(app.written().at(-1)).toEqual(['push', '/users/5'])
    expect(app.entry().url).toBe('/users/5')
    expect(app.entry().layers).toBeUndefined()
  })

  it("serialises a layer's own fields onto the entry, and nothing more", async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })

    app.router.layer('/users/5/edit')
    await settled()

    expect(Object.keys(app.entry().layers![0]).sort()).toEqual([
      'component',
      'deferredProps',
      'entries',
      'id',
      'key',
      'onceProps',
      'owner',
      'props',
      'rememberedState',
      'rescuedProps',
      'scrollProps',
      'type',
      'url',
      'version',
    ])
  })

  it('counts the entry it pushed against the layer that owns the address', async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })

    app.router.layer('/users/5/edit')
    await settled()

    expect(app.entry().layers![0].entries).toBe(1)
  })

  it("keeps the layer's address when the page beneath it is rewritten in place", async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })

    app.router.layer('/users/5/edit')
    await settled()

    const before = app.written().length

    await new Promise<void>((resolve) => {
      app.router.replace({
        props: { users: [{ id: 1 }] },
        onSuccess: () => resolve(),
      })
    })
    await settled()

    expect(app.written().slice(before)).toEqual([['replace', '/users/5/edit']])
    expect(app.basePage().props).toEqual({ users: [{ id: 1 }] })
  })

  it('leaves the flash off the entry a close rewrites in place', async () => {
    const flashed = { ...usersIndex, flash: { message: 'Saved.' } }
    const app = await openAppSync(flashed, {
      '/users/5/edit': editOverUsers,
      '/users': flashed,
    })
    const handle = app.router.layer('/users/5/edit', { replace: true })
    let closed = false

    await settled()
    handle.onClose(() => (closed = true))

    const replaceState = vi.spyOn(window.history, 'replaceState')
    const closing = handle.close()

    exitShells(app)
    await closing
    await vi.waitFor(() => expect(closed).toBe(true))

    expect(app.basePage().flash).toEqual({ message: 'Saved.' })
    expect(replaceState.mock.calls.length).toBeGreaterThan(0)
    expect(
      replaceState.mock.calls.map(([state]) => (state as { page: { flash: unknown } }).page.flash),
    ).not.toContainEqual({
      message: 'Saved.',
    })
  })

  it("rewrites in place with the page's own url when there are no layers", async () => {
    const app = await openAppSync(usersIndex, {})
    const before = app.written().length

    await new Promise<void>((resolve) => {
      app.router.replace({
        props: { users: [{ id: 1 }] },
        onSuccess: () => resolve(),
      })
    })
    await settled()

    expect(app.written().slice(before)).toEqual([['replace', '/users']])
  })
})

describe('a hash the browser wrote', () => {
  it('writes it onto the layer that owns the address, leaving the base beneath it alone', async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })

    app.router.layer('/users/5/edit')
    await settled()

    const before = app.written().length

    await walkOnto(app, 'http://localhost/users/5/edit#comments')

    expect(app.written().slice(before)).toEqual([['replace', 'http://localhost/users/5/edit#comments']])
    expect(app.entry()).toMatchObject({ url: '/users', layers: [{ url: 'http://localhost/users/5/edit#comments' }] })
  })

  it('writes it onto the layer beneath one with no url of its own', async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers, '/users/5/notes': notes })

    app.router.layer('/users/5/edit')
    await settled()
    app.router.layer('/users/5/notes', { preserveUrl: true })
    await settled()

    const before = app.written().length

    await walkOnto(app, 'http://localhost/users/5/edit#comments')

    expect(app.written().slice(before)).toEqual([['replace', 'http://localhost/users/5/edit#comments']])
    expect(app.entry()).toMatchObject({
      url: '/users',
      layers: [{ url: 'http://localhost/users/5/edit#comments' }, { url: '/users/5/notes' }],
    })
  })
})

describe('a document loaded onto a back_forward entry holding a stack', () => {
  it('rewrites the entry it was handed rather than pushing another', async () => {
    const opened = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })
    const handle = opened.router.layer('/users/5/edit')

    await settled()

    const entry = opened.entry()
    const cold = await openAppSync(
      editOverUsers,
      { '/users': usersIndex },
      { navigation: 'back_forward', entry, boot: true },
    )

    await settled()

    expect(cold.written().map(([mode]) => mode)).not.toContain('push')
    expect(cold.written().length).toBeGreaterThan(0)
    expect(cold.layers()).toEqual([
      {
        id: handle.id,
        key: 'Users/Edit',
        component: 'Users/Edit',
        url: '/users/5/edit',
        type: 'routed',
      },
    ])
  })
})

describe('the base beneath a stack a restore moves', () => {
  const step = page('Users/Edit', '/users/5/edit/two', {
    layer: { key: 'Users/Edit', base: '/users' },
    props: { errors: {}, user: { id: 5 } },
  })

  it('is left alone when a back step moves within the layer above it', async () => {
    const app = await openAppSync(usersIndex, {
      '/users/5/edit/one': { ...step, url: '/users/5/edit/one' },
      '/users/5/edit/two': step,
    })
    const handle = app.router.layer('/users/5/edit/one')

    await settled()
    app.router.layerHandle(handle.id)!.router.visit('/users/5/edit/two')
    await settled()

    expect(app.entry().layers![0]).toMatchObject({
      id: handle.id,
      url: '/users/5/edit/two',
      entries: 2,
    })

    app.swaps.length = 0
    window.history.back()
    await settled()

    expect(app.swaps).toEqual([])
    expect(app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(app.layers()).toEqual([
      {
        id: handle.id,
        key: 'Users/Edit',
        component: 'Users/Edit',
        url: '/users/5/edit/one',
        type: 'routed',
      },
    ])
    expect(window.location.pathname).toBe('/users/5/edit/one')
  })

  it('is remade when the restore lands on another page altogether', async () => {
    const teams = page('Teams/Index', '/teams')
    const app = await openAppSync(teams, { '/users': usersIndex, '/users/5/edit': editOverUsers })

    app.router.visit('/users')
    await settled()
    app.router.layer('/users/5/edit')
    await settled()
    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit'])

    app.swaps.length = 0
    window.history.go(-2)
    await settled()

    expect(app.swaps).toEqual([{ component: 'Teams/Index', preserveState: false }])
    expect(app.layers()).toEqual([])
  })
})

describe('the hash on an entry the browser wrote', () => {
  const walkOnto = async (app: Awaited<ReturnType<typeof openAppSync>>, address: string) => {
    window.location.href = address
    app.popstate(null)
    await settled()
    await app.history.processQueue()
  }

  it("writes it onto the page's own url when there are no layers", async () => {
    const app = await openAppSync(usersIndex, {})
    const before = app.written().length

    await walkOnto(app, 'http://localhost/users#comments')

    expect(app.written().slice(before)).toEqual([['replace', 'http://localhost/users#comments']])
    expect(app.entry().url).toBe('http://localhost/users#comments')
  })
})

describe('history entry counting', () => {
  const panel = page('A', '/a', { layer: { key: 'A', base: '/users' } })

  const unwound = () => {
    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)

    return deltas
  }

  it('never counts a layer below zero entries', async () => {
    const app = await openApp(users, { '/a': panel, '/users': users })

    app.router.visit('/a', { replace: true })
    await settled()

    expect(app.entry().layers![0].entries).toBe(0)

    const deltas = unwound()
    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([])
    expect(app.layers()).toEqual([])
  })

  it('does nothing on a page with no layers', async () => {
    const app = await openApp(users, { '/other': page('Other', '/other') })
    const before = structuredClone(await app.basePage())

    await app.router.close()
    await settled()

    expect(await app.basePage()).toEqual(before)
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.layers()).toEqual([])
  })
})
