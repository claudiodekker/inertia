import { describe, expect, it } from 'vitest'
import { bench, byPath, gate, page, settled, type Bench } from './support/e-support'
import { base, counted, edit, ported } from './support/layer-handles-support'

const plainUsers = page('Users/Index', '/users')

const layerEdit = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

const teamsIndex = page('Teams/Index', '/teams')

const components = (app: Bench) => app.layers().map((layer) => layer.component)

describe('a detour', () => {
  const prompt = page('Auth/Confirm', '/confirm', { interstitial: true })
  const card = page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit' },
  })

  const detour = async (routes: Parameters<typeof byPath>[0] = {}) => {
    let asked = 0
    const app = await bench(
      plainUsers,
      byPath({
        '/users/5/edit': () => (asked++ === 0 ? prompt : card),
        'post /confirm': prompt,
        '/teams': teamsIndex,
        ...routes,
      }),
    )
    const handle = app.router.layer('/users/5/edit')

    await settled()

    return { app, handle }
  }

  const wrongPassword = async (app: Bench) => {
    app.router.post('/confirm', { password: 'wrong' })
    await settled()
  }

  it('pins the base the layer was dispatched from through the prompt', async () => {
    const { app, handle } = await detour()

    expect(await app.basePage()).toMatchObject({
      component: 'Auth/Confirm',
      url: '/confirm',
    })
    expect(handle.state).toBe('pending')
    expect(app.layers()).toEqual([])
    expect(app.written().at(-1)).toEqual(['push', '/confirm'])
    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/edit'])

    app.router.visit('/users/5/edit')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/edit', '/users/5/edit'])
  })

  it('composes the returning layer over the pinned base', async () => {
    const { app, handle } = await detour()

    await wrongPassword(app)
    expect(await app.basePage()).toMatchObject({ component: 'Auth/Confirm' })
    expect(handle.state).toBe('pending')

    const writes = app.written().length

    app.router.visit('/users/5/edit')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(components(app)).toEqual(['Users/Edit'])
    expect(app.layers()[0].id).toBe(handle.id)
    expect(handle.state).toBe('open')
    expect(app.written().slice(writes)).toEqual([['replace', '/users/5/edit']])
    expect(app.entry()).toMatchObject({
      component: 'Users/Index',
      layers: [{ id: handle.id }],
    })

    app.router.visit('/teams')
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Teams/Index' })
    expect(app.layers()).toEqual([])
  })

  it('is ended by any unmarked page that lands', async () => {
    const held = gate()
    const { app, handle } = await detour({
      '/held': () => held.opened.then(() => card),
    })

    app.router.visit('/held', { async: true })
    await settled()
    app.router.visit('/teams')
    await settled()

    expect(await app.basePage()).toMatchObject({ component: 'Teams/Index' })
    expect(handle.state).toBe('closed')

    held.open()
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Teams/Index',
      url: '/teams',
    })
    expect(app.layers()).toEqual([])

    app.router.visit('/users/5/edit')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Teams/Index',
      url: '/teams',
    })
    expect(components(app)).toEqual(['Users/Edit'])
  })

  it('is kept by the prompt answering its own submit', async () => {
    const { app, handle } = await detour()

    await wrongPassword(app)
    await wrongPassword(app)

    expect(await app.basePage()).toMatchObject({ component: 'Auth/Confirm' })
    expect(handle.state).toBe('pending')

    app.router.visit('/users/5/edit')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(components(app)).toEqual(['Users/Edit'])
    expect(handle.state).toBe('open')
  })

  it('is left alone by a layer that is not the return', async () => {
    const { app, handle } = await detour({
      '/teams/1/edit': page('Teams/Edit', '/teams/1/edit', {
        layer: { key: 'Teams/Edit' },
      }),
    })

    app.router.visit('/teams/1/edit')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(components(app)).toEqual(['Teams/Edit'])
    expect(app.layers()[0].id).toBe(handle.id)
    expect(handle.state).toBe('open')
  })
})

describe('a layer open answered by an interstitial', () => {
  const prompt = (extra: Record<string, unknown> = {}) =>
    page('Auth/Sudo', '/sudo', { interstitial: true, props: { errors: {} }, ...extra })

  const answering = (...responses: ReturnType<typeof page>[]) => {
    const queue = [...responses]

    return () => Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0])
  }

  it('keeps the handle open, since the prompt returns to it', async () => {
    const app = await ported(base(), { '/users/5/edit': answering(prompt()) })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    expect((await app.basePage()).component).toBe('Auth/Sudo')
    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('pending')
  })

  it('fires onClose when the layer the prompt returned to is closed', async () => {
    const app = await ported(base(), { '/users/5/edit': answering(prompt(), edit()), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.visit('http://localhost/users/5/edit')
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(calls.closed).toBe(0)

    const closing = app.router.close(handle.id)
    await settled()
    app.exitShells()
    await closing
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
  })

  it('keeps the handle open when the prompt answers its own submit', async () => {
    const app = await ported(base(), {
      '/users/5/edit': answering(prompt(), edit()),
      'post /sudo': prompt({ props: { errors: { password: 'Wrong' } } }),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.visit('http://localhost/sudo', { method: 'post' })
    await settled()

    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('pending')
    expect((await app.basePage()).props).toEqual({ errors: { password: 'Wrong' } })

    app.router.visit('http://localhost/users/5/edit')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
  })

  it('fires onClose when a navigation away abandons the prompt', async () => {
    const app = await ported(base(), {
      '/users/5/edit': answering(prompt()),
      '/dashboard': page('Dashboard', '/dashboard'),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.visit('http://localhost/dashboard')
    await settled()

    expect(calls.closed).toBe(1)
    expect((await app.basePage()).component).toBe('Dashboard')
    expect(handle.state).toBe('closed')
  })

  it('closes the handle when the response is an ordinary page rather than a prompt', async () => {
    const app = await ported(base(), { '/users/5/edit': page('Auth/Login', '/login') })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect((await app.basePage()).component).toBe('Auth/Login')
  })

  it('gives the returned layer the page it lands on as its owner [BEHAVIOUR CHANGED]', async () => {
    const app = await ported(base(), { '/users/5/edit': answering(prompt(), edit()) })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()
    app.router.visit('http://localhost/users/5/edit')
    await settled()

    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [handle.id, null],
    ])
    expect(() => app.router.layerHandle(handle.id)!.emit('saved', { id: 5 })).not.toThrow()
  })
})
