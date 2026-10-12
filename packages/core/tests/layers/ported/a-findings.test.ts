import { describe, expect, it } from 'vitest'
import { held, scenario, settled, type Answer, type App, type Route } from './a-support'

const users = (overrides: Answer = {}): Answer => ({
  component: 'Users/Index',
  url: '/users',
  props: { users: [] },
  version: null,
  ...overrides,
})

const editLayer = (props: Record<string, unknown>): Answer =>
  users({
    component: 'Users/Edit',
    url: '/users/5/edit',
    layer: { key: 'Users/Edit', base: '/users' },
    props,
  })

const visited = (app: App, url: string, options: Record<string, unknown> = {}): Promise<void> =>
  new Promise((resolve) => {
    app.router.visit(url, {
      ...options,
      onSuccess: () => resolve(),
      onError: () => resolve(),
    } as never)
  })

describe('a partial reload with a cold layer open', () => {
  it("merges a cold layer's props when a partial is answered by the layer, keeping its siblings", async () => {
    const walk = held()
    const routes: Record<string, Route> = {
      'post /login': editLayer({ user: { id: 5 } }),
      '/users': () => walk.answer(),
    }
    const app = await scenario(users({ component: 'Auth/Login', url: '/login' }), routes)

    await visited(app, '/login', { method: 'post' })
    await settled()

    expect((await app.basePage()).component).toBe('')

    const [layer] = app.layers()

    routes['/users/5/edit'] = editLayer({ stats: [1, 2, 3] })
    await visited(app, '/users/5/edit', { only: ['stats'] })
    await settled()

    expect(app.layers().map((open) => open.id)).toEqual([layer.id])
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      stats: [1, 2, 3],
    })
    expect((await app.basePage()).component).toBe('')
  })
})
