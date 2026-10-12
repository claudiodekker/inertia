import { describe, expect, it } from 'vitest'
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

describe('resolving a page with layers', () => {
  it('resolves every layer and hands them to the adapter in stack order', async () => {
    const app = await open()

    app.router.visit('/teams/9')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.views().map((view) => [view.id, view.component])).toEqual([
      [app.layers()[0].id, { name: 'Users/Edit' }],
      [app.layers()[1].id, { name: 'Teams/Show' }],
    ])
    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit', 'Teams/Show'])
  })

  it('keeps the rest of the layer state beside the resolved component', async () => {
    const app = await scenario(users, {
      '/users/5/edit': page('Users/Edit', '/users/5/edit', {
        props: { user: { id: 5 }, errors: {} },
        layer: { key: 'Users/Edit', base: '/users' },
      }),
    })

    app.router.visit('/users/5/edit')
    await settled()

    const [{ id }] = app.layers()

    expect(app.views()).toHaveLength(1)
    expect(app.views()[0]).toMatchObject({
      id,
      renderKey: 1,
      component: { name: 'Users/Edit' },
      page: {
        component: 'Users/Edit',
        url: '/users/5/edit',
        props: { user: { id: 5 }, errors: {} },
      },
      attributes: {
        'data-layer-id': id,
        style: { viewTransitionName: `inertia-layer-${id}` },
      },
      shell: {
        open: true,
        index: 0,
        isTop: true,
        type: 'routed',
        close: expect.any(Function),
        done: expect.any(Function),
      },
    })
    expect(app.views()[0].scope.id).toBe(id)
  })

  it('passes no layers for an ordinary page', async () => {
    const app = await scenario(users, {
      '/users/7': page('Users/Show', '/users/7'),
    })

    app.router.visit('/users/7')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Show')
    expect(app.views()).toEqual([])
    expect(app.layers()).toEqual([])
  })
})

describe('an ordinary response', () => {
  it('is passed through untouched, with no layers key', async () => {
    const app = await scenario(users, {
      '/users/5': page('Users/Show', '/users/5'),
    })

    app.router.visit('/users/5')
    await settled()

    expect(app.layers()).toEqual([])
    expect(await app.basePage()).not.toHaveProperty('layers')
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.entry()).toMatchObject({
      component: 'Users/Show',
      url: '/users/5',
    })
  })
})
