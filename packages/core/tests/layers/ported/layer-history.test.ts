import { afterEach, describe, expect, it, vi } from 'vitest'
import { exitShells, keysHeld, page, seedKeys, settled, start } from './f-support'

const users = page('Users/Index', '/users', {
  props: { errors: {}, users: [] },
})
const edit = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit', base: '/users' },
  props: { errors: {}, user: { id: 5 } },
})
const show = page('Users/Show', '/users/5', {
  props: { errors: {}, users: [] },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the history entry a layer open leaves behind', () => {
  it('is pushed, so the entry the base sits on survives', async () => {
    const app = await start(users, { '/users/5/edit': edit })
    const before = app.written().length

    app.router.layer('/users/5/edit')
    await settled()

    expect(app.written().slice(before)).toEqual([['push', '/users/5/edit']])
  })

  it('is still replaced when a page lands where the user already is', async () => {
    const app = await start(users, {
      '/users': { ...users, props: { errors: {}, users: [{ id: 1 }] } },
    })
    const before = app.written().length

    app.router.visit('/users')
    await settled()

    expect(app.written().slice(before)).toEqual([['replace', '/users']])
    expect(app.basePage().props).toEqual({ errors: {}, users: [{ id: 1 }] })
  })

  it("carries the layer's address, so the address bar shows the layer", async () => {
    const app = await start(users, { '/users/5/edit': edit })
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
    const app = await start(users, { '/users/5': show })

    app.router.visit('/users/5')
    await settled()

    expect(app.written().at(-1)).toEqual(['push', '/users/5'])
    expect(app.entry().url).toBe('/users/5')
    expect(app.entry().layers).toBeUndefined()
  })

  it("serialises a layer's own fields onto the entry, and nothing more", async () => {
    const app = await start(users, { '/users/5/edit': edit })

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
    const app = await start(users, { '/users/5/edit': edit })

    app.router.layer('/users/5/edit')
    await settled()

    expect(app.entry().layers![0].entries).toBe(1)
  })

  it("keeps the layer's address when the page beneath it is rewritten in place", async () => {
    const app = await start(users, { '/users/5/edit': edit })

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
    const flashed = { ...users, flash: { message: 'Saved.' } }
    const app = await start(flashed, {
      '/users/5/edit': edit,
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
    const app = await start(users, {})
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

describe('a document loaded onto a back_forward entry holding a stack', () => {
  it('rewrites the entry it was handed rather than pushing another', async () => {
    const opened = await start(users, { '/users/5/edit': edit })
    const handle = opened.router.layer('/users/5/edit')

    await settled()

    const entry = opened.entry()
    const cold = await start(edit, { '/users': users }, { navigation: 'back_forward', entry, boot: true })

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
    const app = await start(users, {
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
    const app = await start(teams, { '/users': users, '/users/5/edit': edit })

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
  const notes = page('Users/Notes', '/users/5/notes', {
    layer: { key: 'Users/Notes', base: '/users' },
    props: { errors: {} },
  })

  const walkOnto = async (app: Awaited<ReturnType<typeof start>>, address: string) => {
    window.location.href = address
    app.popstate(null)
    await settled()
    await app.history.processQueue()
  }

  it("writes it onto the page's own url when there are no layers", async () => {
    const app = await start(users, {})
    const before = app.written().length

    await walkOnto(app, 'http://localhost/users#comments')

    expect(app.written().slice(before)).toEqual([['replace', 'http://localhost/users#comments']])
    expect(app.entry().url).toBe('http://localhost/users#comments')
  })
})

describe('encrypting the history entry a stack leaves behind', () => {
  const secret = {
    ...edit,
    encryptHistory: true,
    props: { errors: {}, user: { id: 5 } },
  }

  const openedOver = async (base: typeof users, layer: typeof edit) => {
    const app = await start(base, { '/users/5/edit': layer })

    app.router.layer('/users/5/edit')
    await settled()

    return { app, entry: window.history.state.page as unknown }
  }

  it('encrypts the entry when only the layer asks for it', async () => {
    const { entry } = await openedOver(users, secret)

    expect(entry).toBeInstanceOf(ArrayBuffer)
  })

  it('encrypts the entry when only the base asks for it', async () => {
    const { entry } = await openedOver({ ...users, encryptHistory: true }, edit)

    expect(entry).toBeInstanceOf(ArrayBuffer)
  })

  it('leaves the entry readable when neither asks for it', async () => {
    const { entry } = await openedOver(users, edit)

    expect(entry).not.toBeInstanceOf(ArrayBuffer)
    expect((entry as { layers: unknown[] }).layers).toEqual([
      expect.objectContaining({ props: { errors: {}, user: { id: 5 } } }),
    ])
  })

  it('restores the whole stack from an entry a layer had encrypted', async () => {
    const { app, entry } = await openedOver(users, secret)

    expect(entry).toBeInstanceOf(ArrayBuffer)

    const restored = (await app.history.decrypt(entry as never)) as unknown as {
      url: string
      layers: unknown[]
    }

    expect(restored.url).toBe('/users')
    expect(restored.layers).toEqual([
      expect.objectContaining({
        key: 'Users/Edit',
        props: { errors: {}, user: { id: 5 } },
        encryptHistory: true,
      }),
    ])

    await app.history.writeEntry(restored as never, '/users', 'replace')

    expect(window.history.state.page).toBeInstanceOf(ArrayBuffer)
  })

  it('still encrypts a page with no layers that asks for it', async () => {
    const app = await start(users, {
      '/users/5': { ...show, encryptHistory: true },
    })

    app.router.visit('/users/5')
    await settled()

    expect(window.history.state.page).toBeInstanceOf(ArrayBuffer)
  })

  it('leaves a page with no layers that does not ask for it readable', async () => {
    const app = await start(users, { '/users/5': show })

    app.router.visit('/users/5')
    await settled()

    expect(window.history.state.page).not.toBeInstanceOf(ArrayBuffer)
    expect(app.entry().component).toBe('Users/Show')
  })
})

describe('clearing the history keys from a stack', () => {
  const second = page('Teams/Show', '/teams/9', {
    layer: { key: 'Teams/Show', base: '/users' },
  })

  it('discards them when the layer asks to clear history', async () => {
    const app = await start(users, {
      '/users/5/edit': { ...edit, clearHistory: true },
    })

    seedKeys(app)
    app.router.layer('/users/5/edit')
    await settled()

    expect(keysHeld(app)).toBe(false)
  })

  it('keeps them when neither the base nor the layer asks', async () => {
    const app = await start(users, { '/users/5/edit': edit })

    seedKeys(app)
    app.router.layer('/users/5/edit')
    await settled()

    expect(keysHeld(app)).toBe(true)
  })

  it('does not discard them again when a second layer opens over one that asked', async () => {
    const app = await start(users, {
      '/users/5/edit': { ...edit, clearHistory: true },
      '/teams/9': second,
    })

    app.router.layer('/users/5/edit')
    await settled()
    seedKeys(app)
    app.router.layer('/teams/9')
    await settled()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit', 'Teams/Show'])
    expect(keysHeld(app)).toBe(true)
  })

  it('does not discard them again when the page beneath a layer that asked is rewritten', async () => {
    const app = await start(users, {
      '/users/5/edit': { ...edit, clearHistory: true },
    })

    app.router.layer('/users/5/edit')
    await settled()
    seedKeys(app)

    await new Promise<void>((resolve) => {
      app.router.replace({
        props: { users: [{ id: 1 }] },
        onSuccess: () => resolve(),
      })
    })
    await settled()

    expect(keysHeld(app)).toBe(true)
  })
})

describe('the address the events report', () => {
  const eventDetail = (app: Awaited<ReturnType<typeof start>>, name: string) =>
    app.fired.findLast((event) => event.type === `inertia:${name}`)!.detail

  it("gives inertia:navigate the layer's address, while the page it carries keeps its own url", async () => {
    const app = await start(users, { '/users/5/edit': edit })

    app.router.layer('/users/5/edit')
    await settled()

    expect(window.location.pathname).toBe('/users/5/edit')
    expect(eventDetail(app, 'navigate').page.url).toBe('/users/5/edit')
  })

  it("gives inertia:navigate the page's own url when there are no layers", async () => {
    const app = await start(users, { '/users/5': show })

    app.router.visit('/users/5')
    await settled()

    expect(eventDetail(app, 'navigate').page.url).toBe('/users/5')
  })

  it('gives inertia:success the layer it landed in, address and page alike', async () => {
    const app = await start(users, { '/users/5/edit': edit })

    app.router.visit('/users/5/edit')
    await settled()

    expect(window.location.pathname).toBe('/users/5/edit')
    expect(eventDetail(app, 'success').page.url).toBe('/users/5/edit')
    expect(eventDetail(app, 'success').page.props.user).toEqual({ id: 5 })
  })

  it("hands onSuccess the layer's own props, not the page's beneath it", async () => {
    const app = await start(users, { '/users/5/edit': edit })

    const landed = await new Promise<{
      component: string
      props: Record<string, unknown>
    }>((resolve) => {
      app.router.visit('/users/5/edit', { onSuccess: (page) => resolve(page) })
    })

    expect(landed.component).toBe('Users/Edit')
    expect(landed.props).toEqual({ errors: {}, user: { id: 5 } })
  })

  it("gives inertia:success the page's own url when there are no layers", async () => {
    const app = await start(users, { '/users/5': show })

    app.router.visit('/users/5')
    await settled()

    expect(eventDetail(app, 'success').page.url).toBe('/users/5')
  })
})
