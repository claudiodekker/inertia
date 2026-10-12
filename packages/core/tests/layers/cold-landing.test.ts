import { describe, expect, it, vi } from 'vitest'
import { planBoot } from '../../src/layers/entry'
import { openAppSentCall } from './support/app'
import { layerAt, world, elsewhere, errorPage, pageWith } from './support/base-fetch'
import { page, settled } from './support/browser'

const editOver = (base: string) =>
  page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit', base }, props: { errors: {}, user: { id: 5 } } })

const document = 'http://localhost/users/5/edit'

const login = pageWith({ component: 'Auth/Login', url: '/login' })

const from = (href = 'http://localhost/login') => ({ href })

describe('a layer that declares its own url as its base, landing in session', () => {
  it('lands as an ordinary page and sends for no base', async () => {
    const app = await openAppSentCall(page('Auth/Login', '/login'), { '/users/5': editOver('/users/5/edit') })

    app.router.visit('/users/5')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(app.layers()).toEqual([])
    expect(app.sent()).toEqual(['get /users/5'])
    expect(app.written().at(-1)).toEqual(['push', '/users/5/edit'])
  })
})

describe('the base fetch a cold layer sends for the base beneath it', () => {
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
      expect(w.events.indexOf('inertia:flash')).toBeGreaterThan(w.events.indexOf('inertia:navigate'))
    })
  })

  it('opens the layer over a base that has not arrived yet', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    const base = await w.base()

    expect(base.component).toBe('')
    expect(base.url).toBe('/users')
    expect(w.layers()).toEqual([
      {
        id: w.layers()[0].id,
        key: 'Users/Edit',
        component: 'Users/Edit',
        url: '/users/5/edit',
        type: 'routed',
      },
    ])
    expect(w.core.layerSlot.views()[0].page).not.toHaveProperty('layer')

    await w.answer('/users', pageWith())

    expect(w.entry().layers).toEqual([
      expect.objectContaining({
        key: 'Users/Edit',
        url: '/users/5/edit',
        standalone: true,
      }),
    ])
  })

  it("writes the layer's address before the base beneath it has been fetched", async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    const before = w.writes.length

    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    expect(w.writes.slice(before).map(({ mode, url }) => [mode, url])).toEqual([['push', '/users/5/edit']])
  })

  it('keeps the address on the top layer even when the visit asked to preserve the url', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    const before = w.writes.length

    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'), {
      preserveUrl: true,
    })

    expect(w.urls()).toEqual(['/users/5/edit'])
    expect(w.keys()).toEqual(['Users/Edit'])
    expect(w.writes.slice(before).map(({ mode, url }) => [mode, url])).toEqual([['push', '/users/5/edit']])
  })

  it('resolves a two-deep cold open in three requests, top down', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', '/users'),
        '/users': pageWith(),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect(w.requested).toEqual(['/login', '/users/5', '/users'])
    expect((await w.base()).component).toBe('Users/Index')
    expect((await w.base()).url).toBe('/users')
    expect(w.keys()).toEqual(['Users/Show', 'Users/Edit'])
  })

  it('marks every layer it resolves standalone', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', '/users'),
        '/users': pageWith(),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect(w.entry().layers!.map((layer) => layer.standalone)).toEqual([true, true])
  })

  it('pushes one history entry for the whole base fetch, however deep it goes', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', '/users'),
        '/users': pageWith(),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    expect(w.writes.filter(({ mode }) => mode === 'push').map(({ url }) => url)).toEqual(['/users/5/edit'])
  })

  it('does not fetch a base for a layer that declares no base at all', async () => {
    const w = await world(from())
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit'))

    expect(w.requested).toEqual(['/login'])
    expect((await w.base()).component).toBe('Users/Edit')
    expect(w.layers()).toEqual([])
  })

  it('does not reload the page when a base fetch request comes back as a location visit on a new version', async () => {
    const w = await world({ ...from(), routes: { '/users': elsewhere } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    expect(w.requested).toEqual(['/login', '/users'])
    expect(window.location.href).toBe('http://localhost/users/5/edit')
  })

  it('writes the layer onto the entry, not the base that is still being fetched', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    const [{ state }] = w.writes.filter(({ mode }) => mode === 'push')

    expect(state.page.component).toBe('Users/Edit')
    expect(state.page.url).toBe('/users/5/edit')
    expect(state.page.layers).toBeUndefined()
  })

  it('writes the whole stack onto the entry once the base beneath it has arrived', async () => {
    const w = await world({ ...from(), routes: { '/users': pageWith() } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    const { mode, state } = w.writes.at(-1)!

    expect(mode).toBe('replace')
    expect(state.page.component).toBe('Users/Index')
    expect(state.page.layers).toEqual([expect.objectContaining({ key: 'Users/Edit' })])
  })

  it('writes the deepest layer it has reached onto the entry as the base fetch goes deeper', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': layerAt('/users', 'Users/Index', '/users/list'),
        '/users/list': 'hold',
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    const { mode, state } = w.writes.at(-1)!

    expect(w.keys()).toEqual(['Users/Index', 'Users/Edit'])
    expect(mode).toBe('replace')
    expect(state.page.component).toBe('Users/Index')
    expect(state.page.layers).toEqual([expect.objectContaining({ key: 'Users/Edit' })])
  })

  it('opens a warm layer on top of the stack a cold open fetched', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': pageWith(),
        '/users/5/notes': layerAt('/users/5/notes', 'Notes/Edit', '/users/5'),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    w.router.visit('/users/5/notes')
    await settled()

    expect((await w.base()).component).toBe('Users/Index')
    expect(w.keys()).toEqual(['Users/Edit', 'Notes/Edit'])
    expect(w.entry().layers!.map((layer) => layer.standalone)).toEqual([true, undefined])
  })

  it('rewrites a cold layer in place when a warm visit brings its key back', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users': pageWith(),
        '/users/5/edit': pageWith({
          component: 'Users/Edit',
          url: '/users/5/edit',
          layer: { key: 'Users/Edit', base: '/users' },
          props: { user: { id: 5, name: 'Renamed' } },
        }),
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    const [cold] = w.layers()

    w.router.visit('/users/5/edit')
    await settled()

    expect(w.layers()).toEqual([cold])
    expect(w.entry().layers![0].standalone).toBe(true)
    expect(w.core.layerSlot.views()[0].page.props).toEqual({
      user: { id: 5, name: 'Renamed' },
    })
  })

  it('does not land the entry on a layer the user has dismissed', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    await w.dismiss()

    const { mode, state } = w.writes.at(-1)!

    expect(mode).toBe('push')
    expect(state.page.component).toBe('')
    expect(state.page.url).toBe('/users')
    expect(state.page.layers).toBeUndefined()
    expect(w.layers()).toEqual([])
  })

  it('lands on the entry the stack was already written to', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    const before = w.writes.length
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    expect((await w.base()).component).toBe('Users/Edit')
    expect(
      w.writes
        .slice(before)
        .filter(({ mode }) => mode === 'push')
        .map(({ url }) => url),
    ).toEqual(['/users/5/edit'])
  })

  it('lands without remounting the stack above it or moving the scroll', async () => {
    const w = await world({
      ...from(),
      routes: {
        '/users/5': layerAt('/users/5', 'Users/Show', '/users'),
        '/users': 'hold',
      },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users/5'))

    const above = w.core.layerSlot.views().at(-1)!
    const scrollTo = vi.spyOn(window, 'scrollTo')
    await w.refuse('/users', new w.errors.HttpResponseError('Request failed with status code 500', errorPage))

    expect((await w.base()).component).toBe('Users/Show')
    expect(w.swaps.at(-1)).toEqual({
      component: 'Users/Show',
      preserveState: false,
    })
    expect(w.core.layerSlot.views()).toEqual([expect.objectContaining({ id: above.id, renderKey: above.renderKey })])
    expect(scrollTo).not.toHaveBeenCalled()
  })

  describe('when the layer arrives on the initial page', () => {
    const document = 'http://localhost/users/5/edit'

    it('opens the layer over a base that has not arrived yet, and sends for it', async () => {
      const w = await world({ href: document, routes: { '/users': 'hold' } })
      const plan = await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users'))

      const base = await w.base()

      expect(base.component).toBe('')
      expect(base.url).toBe('/users')
      expect(w.layers()).toEqual([
        {
          id: w.layers()[0].id,
          key: 'Users/Edit',
          component: 'Users/Edit',
          url: '/users/5/edit',
          type: 'routed',
        },
      ])
      expect(plan.declaredBase).toBe('/users')
      expect(w.requested).toEqual(['/users'])

      await w.answer('/users', pageWith())

      expect(w.entry().layers).toEqual([
        expect.objectContaining({
          key: 'Users/Edit',
          url: '/users/5/edit',
          standalone: true,
        }),
      ])
    })

    it('fetches on down to the page the chain stands on', async () => {
      const w = await world({
        href: document,
        routes: {
          '/users': layerAt('/users', 'Users/Index', '/users/list'),
          '/users/list': pageWith({
            component: 'Users/List',
            url: '/users/list',
          }),
        },
      })
      await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users'))

      expect(w.requested).toEqual(['/users', '/users/list'])
      expect((await w.base()).component).toBe('Users/List')
      expect(w.keys()).toEqual(['Users/Index', 'Users/Edit'])
    })

    it("writes the layer's address onto the entry the document arrived on", async () => {
      const w = await world({ href: document, routes: { '/users': 'hold' } })
      await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users'))

      expect(w.writes.filter(({ mode }) => mode === 'push')).toEqual([])
      expect(w.writes.map(({ mode, url }) => [mode, url])).toContainEqual(['replace', '/users/5/edit'])
    })

    it('keeps the hash the browser is on when the router is initialised without the app factory', async () => {
      const w = await world({ href: 'http://localhost/users#profile' })
      await w.begin(pageWith())

      expect((await w.base()).url).toBe('/users#profile')
    })

    it('keeps the hash the browser is on with the layer that owns the address', async () => {
      const w = await world({
        href: `${document}#profile`,
        routes: { '/users': 'hold' },
      })
      await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users'), '#profile')

      expect(w.urls()).toEqual(['/users/5/edit#profile'])
      expect((await w.base()).url).toBe('/users')
    })

    it('renders a layer that declares no base as an ordinary page', async () => {
      const w = await world({ href: document })
      await w.boot(layerAt('/users/5/edit', 'Users/Edit'))

      const base = await w.base()

      expect(base.component).toBe('Users/Edit')
      expect(base.url).toBe('/users/5/edit')
      expect(w.layers()).toEqual([])
      expect(base.layer).toBeUndefined()
      expect(w.requested).toEqual([])
    })

    it('lands on the layer it opened when the base beneath it cannot be fetched', async () => {
      const w = await world({ href: document, routes: { '/users': 'hold' } })
      await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users'))
      await w.refuse('/users', new w.errors.HttpNetworkError('Network Error', 'http://localhost/users'))

      const base = await w.base()

      expect(base.component).toBe('Users/Edit')
      expect(base.url).toBe('/users/5/edit')
      expect(w.layers()).toEqual([])
    })

    it('opens a layer the return leg of a location visit arrived with', async () => {
      const w = await world({ href: document, routes: { '/users': 'hold' } })
      w.session.set('inertiaLocationVisit', JSON.stringify({ preserveScroll: false }))
      await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users'))

      await vi.waitFor(() => expect(w.layers()).toHaveLength(1))
      expect((await w.base()).component).toBe('')
      expect(w.keys()).toEqual(['Users/Edit'])
      expect(w.requested).toEqual(['/users'])
    })

    it('writes the layer onto the entry while the base beneath it has not arrived', async () => {
      const w = await world({ href: document, routes: { '/users': 'hold' } })
      await w.boot(layerAt('/users/5/edit', 'Users/Edit', '/users'))

      const { state } = w.writes.at(-1)!

      expect(state.page.component).toBe('Users/Edit')
      expect(state.page.layers).toBeUndefined()
    })

    it('creates the same layer id on every initial page, so the server and client agree', () => {
      const first = planBoot(layerAt('/users/5/edit', 'Users/Edit', '/users') as never, '')
      const second = planBoot(layerAt('/users/5/edit', 'Users/Edit', '/users') as never, '')

      expect(first.layers.map((layer) => layer.row.id)).toEqual(['layer-boot-zyavpb'])
      expect(second.layers.map((layer) => layer.row.id)).toEqual(['layer-boot-zyavpb'])
    })

    it('installs an initial page that is not a layer exactly as it arrived', async () => {
      const w = await world({ href: document })
      const plan = await w.boot(pageWith())

      expect(plan.base).toEqual(pageWith({ flash: {}, rescuedProps: [], rememberedState: {} }))
      expect(await w.base()).toEqual({
        ...pageWith(),
        flash: {},
        rescuedProps: [],
        rememberedState: {},
      })
      expect(w.requested).toEqual([])
    })
  })
})
