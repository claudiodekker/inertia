import { describe, expect, it, vi } from 'vitest'
import { compose } from '../../src/layers/entry'
import { elsewhere, layerAt, pageWith, world, errorPage } from './support/base-fetch'
import { settled } from './support/browser'

const login = pageWith({ component: 'Auth/Login', url: '/login' })

const from = (href = 'http://localhost/login') => ({ href })

const teamsEntry = () =>
  compose(
    pageWith() as never,
    [
      {
        ...(pageWith({ component: 'Teams/Edit' }) as object),
        id: 'layer-9',
        key: 'Teams/Edit',
        type: 'routed',
        owner: null,
        entries: 1,
      },
    ] as never,
    false,
  ).data

describe('the walk a cold layer sends for the base beneath it', () => {
  it('sends the walk again when a close supersedes its landing while the base component resolves', async () => {
    let landTheImport!: () => void
    const importing = new Promise<void>((resolve) => (landTheImport = resolve))
    let imports = 0
    const w = await world({
      ...from(),
      routes: { '/users': pageWith() },
      component: (name) =>
        name === 'Users/Index' ? (++imports === 1 ? importing.then(() => ({ name })) : { name }) : { name },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    await w.dismiss()
    landTheImport()
    await vi.waitFor(() => expect(w.requested.filter((path) => path === '/users')).toHaveLength(2))
    await settled()

    const base = await w.base()

    expect(base.component).toBe('Users/Index')
    expect(w.layers()).toEqual([])
    expect(base.url).toBe('/users')
    expect(w.swaps.filter(({ component }) => component === 'Users/Index')).toHaveLength(1)
  })

  it('does not re-request the blank when the user has navigated away from the stack being walked', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': 'hold',
        '/dashboard': pageWith({ component: 'Dashboard', url: '/dashboard' }),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    const visit = vi.spyOn(w.router, 'visit')

    w.router.visit('/dashboard')
    await settled()
    await w.answer('/users', elsewhere)

    expect(w.events.filter((type) => type === 'inertia:location')).toHaveLength(1)
    expect((await w.base()).component).toBe('Dashboard')
    expect(w.layers()).toEqual([])
    expect(visit).toHaveBeenCalledTimes(1)
  })
})

describe('the walk a cold layer sends for the base beneath it', () => {
  it('drops a hop that lands after the user has navigated away', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': 'hold',
        '/dashboard': pageWith({ component: 'Dashboard', url: '/dashboard' }),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    w.router.visit('/dashboard')
    await settled()
    await w.answer('/users', pageWith())

    expect((await w.base()).component).toBe('Dashboard')
    expect(w.layers()).toEqual([])
  })

  it('drops a hop that lands after the user has gone back', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    w.popstate({ page: login })
    await settled()
    await w.answer('/users', pageWith())

    expect((await w.base()).component).toBe('Auth/Login')
    expect(w.layers()).toEqual([])
  })

  it('lands on the layer it has when a hop comes back as an error page', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    expect((await w.base()).component).toBe('Users/Edit')
    expect((await w.base()).url).toBe('/users/5/edit')
    expect(w.layers()).toEqual([])
    expect(w.overlay).not.toHaveBeenCalled()
  })

  it('lands on the layer it has when a hop is answered by an error page the application rendered', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.refuse(
      '/users',
      new w.errors.HttpResponseError('Request failed with status code 500', {
        status: 500,
        data: JSON.stringify(
          pageWith({
            component: 'Error',
            url: '/users',
            props: { status: 500 },
          }),
        ),
        headers: { 'x-inertia': 'true' },
      }),
    )

    expect((await w.base()).component).toBe('Users/Edit')
    expect(w.layers()).toEqual([])
  })

  it('lands on the layer it has when a hop never answers', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.refuse('/users', new w.errors.HttpNetworkError('Network Error', 'http://localhost/users'))

    expect((await w.base()).component).toBe('Users/Edit')
    expect(w.layers()).toEqual([])
  })

  it('lands on the deepest layer it resolved when a hop further down fails', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', '/users'),
        '/users': 'hold',
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    expect((await w.base()).component).toBe('Users/Show')
    expect(w.keys()).toEqual(['Users/Edit'])
  })

  it('still composes a visit made from inside the stack when a failed hop lands', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', '/users'),
        '/users': 'hold',
        '/users/5/edit': 'hold',
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    w.router.visit('/users/5/edit', { method: 'put' })
    await vi.waitFor(() => expect(w.held.has('/users/5/edit')).toBe(true))

    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))
    expect((await w.base()).component).toBe('Users/Show')
    await w.answer('/users/5/edit', layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect((await w.base()).component).toBe('Users/Show')
    expect(w.keys()).toEqual(['Users/Edit'])
  })

  it('does not land a failed hop on a stack the user went back to', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    w.popstate({ page: teamsEntry() })
    await settled()
    expect((await w.base()).component).toBe('Users/Index')
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    expect((await w.base()).component).toBe('Users/Index')
    expect(w.keys()).toEqual(['Teams/Edit'])
  })

  it('does not land a location-answered hop on a stack the user went back to', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    w.popstate({ page: teamsEntry() })
    await settled()
    expect((await w.base()).component).toBe('Users/Index')
    await w.answer('/users', elsewhere)

    expect((await w.base()).component).toBe('Users/Index')
    expect(w.keys()).toEqual(['Teams/Edit'])
  })

  it('installs the base via a re-request when the stack it was walking for has been closed', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.dismiss()

    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))
    await vi.waitFor(() => expect(w.requested.filter((path) => path === '/users')).toHaveLength(2))
    await w.answer('/users', pageWith())

    expect(w.swaps.at(-1)).toEqual({
      component: 'Users/Index',
      preserveState: true,
    })
    expect((await w.base()).component).toBe('Users/Index')
  })

  it('re-requests the blank base the closed layer was standing on, replacing its entry', async () => {
    const w = await world({
      href: 'http://localhost/users/5/edit',
      routes: { '/users': 'hold' },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.dismiss()

    const installed = w.swaps.length
    const pushes = w.writes.filter(({ mode }) => mode === 'push').length
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))
    await vi.waitFor(() => expect(w.requested.filter((path) => path === '/users')).toHaveLength(2))
    await w.answer('/users', pageWith())

    const base = await w.base()

    expect(base.component).toBe('Users/Index')
    expect(base.props).toEqual({ users: [] })
    expect(base.url).toBe('/users')
    expect(w.swaps.slice(installed)).toEqual([{ component: 'Users/Index', preserveState: true }])
    expect(w.writes.filter(({ mode }) => mode === 'push')).toHaveLength(pushes)
    expect(w.writes.at(-1)!.mode).toBe('replace')
    expect(w.writes.at(-1)!.state.page.component).toBe('Users/Index')
    expect(w.writes.at(-1)!.state.page.layers).toBeUndefined()
  })

  it('does not resurrect a layer that is mid-close when its hop fails, and re-requests the base', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    const closing = w.router.close()
    await settled()

    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    expect((await w.base()).component).toBe('')

    await vi.waitFor(() => expect(w.requested.filter((path) => path === '/users')).toHaveLength(2))
    await w.answer('/users', pageWith())

    const base = await w.base()

    expect(base.component).toBe('Users/Index')
    expect(base.url).toBe('/users')
    expect(w.core.layerSlot.views().map((view) => view.shell.open)).toEqual([false])
    expect(w.core.layerSlot.topPage()).toBeNull()

    w.routes.set('/users', pageWith())
    w.exit()
    await closing
    await settled()

    expect(w.layers()).toEqual([])
    expect((await w.base()).component).toBe('Users/Index')
  })

  it('shows the error dialog when the recovery re-request itself fails', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.dismiss()

    const installed = w.swaps.length
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))
    await vi.waitFor(() => expect(w.requested.filter((path) => path === '/users')).toHaveLength(2))
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    await vi.waitFor(() => expect(w.overlay).toHaveBeenCalled())

    expect(w.swaps.slice(installed)).toHaveLength(0)
    expect((await w.base()).component).toBe('')
  })

  it('does not land a failed hop into a stack the user has already left', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': 'hold',
        '/dashboard': pageWith({ component: 'Dashboard', url: '/dashboard' }),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    const visit = vi.spyOn(w.router, 'visit')

    w.router.visit('/dashboard')
    await settled()
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    expect((await w.base()).component).toBe('Dashboard')
    expect(w.layers()).toEqual([])
    expect(visit).toHaveBeenCalledTimes(1)
  })

  it('leaves an open stack alone when a background visit is answered on a new version', async () => {
    const w = await world({
      href: 'http://localhost/users',
      routes: {
        '/teams/edit': layerAt('/teams/edit', 'Teams/Edit', '/users'),
        '/teams': elsewhere,
      },
    })
    await w.begin(pageWith())
    w.router.layer('/teams/edit')
    await settled()
    expect(w.keys()).toEqual(['Teams/Edit'])

    await new Promise<void>((resolve) => w.router.visit('/teams', { async: true, onFinish: () => resolve() }))
    await settled()

    expect((await w.base()).component).toBe('Users/Index')
    expect(w.keys()).toEqual(['Teams/Edit'])
  })

  it('lands on the layer it has when a hop is answered on a new version', async () => {
    const w = await world({ ...from(), routes: { '/users': elsewhere } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    expect((await w.base()).component).toBe('Users/Edit')
    expect(w.layers()).toEqual([])
    expect(window.location.href).toBe('http://localhost/users/5/edit')
  })
})
