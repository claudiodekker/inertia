import { describe, expect, it, afterEach, vi } from 'vitest'
import { exitShells, held, openAppSentCall, type SentCallApp, type Route, openAppSync } from './support/app'
import { page, settled } from './support/browser'

const index = (extra: Record<string, unknown> = {}) =>
  page('Users/Index', '/users', { props: { users: [], errors: {} }, ...extra })

const editWith = (extra: Record<string, unknown> = {}) =>
  page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  })

const open = async (initial: Record<string, unknown>, routes: Record<string, Route>, url = '/users/5/edit') => {
  const app = await openAppSentCall(initial, routes)

  app.router.visit(url)
  await settled()

  return app
}

const scopeOf = (app: SentCallApp, index = 0) => app.router.layerHandle(app.layers()[index].id)!

const hold = () => new Promise<never>(() => {})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('per-layer optimistic updates', () => {
  const base = () => index({ props: { users: [], todos: [10], errors: {} } })
  const layer = (todos: number[]) => editWith({ props: { user: { id: 5 }, todos, errors: {} } })

  it('passes the layer props to a layer-targeted optimistic callback and writes the layer', async () => {
    const app = await open(base(), { '/users/5/edit': layer([1]) })
    const received: unknown[] = []

    const pending = held()
    app.core.http.setClient({
      request: () =>
        pending.answer().then((answer) => ({
          status: 200,
          headers: { 'x-inertia': 'true' },
          data: JSON.stringify(answer),
        })),
    })
    scopeOf(app)
      .router.optimistic((props) => {
        received.push(props.todos)
        return { todos: [...(props.todos as number[]), 9] }
      })
      .visit('/users/5/edit')
    await settled()

    expect(received).toEqual([[1]])
    expect(app.views()[0].page.props.todos).toEqual([1, 9])

    pending.release(layer([2]))
    await settled()

    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      todos: [2],
      errors: {},
    })
    expect((await app.basePage()).props).toEqual({
      users: [],
      todos: [10],
      errors: {},
    })
  })

  it('rolls a failed layer optimistic back into the layer, never the base', async () => {
    const app = await open(base(), { '/users/5/edit': layer([1]) })
    const pending = held()

    app.core.http.setClient({
      request: () => pending.answer().then(() => ({ status: 500, data: 'boom', headers: {} })),
    })
    scopeOf(app)
      .router.optimistic((props) => ({
        todos: [...(props.todos as number[]), 9],
      }))
      .visit('/users/5/edit', {
        onHttpException: () => false,
        onError: () => {},
        onSuccess: () => {},
      })
    await settled()

    expect(app.views()[0].page.props.todos).toEqual([1, 9])
    expect((await app.basePage()).props.todos).toEqual([10])

    pending.release({})
    await settled()

    expect(app.views()[0].page.props.todos).toEqual([1])
    expect((await app.basePage()).props.todos).toEqual([10])
  })

  it('never injects a pending base optimistic into a landing layer response', async () => {
    const app = await open(base(), { '/users/5/edit': layer([1]) })
    const pending = held()

    app.core.http.setClient({
      request: async (config) => {
        if (config.url.includes('/users/5/edit')) {
          return {
            status: 200,
            data: JSON.stringify(layer([2])),
            headers: { 'x-inertia': 'true' },
          }
        }

        await pending.answer()

        return {
          status: 200,
          data: JSON.stringify(index({ props: { users: [], todos: [10, 9], errors: {} } })),
          headers: { 'x-inertia': 'true' },
        }
      },
    })

    app.router.optimistic((props) => ({ todos: [...(props.todos as number[]), 9] })).reload()
    await settled()
    expect((await app.basePage()).props.todos).toEqual([10, 9])

    scopeOf(app).router.visit('/users/5/edit', { only: ['todos'] })
    await settled()

    expect(app.views()[0].page.props.todos).toEqual([2])
    expect((await app.basePage()).props.todos).toEqual([10, 9])

    pending.release({})
  })

  it('drops a closed layer optimistic state instead of rolling it into the base', async () => {
    const app = await openAppSentCall(base(), {
      '/users/5/edit': editWith({
        layer: { key: 'Users/Edit', base: '/users' },
        props: { user: { id: 5 }, todos: [1], errors: {} },
      }),
      '/users': base(),
    })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    const pending = held()
    app.core.http.setClient({
      request: (config) =>
        config.url.endsWith('/users')
          ? Promise.resolve({
              status: 200,
              data: JSON.stringify(base()),
              headers: { 'x-inertia': 'true' },
            })
          : pending.answer().then(() => ({
              status: 200,
              data: JSON.stringify(editWith()),
              headers: { 'x-inertia': 'true' },
            })),
    })
    scopeOf(app)
      .router.optimistic((props) => ({
        todos: [...(props.todos as number[]), 9],
      }))
      .visit('/users/5/edit', { onError: () => {}, onSuccess: () => {} })
    await settled()

    expect(app.views()[0].page.props.todos).toEqual([1, 9])

    const closing = handle.close()
    exitShells(app)
    await closing
    await settled()

    expect(app.layers()).toEqual([])
    expect((await app.basePage()).props).toEqual({
      users: [],
      todos: [10],
      errors: {},
    })

    pending.release({})
    await settled()

    expect((await app.basePage()).props).toEqual({
      users: [],
      todos: [10],
      errors: {},
    })
  })
})

describe('a pending optimistic callback', () => {
  it('is consumed by the instance it was chained on, never by a visit from another', async () => {
    const edit = page('Users/Edit', '/users/5/edit', {
      layer: { key: 'Users/Edit', base: '/users' },
    })
    const app = await openAppSync(page('Users/Index', '/users', { props: { errors: {}, likes: 0 } }), {
      '/users/5/edit': edit,
      '/users': hold,
    })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    const first = new app.Router()
    const other = app.router.layerHandle(handle.id)!.router

    first.optimistic((props) => ({ likes: (props.likes as number) + 1 }))
    other.visit('/users')
    await settled()

    expect(app.basePage().props.likes).toBe(0)

    first.visit('/users')
    await settled()

    expect(app.basePage().props.likes).toBe(1)
  })
})
