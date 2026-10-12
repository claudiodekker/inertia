import { describe, expect, it, vi } from 'vitest'
import { page, settled, exitShells, held, scenario, type App, type Route } from './support/a-support'
import { bench, byPath } from './support/e-support'

const usersAt = (url = '/users') => page('Users/Index', url, { props: { errors: {}, users: [] } })

const editOver = (base: string) =>
  page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit', base }, props: { errors: {}, user: { id: 5 } } })

const index = (extra: Record<string, unknown> = {}) =>
  page('Users/Index', '/users', { props: { users: [], errors: {} }, ...extra })

const editWith = (extra: Record<string, unknown> = {}) =>
  page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  })

const open = async (initial: Record<string, unknown>, routes: Record<string, Route>, url = '/users/5/edit') => {
  const app = await scenario(initial, routes)

  app.router.visit(url)
  await settled()

  return app
}

const scopeOf = (app: App, index = 0) => app.router.layerHandle(app.layers()[index].id)!

const inertia = (answer: Record<string, unknown>) => ({
  status: 200,
  data: JSON.stringify(answer),
  headers: { 'x-inertia': 'true' },
})

describe('a placeholder whose component cannot be resolved', () => {
  it('opens no layer and closes the handle, and rejects as a page placeholder does', async () => {
    const app = await bench(usersAt(), byPath({ '/users/5/edit': editOver('/users') }), {
      resolve: (name) => (name === 'Missing' ? Promise.reject(new Error('Missing')) : { name }),
    })
    const listeners = process.listeners('unhandledRejection')
    const rejections: unknown[] = []
    let closed = false

    process.removeAllListeners('unhandledRejection')
    process.on('unhandledRejection', (reason) => void rejections.push(reason))

    const handle = app.router.layer('/users/5/edit', { component: 'Missing' })

    handle.onClose(() => (closed = true))
    await settled()
    process.removeAllListeners('unhandledRejection')
    listeners.forEach((listener) => process.on('unhandledRejection', listener))

    expect(rejections).toEqual([new Error('Missing')])
    expect(closed).toBe(true)
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
    expect(app.requests).toEqual([])

    app.router.layer('/users/5/edit')
    await settled()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit'])
  })
})

describe('an instant visit that opens a layer or is made from one', () => {
  const instant = { component: 'Users/Edit' }

  const stood = async (layer: Record<string, unknown> = {}) => {
    const next = held()
    let loads = 0
    const app = await open(index(), {
      '/users/5/edit': () => (++loads === 1 ? Promise.resolve(editWith(layer)) : new Promise(() => {})),
      '/users/9/edit': () => next.answer(),
      '/users': index(),
    })

    return { app, next }
  }

  it('rewrites the layer where it stands rather than fabricating a page over the stack', async () => {
    const { app } = await stood()
    const [layer] = app.layers()

    scopeOf(app).router.visit('/users/9/edit', instant)
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      props: { users: [], errors: {} },
    })
    expect(app.layers()).toEqual([
      {
        id: layer.id,
        key: 'Users/Edit',
        component: 'Users/Edit',
        url: '/users/9/edit',
        type: 'routed',
      },
    ])
  })

  it('leaves the base its identity, so the response it fetched still composes onto the stack', async () => {
    const { app, next } = await stood()
    const before = await app.basePage()

    scopeOf(app).router.visit('/users/9/edit', instant)
    await settled()

    expect(await app.basePage()).toBe(before)

    next.release(editWith({ url: '/users/9/edit', props: { user: { id: 9 }, errors: {} } }))
    await settled()

    expect(await app.basePage()).toBe(before)
    expect(app.views()[0].page.props).toEqual({ user: { id: 9 }, errors: {} })
  })

  it('does not fire the onClose of the layer it is swapping', async () => {
    const { app } = await stood()
    let closed = false

    scopeOf(app).onClose(() => (closed = true))
    scopeOf(app).router.visit('/users/9/edit', instant)
    await settled()

    expect(closed).toBe(false)
  })

  it('drops the record the layer was showing rather than carrying it into the placeholder', async () => {
    const { app } = await stood({
      props: { user: { id: 5 }, errors: {} },
      deferredProps: { default: ['history'] },
      onceProps: { token: { prop: 'token' } },
      scrollProps: { items: { pageName: 'page' } },
      rescuedProps: ['history'],
      flash: { message: 'Saved' },
    })

    scopeOf(app).router.visit('/users/9/edit', instant)
    await settled()

    const swapped = app.views()[0].page

    expect(swapped.props).toEqual({ errors: {} })
    expect(swapped.deferredProps).toEqual({})
    expect(swapped.onceProps).toEqual({})
    expect(swapped.scrollProps).toEqual({})
    expect(swapped.rescuedProps).toEqual([])
    expect(swapped.flash).toEqual({})
  })

  it('remakes the layer component for the record it is heading to', async () => {
    const { app } = await stood()
    const before = app.views()[0].renderKey

    scopeOf(app).router.visit('/users/9/edit', instant)
    await settled()

    expect(app.views()[0].renderKey).toBe(before + 1)
  })

  it('stacks a response under a different key as a new layer when no placeholder was fabricated', async () => {
    const { app } = await stood({ layer: { key: 'panel:first' } })
    const [first] = app.layers()
    const second = page('Layers/Panel', '/layers/panel/second', {
      layer: { key: 'panel:second' },
      props: { name: 'second', errors: {} },
    })

    app.core.http.setClient({ request: async () => inertia(second) })
    scopeOf(app).router.visit('/layers/panel/second')
    await settled()

    expect(app.layers().map((layer) => layer.key)).toEqual(['panel:first', 'panel:second'])
    expect(app.layers()[0].id).toBe(first.id)
  })

  it('lands the response on the layer it fabricated, keeping its component instance', async () => {
    const { app, next } = await stood()
    const [layer] = app.layers()

    scopeOf(app).router.visit('/users/9/edit', instant)
    await settled()

    const fabricated = app.views()[0].renderKey

    next.release(editWith({ url: '/users/9/edit', props: { user: { id: 9 }, errors: {} } }))
    await settled()

    expect(app.views()[0].page.props).toEqual({ user: { id: 9 }, errors: {} })
    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].renderKey).toBe(fabricated)
  })

  it('leaves the scroll of the page beneath alone', async () => {
    const { app } = await stood()
    const { Scroll } = await import('../../../src/scroll')
    const reset = vi.spyOn(Scroll, 'reset')

    scopeOf(app).router.visit('/users/9/edit', instant)
    await settled()

    expect(reset).not.toHaveBeenCalled()
  })

  it('still resets the scroll when it fabricates a page', async () => {
    const { app } = await stood()
    const { Scroll } = await import('../../../src/scroll')
    const reset = vi.spyOn(Scroll, 'reset')

    app.router.visit('/users/9/edit', instant)
    await settled()

    expect(reset).toHaveBeenCalled()
  })

  it('still fabricates a page when the visit names no layer', async () => {
    const { app } = await stood()

    app.router.visit('/users/9/edit', instant)
    await settled()

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(app.layers()).toEqual([])
  })

  it('lands a response keyed differently on the placeholder rather than beside it', async () => {
    const { app, next } = await stood({ layer: { key: 'panel:first' } })
    const [layer] = app.layers()

    scopeOf(app).router.visit('/layers/panel/second', {
      component: 'Layers/Panel',
    })
    app.core.http.setClient({
      request: () => next.answer().then(inertia),
    })
    await settled()

    next.release(
      page('Layers/Panel', '/layers/panel/second', {
        layer: { key: 'panel:second' },
        props: { name: 'second', errors: {} },
      }),
    )
    await settled()

    expect(app.layers()).toEqual([
      {
        id: layer.id,
        key: 'panel:second',
        component: 'Layers/Panel',
        url: '/layers/panel/second',
        type: 'routed',
      },
    ])
    expect(app.views()[0].page.props).toEqual({ name: 'second', errors: {} })
  })

  it('puts the placeholder up as a layer, leaving the page it opens on where it is', async () => {
    const next = held()
    const app = await scenario(index(), {
      '/users/5/edit': () => next.answer(),
    })

    app.router.layer('/users/5/edit', { component: 'Users/Edit' })
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
    })
    expect(app.layers().map((layer) => [layer.component, layer.url])).toEqual([['Users/Edit', '/users/5/edit']])
    expect(app.entry().layers!.map((layer) => layer.owner)).toEqual([null])
  })

  it('lands the response on the placeholder an open put up, under the id it created', async () => {
    const next = held()
    const app = await scenario(index(), {
      '/users/5/edit': () => next.answer(),
    })

    const handle = app.router.layer('/users/5/edit', {
      component: 'Users/Edit',
    })
    await settled()

    const fabricated = app.layers()[0]

    next.release(editWith())
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers()).toEqual([
      {
        id: fabricated.id,
        key: 'Users/Edit',
        component: 'Users/Edit',
        url: '/users/5/edit',
        type: 'routed',
      },
    ])
    expect(fabricated.id).toBe(handle.id)
    expect(handle.state).toBe('open')
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, errors: {} })
  })

  it('falls back to fabricating a page when the layer it names has already closed', async () => {
    const { app } = await stood()
    const gone = scopeOf(app)
    const closing = gone.close()

    exitShells(app)
    await closing
    await settled()
    app.core.http.setClient({ request: () => new Promise(() => {}) })

    gone.router.visit('/users/9/edit', instant)
    await settled()

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(app.layers()).toEqual([])
  })

  it("lands the answer to a closed layer's instant visit as it lands the page's own", async () => {
    const { app, next } = await stood()
    const gone = scopeOf(app)
    const closing = gone.close()

    exitShells(app)
    await closing
    await settled()

    gone.router.visit('/users/9/edit', instant)
    await settled()
    next.release(editWith({ url: '/users/9/edit', layer: { key: 'Users/Edit', base: '/users' } }))
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((layer) => layer.url)).toEqual(['/users/9/edit'])
  })
})
