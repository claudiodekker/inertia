import { afterEach, describe, expect, it, vi } from 'vitest'
import { keysHeld, page, seedKeys, settled, start, cached } from './support/f-support'
import { users, type Answer } from './support/layers-fixtures'
import { ported } from './support/support'

const usersIndex = page('Users/Index', '/users', {
  props: { errors: {}, users: [] },
})

const editOverUsers = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit', base: '/users' },
  props: { errors: {}, user: { id: 5 } },
})

const show = page('Users/Show', '/users/5', {
  props: { errors: {}, users: [] },
})

const plainShow = page('Users/Show', '/users/5')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('encrypting the history entry a stack leaves behind', () => {
  const secret = {
    ...editOverUsers,
    encryptHistory: true,
    props: { errors: {}, user: { id: 5 } },
  }

  const openedOver = async (base: typeof usersIndex, layer: typeof editOverUsers) => {
    const app = await start(base, { '/users/5/edit': layer })

    app.router.layer('/users/5/edit')
    await settled()

    return { app, entry: window.history.state.page as unknown }
  }

  it('encrypts the entry when only the layer asks for it', async () => {
    const { entry } = await openedOver(usersIndex, secret)

    expect(entry).toBeInstanceOf(ArrayBuffer)
  })

  it('encrypts the entry when only the base asks for it', async () => {
    const { entry } = await openedOver({ ...usersIndex, encryptHistory: true }, editOverUsers)

    expect(entry).toBeInstanceOf(ArrayBuffer)
  })

  it('leaves the entry readable when neither asks for it', async () => {
    const { entry } = await openedOver(usersIndex, editOverUsers)

    expect(entry).not.toBeInstanceOf(ArrayBuffer)
    expect((entry as { layers: unknown[] }).layers).toEqual([
      expect.objectContaining({ props: { errors: {}, user: { id: 5 } } }),
    ])
  })

  it('restores the whole stack from an entry a layer had encrypted', async () => {
    const { app, entry } = await openedOver(usersIndex, secret)

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
    const app = await start(usersIndex, {
      '/users/5': { ...show, encryptHistory: true },
    })

    app.router.visit('/users/5')
    await settled()

    expect(window.history.state.page).toBeInstanceOf(ArrayBuffer)
  })

  it('leaves a page with no layers that does not ask for it readable', async () => {
    const app = await start(usersIndex, { '/users/5': show })

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
    const app = await start(usersIndex, {
      '/users/5/edit': { ...editOverUsers, clearHistory: true },
    })

    seedKeys(app)
    app.router.layer('/users/5/edit')
    await settled()

    expect(keysHeld(app)).toBe(false)
  })

  it('keeps them when neither the base nor the layer asks', async () => {
    const app = await start(usersIndex, { '/users/5/edit': editOverUsers })

    seedKeys(app)
    app.router.layer('/users/5/edit')
    await settled()

    expect(keysHeld(app)).toBe(true)
  })

  it('does not discard them again when a second layer opens over one that asked', async () => {
    const app = await start(usersIndex, {
      '/users/5/edit': { ...editOverUsers, clearHistory: true },
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
    const app = await start(usersIndex, {
      '/users/5/edit': { ...editOverUsers, clearHistory: true },
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

describe('encryptsHistory', () => {
  const encrypted = (app: Awaited<ReturnType<typeof ported>>) => app.rawEntry() instanceof ArrayBuffer

  const stacked = async (base: Answer, ...layers: Answer[]) => {
    const routes: Record<string, Answer> = {}

    layers.forEach((layer, index) => {
      routes[`/l${index}`] = page(`L${index}`, `/l${index}`, { layer: { key: `L${index}`, base: '/users' }, ...layer })
    })

    const app = await ported({ ...users, ...base }, routes)

    for (let index = 0; index < layers.length; index++) {
      app.router.visit(`/l${index}`)
      await settled()
    }

    return app
  }

  it('is false for a page nobody asked to encrypt', async () => {
    const app = await ported(users, {})

    expect(app.entry()).toMatchObject({ component: 'Users/Index', url: '/users' })
    expect(encrypted(app)).toBe(false)
  })

  it('is true for a page that asks for it', async () => {
    const app = await ported({ ...users, encryptHistory: true }, {})

    expect(encrypted(app)).toBe(true)
  })

  it('is false when neither the base nor its layer asks for it', async () => {
    const app = await stacked({}, {})

    expect(app.layers()).toHaveLength(1)
    expect(encrypted(app)).toBe(false)
  })

  it('is true when only the layer asks for it', async () => {
    const app = await stacked({}, { encryptHistory: true })

    expect(app.layers()).toHaveLength(1)
    expect(encrypted(app)).toBe(true)
  })

  it('is true when only the base asks for it', async () => {
    const app = await stacked({ encryptHistory: true }, {})

    expect(app.layers()).toHaveLength(1)
    expect(encrypted(app)).toBe(true)
  })

  it('is true when any layer in the stack asks for it', async () => {
    const app = await stacked({}, {}, { encryptHistory: true }, {})

    expect(app.layers()).toHaveLength(3)
    expect(encrypted(app)).toBe(true)
  })

  it('reads a layer with no encryptHistory of its own as not asking', async () => {
    const app = await stacked({}, {})

    expect(app.views()[0].page).not.toHaveProperty('encryptHistory')
    expect(encrypted(app)).toBe(false)
  })

  it('still reads the base beneath a layer with no encryptHistory of its own', async () => {
    const app = await stacked({ encryptHistory: true }, {})

    expect(app.views()[0].page).not.toHaveProperty('encryptHistory')
    expect(encrypted(app)).toBe(true)
  })
})

describe('clearing history', () => {
  const logout = page('Auth/Logout', '/logout', { clearHistory: true })

  it('discards the keys when the page asks', async () => {
    const app = await start(usersIndex, { '/logout': logout })

    seedKeys(app)
    app.router.visit('/logout')
    await settled()

    expect(app.basePage().component).toBe('Auth/Logout')
    expect(keysHeld(app)).toBe(false)
  })

  it('keeps them when the page does not ask', async () => {
    const app = await start(usersIndex, { '/users/5': plainShow })

    seedKeys(app)
    app.router.visit('/users/5')
    await settled()

    expect(app.basePage().component).toBe('Users/Show')
    expect(keysHeld(app)).toBe(true)
  })

  it('leaves no pending request on the entry it writes', async () => {
    const app = await start(usersIndex, { '/logout': logout })

    app.router.visit('/logout')
    await settled()

    expect(app.written().at(-1)).toEqual(['push', '/logout'])
    expect(app.entry().clearHistory).toBe(true)
  })

  it('does not discard them again when a client visit rewrites the page', async () => {
    const app = await start(usersIndex, { '/logout': logout })

    app.router.visit('/logout')
    await settled()
    seedKeys(app)

    await new Promise<void>((resolve) => {
      app.router.replace({
        props: { users: [{ id: 1 }] },
        onSuccess: () => resolve(),
      })
    })
    await settled()

    expect(keysHeld(app)).toBe(false)
  })

  it('still asks on a second visit, after the first one flushed its prefetch', async () => {
    const app = await start(usersIndex, { '/logout': logout })

    app.router.prefetch('/logout', {}, { cacheFor: '30s' })
    await vi.waitFor(() => expect(app.sent).toEqual(['get /logout']))

    const visit = () => new Promise<void>((resolve) => app.router.visit('/logout', { onSuccess: () => resolve() }))

    await visit()
    expect(cached(app)).toHaveLength(0)
    seedKeys(app)
    await visit()

    expect(app.sent).toEqual(['get /logout', 'get /logout'])
    expect(keysHeld(app)).toBe(false)
  })
})
