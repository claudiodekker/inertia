import { describe, expect, it, vi } from 'vitest'
import { page, scenario, settled, type Answer, type Route } from './support/a-support'

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
  const app = await scenario(initial, {
    '/users/5/edit': editLayerPage(),
    '/teams/9': teams,
    ...routes,
  })

  app.router.visit('/users/5/edit')
  await settled()

  return app
}

const ids = (app: Awaited<ReturnType<typeof scenario>>) => app.layers().map((layer) => layer.id)

describe('a client visit aimed at a layer', () => {
  const holdLayer = async () => {
    const app = await open(users, {
      '/users/5/edit': editLayerPage({
        props: { user: { id: 5 }, todos: [1], errors: {} },
      }),
    })

    return { app, layer: app.router.layerHandle()! }
  }

  it("replaceProp changes the layer's own props, not the page's", async () => {
    const { app, layer } = await holdLayer()

    layer.router.replaceProp('todos', [7])
    await settled()

    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      todos: [7],
      errors: {},
    })
    expect((await app.basePage()).props).toEqual({ users: [], errors: {} })
  })

  it('leaves the scroll of the page beneath alone', async () => {
    const { app, layer } = await holdLayer()
    const { Scroll } = await import('../../../src/scroll')
    const reset = vi.spyOn(Scroll, 'reset')

    layer.router.push({ props: { user: { id: 9 } } })
    await settled()

    expect(reset).not.toHaveBeenCalled()
    expect(app.views()[0].page.props).toEqual({ user: { id: 9 } })
  })

  it('still resets the scroll when it is aimed at the page', async () => {
    const { app } = await holdLayer()
    const { Scroll } = await import('../../../src/scroll')
    const reset = vi.spyOn(Scroll, 'reset')

    app.router.push({ props: { users: [] } })
    await settled()

    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('a push keeps the stack and the base generation', async () => {
    const { app, layer } = await holdLayer()
    const before = ids(app)

    layer.router.push({
      url: '/users/5/edit?step=2',
      props: { user: { id: 5 }, step: 2 },
    })
    await settled()

    expect(app.layers().map((open) => [open.key, open.url])).toEqual([['Users/Edit', '/users/5/edit?step=2']])
    expect(ids(app)).toEqual(before)
    expect(app.views()[0].page.props).toMatchObject({ step: 2 })
    expect((await app.basePage()).props).toEqual({ users: [], errors: {} })
    expect((await app.basePage()).url).toBe('/users')
  })

  it('a replace keeps the stack and the base generation', async () => {
    const { app, layer } = await holdLayer()
    const before = ids(app)

    layer.router.replace({ props: { user: { id: 9 } } })
    await settled()

    expect(app.layers().map((open) => open.key)).toEqual(['Users/Edit'])
    expect(ids(app)).toEqual(before)
    expect(app.views()[0].page.props).toMatchObject({ user: { id: 9 } })
    expect((await app.basePage()).props).toEqual({ users: [], errors: {} })
  })

  it('does not write a stale layer id onto the page it installs', async () => {
    const { app } = await holdLayer()

    app.router.push({ url: '/reports', props: { users: [{ id: 9 }] } })
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(await app.basePage()).not.toHaveProperty('layerId')
  })

  it('carries the layer errors it brings into onError', async () => {
    const { layer } = await holdLayer()
    const outcome: unknown[] = []

    layer.router.replace({
      props: (layerProps) => ({
        ...layerProps,
        errors: { note: 'The note is required.' },
      }),
      onError: (errors) => outcome.push(['error', errors]),
      onSuccess: () => outcome.push(['success']),
    })
    await settled()

    expect(outcome).toEqual([['error', { note: 'The note is required.' }]])
  })

  it("hands the props function the layer's onceProps", async () => {
    const app = await open(users, {
      '/users/5/edit': editLayerPage({
        props: { user: { id: 5 }, layerProp: 'layer value', errors: {} },
        onceProps: { layerKey: { prop: 'layerProp' } },
      }),
    })
    let receivedOnce: unknown

    app.router.layerHandle()!.router.replace({
      props: (layerProps, onceProps) => {
        receivedOnce = onceProps

        return layerProps
      },
    })
    await settled()

    expect(receivedOnce).toEqual({ layerProp: 'layer value' })
  })

  it("does not fall back to the page's errors", async () => {
    const app = await open(
      page('Users/Index', '/users', {
        props: { users: [], errors: { name: 'The name is required.' } },
      }),
      {
        '/users/5/edit': editLayerPage({
          props: { user: { id: 5 }, todos: [1], errors: {} },
        }),
      },
    )
    const outcome: unknown[] = []

    app.router.layerHandle()!.router.replace({
      props: (layerProps) => ({ ...layerProps, todos: [7] }),
      onError: (errors) => outcome.push(['error', errors]),
      onSuccess: () => outcome.push(['success']),
    })
    await settled()

    expect(outcome).toEqual([['success']])
  })

  it('applies and announces flash on the layer', async () => {
    const { app, layer } = await holdLayer()
    const announced: unknown[] = []

    layer.router.replace({
      props: (layerProps) => ({ ...layerProps, todos: [7] }),
      flash: { message: 'Saved.' },
      onFlash: (flash) => announced.push(flash),
    })
    await settled()

    expect(announced).toEqual([{ message: 'Saved.' }])
    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })
    expect((await app.basePage()).flash).toEqual({})
  })

  it('clears the flash a layer was already showing, rather than announcing it a second time', async () => {
    const { app, layer } = await holdLayer()
    const announced: unknown[] = []

    layer.router.replace({ flash: { message: 'Saved.' } })
    await settled()
    layer.router.replace({
      props: (layerProps) => ({ ...layerProps, todos: [7] }),
      onFlash: (flash) => announced.push(flash),
    })
    await settled()

    expect(announced).toEqual([])
    expect(app.views()[0].page.flash).toEqual({})
  })
})
