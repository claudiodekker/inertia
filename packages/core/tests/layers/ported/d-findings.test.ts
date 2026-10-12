import { describe, expect, it, vi } from 'vitest'
import { settled } from '../runtime'
import { elsewhere, layerAt, pageWith, world } from './walk-support'

const login = pageWith({ component: 'Auth/Login', url: '/login' })
const from = (href = 'http://localhost/login') => ({ href })
const document = 'http://localhost/users/5/edit'

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

  it('re-requests a restored entry that holds no page, replacing it with the page fetched for its url', async () => {
    const w = await world({ href: document, routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.dismiss()

    const captured = w.writes.filter(({ mode }) => mode === 'push').at(-1)!.state
    const installed = w.swaps.length
    const pushes = w.writes.filter(({ mode }) => mode === 'push').length

    w.popstate(captured)
    await settled()

    expect(w.requested.filter((path) => path === '/users')).toHaveLength(2)

    await w.answer('/users', pageWith())

    const base = await w.base()

    expect(w.requested.filter((path) => path === '/users')).toHaveLength(2)
    expect(base.component).toBe('Users/Index')
    expect(base.props).toEqual({ users: [] })
    expect(base.url).toBe('/users')
    // The placeholder shows as the loading view while the page is fetched (a recorded difference).
    expect(w.swaps.slice(installed)).toEqual([
      { component: 'Blank', preserveState: false },
      { component: 'Users/Index', preserveState: true },
    ])
    expect(w.writes.filter(({ mode }) => mode === 'push')).toHaveLength(pushes)
    expect(w.writes.at(-1)!.mode).toBe('replace')
    expect(w.writes.at(-1)!.state.page.component).toBe('Users/Index')
    expect(w.writes.at(-1)!.state.page.layers).toBeUndefined()
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

  describe('when the layer arrives on the initial page', () => {
    it('does not send for a base a layer declares at its own url', async () => {
      const w = await world({ href: document })
      await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users/5/edit'))

      expect((await w.base()).component).toBe('Users/Edit')
      expect(w.layers()).toEqual([])
      expect(w.requested).toEqual([])
    })

    it('announces the flash the layer arrived with', async () => {
      const w = await world({ href: document, routes: { '/users': 'hold' } })
      await w.boot({
        ...layerAt('/users/5/edit', 'Users/Edit', '/users'),
        flash: { message: 'Saved.' },
      })

      expect(w.events.filter((type) => type === 'inertia:flash')).toHaveLength(1)
    })
  })
})
