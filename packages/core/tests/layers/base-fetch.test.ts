import { describe, expect, it, vi } from 'vitest'
import { bench, byPath, gate, page, settled, type Bench } from './support/e-support'
import { layerAt, pageWith, world } from './support/walk-support'

const login = pageWith({ component: 'Auth/Login', url: '/login' })

const from = (href = 'http://localhost/login') => ({ href })

const plainUsers = page('Users/Index', '/users')

const plainLogin = page('Auth/Login', '/login')

const layerEdit = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

const components = (app: Bench) => app.layers().map((layer) => layer.component)

describe('the walk a cold layer sends for the base beneath it', () => {
  it('does not interrupt a visit the user made while the walk is running', async () => {
    const w = await world({
      ...from(),
      routes: { '/users/5': 'hold', '/dashboard': 'hold', '/users': 'hold' },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    const onCancel = vi.fn()
    w.router.visit('/dashboard', { onCancel })
    await vi.waitFor(() => expect(w.held.has('/dashboard')).toBe(true))

    await w.answer('/users/5', layerAt('/users/5', 'Users/Show', '/users'))
    await vi.waitFor(() => expect(w.held.has('/users')).toBe(true))

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('stops at the depth it is capped to, and warns', async () => {
    const steps = Object.fromEntries(
      Array.from({ length: 11 }, (_, step) => [
        `/step-${step + 1}`,
        layerAt(`/step-${step + 1}`, `Step/${step + 1}`, `/step-${step + 2}`),
      ]),
    )
    const w = await world({ ...from(), routes: steps })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await w.begin(login)
    await w.open(layerAt('/step-0', 'Step/0', '/step-1'))

    expect(w.requested).toHaveLength(10)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      'A layer chain more than 10 layers deep was declared, so "/step-10" was not fetched. The deepest layer that loaded is being used as the page.',
    )
    expect((await w.base()).component).toBe('Step/9')
    expect(w.layers()).toHaveLength(9)

    warn.mockRestore()
  })
})

describe('a walk hop landing', () => {
  const cold = { ...layerEdit, layer: { key: 'Users/Edit', base: '/users' } }

  it('fills in the blank base beneath the stack', async () => {
    const walk = gate()
    const app = await bench(plainLogin, byPath({ '/login': cold, '/users': () => walk.opened.then(() => plainUsers) }))

    app.router.visit('/login')
    await settled()

    const [open] = app.layers()

    expect(await app.basePage()).toMatchObject({ component: '' })

    walk.open()
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(app.layers()).toEqual([open])
    expect(app.entry()).toMatchObject({
      component: 'Users/Index',
      layers: [{ id: open.id }],
    })
  })

  it('inserts a base that is itself a layer beneath the stack and keeps walking', async () => {
    const walk = gate()
    const app = await bench(
      plainLogin,
      byPath({
        '/login': cold,
        '/users': { ...plainUsers, layer: { key: 'Users/Index', base: '/' } },
        '/': () => walk.opened.then(() => page('Home', '/')),
      }),
    )

    app.router.visit('/login')
    await settled()

    expect(components(app)).toEqual(['Users/Index', 'Users/Edit'])
    expect(await app.basePage()).toMatchObject({ component: '', url: '/' })
    expect(app.loadingFor).toEqual(['/users', '/'])
    expect(app.requests.map((request) => request.path)).toEqual(['/login', '/users', '/'])

    walk.open()
    await settled()

    expect(components(app)).toEqual(['Users/Index', 'Users/Edit'])
    expect(await app.basePage()).toMatchObject({ component: 'Home', url: '/' })
  })
})

describe('the walk a cold layer sends for the base beneath it', () => {
  it('does not re-announce flash the base is already holding when a hop lands', async () => {
    const w = await world({
      ...from(),
      routes: { '/users': 'hold', '/users/list': 'hold' },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    w.router.flash('message', 'Saved.')
    const announced = w.events.length

    await w.answer('/users', layerAt('/users', 'Users/Index', '/users/list'))

    expect(w.keys()).toEqual(['Users/Index', 'Users/Edit'])
    expect((await w.base()).flash).toEqual({ message: 'Saved.' })
    expect(w.events.slice(announced)).not.toContain('inertia:flash')
  })

  it('sends one hop for a base while a landing on the blank it is for arrives', async () => {
    const w = await world({
      ...from(),
      routes: { '/users': 'hold', '/users/5/edit': 'hold' },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    w.router.layerHandle()!.router.reload({ only: ['user'] })
    await vi.waitFor(() => expect(w.held.has('/users/5/edit')).toBe(true))
    await w.answer('/users/5/edit', layerAt('/users/5/edit', 'Users/Edit', '/users'))

    expect(w.requested.filter((path) => path === '/users')).toHaveLength(1)
    expect((await w.base()).component).toBe('')
  })

  it('stops when the base it is sent for is already on the stack', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', '/users/5/edit'),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect(w.requested).toEqual(['/login', '/users/5'])
    expect((await w.base()).component).toBe('Users/Show')
    expect((await w.base()).url).toBe('/users/5')
    expect(w.keys()).toEqual(['Users/Edit'])
  })

  it('stops when the base it is sent for is the same url written absolutely', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', 'http://localhost/users/5/edit'),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect(w.requested).toEqual(['/login', '/users/5'])
    expect((await w.base()).component).toBe('Users/Show')
    expect(w.keys()).toEqual(['Users/Edit'])
  })

  it('announces the errors the layer it promoted brought', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': {
          ...layerAt('/users/5', 'Users/Show', '/users/5/edit'),
          props: { errors: { team: 'The team field is required.' } },
        },
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect((await w.base()).component).toBe('Users/Show')
    expect((await w.base()).props.errors).toEqual({
      team: 'The team field is required.',
    })
    expect(w.events).toContain('inertia:error')
  })

  it('does not re-announce the flash the base was holding when the walk stops', async () => {
    const w = await world({ ...from(), routes: { '/users/5': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    w.router.flash('message', 'Saved.')
    const announced = w.events.length

    await w.answer('/users/5', layerAt('/users/5', 'Users/Show', '/users/5/edit'))

    expect((await w.base()).component).toBe('Users/Show')
    expect((await w.base()).flash).toEqual({})
    expect(w.events.slice(announced)).not.toContain('inertia:flash')
  })

  it('announces the flash a layer that opened over a base of its own brought', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open({
      ...layerAt('/users/5/edit', 'Users/Edit', '/users'),
      flash: { message: 'Saved.' },
    })

    expect(w.events).toContain('inertia:flash')
  })

  it('announces the flash once, and not again as the walk fills the stack beneath it', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': layerAt('/users', 'Users/Index', '/users/list'),
        '/users/list': pageWith({
          component: 'Users/List',
          url: '/users/list',
        }),
      },
    })
    await w.begin(login)
    await w.open({
      ...layerAt('/users/5/edit', 'Users/Edit', '/users'),
      flash: { message: 'Saved.' },
    })

    expect((await w.base()).component).toBe('Users/List')
    expect(w.events.filter((type) => type === 'inertia:flash')).toHaveLength(1)
  })

  it('asks for the base beneath it with the version the layer arrived on', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(pageWith({ component: 'Auth/Login', url: '/login', version: 'v0' }))
    await w.open({
      ...layerAt('/users/5/edit', 'Users/Edit', '/users'),
      version: 'v1',
    })

    expect(w.headers.get('/users')!['X-Inertia-Version']).toBe('v1')
  })

  it('records the url a redirected hop answered from on the layer it inserts', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5?tab=profile', 'Users/Show', '/users'),
        '/users': pageWith(),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect((await w.base()).component).toBe('Users/Index')
    expect(w.urls()).toEqual(['/users/5?tab=profile', '/users/5/edit'])
  })

  it('walks on from the page a hop was redirected to', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': {
          status: 409,
          data: '',
          headers: { 'x-inertia-redirect': 'http://localhost/users/list' },
        },
        '/users/list': pageWith({ url: '/users/list' }),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    expect(w.requested).toEqual(['/login', '/users', '/users/list'])
    expect((await w.base()).component).toBe('Users/Index')
    expect((await w.base()).url).toBe('/users/list')
    expect(w.keys()).toEqual(['Users/Edit'])
  })

  it('keeps walking for the base a layer closed mid-walk was standing on', async () => {
    const w = await world({
      ...from(),
      routes: { '/users': 'hold', '/users/list': 'hold' },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.dismiss()

    await w.answer('/users', layerAt('/users', 'Users/Index', '/users/list'))
    await vi.waitFor(() => expect(w.held.has('/users/list')).toBe(true))
    await w.answer('/users/list', pageWith({ component: 'Users/List', url: '/users/list' }))

    expect((await w.base()).component).toBe('Users/List')
    expect(w.keys()).toEqual(['Users/Index'])
  })
})
