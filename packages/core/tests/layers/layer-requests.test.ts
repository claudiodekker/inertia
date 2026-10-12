import { describe, expect, it } from 'vitest'
import { openAppSentCall, type SentCallApp, exitShells, held, type Route } from './support/app'
import { settled, type Answer, page } from './support/browser'

const pw = (overrides: Answer = {}): Answer => ({
  component: 'Users/Index',
  url: '/users',
  props: { users: [] },
  version: null,
  ...overrides,
})

const editLayer = (overrides: Answer = {}): Answer =>
  pw({
    component: 'Users/Edit',
    url: '/users/5/edit',
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 } },
    ...overrides,
  })

const notesLayer = (overrides: Answer = {}): Answer =>
  pw({
    component: 'Users/Notes',
    url: '/users/5/edit/notes',
    layer: { key: 'Users/Notes' },
    ...overrides,
  })

const visited = (app: SentCallApp, url: string, options: Record<string, unknown> = {}): Promise<void> =>
  new Promise((resolve) => {
    app.router.visit(url, {
      ...options,
      onSuccess: () => resolve(),
      onError: () => resolve(),
    } as never)
  })

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

const inertia = (answer: Record<string, unknown>) => ({
  status: 200,
  data: JSON.stringify(answer),
  headers: { 'x-inertia': 'true' },
})

describe('the prefetch cache shared between the page and its layers', () => {
  const openTwo = async () => {
    const app = await openAppSentCall(pw(), {
      '/users/5/edit': editLayer(),
      '/users/5/edit/notes': notesLayer(),
      '/users/5/edit?tab=2': editLayer({ url: '/users/5/edit?tab=2' }),
    })

    Object.assign(window, { setTimeout, clearTimeout })

    await visited(app, '/users/5/edit')
    await settled()
    await visited(app, '/users/5/edit/notes')
    await settled()

    return app
  }

  it('answers a lookup from the page or another layer with what a layer prefetched', async () => {
    const app = await openTwo()
    const [first, second] = app.layers()

    app.router.layerHandle(first.id)!.router.prefetch('/users/5/edit?tab=2', {}, { cacheFor: '30s' })
    await settled()

    expect(app.sent().at(-1)).toBe('get /users/5/edit?tab=2')
    expect(app.router.getCached('/users/5/edit?tab=2', {})).not.toBeNull()
    expect(app.router.layerHandle(second.id)!.router.getCached('/users/5/edit?tab=2', {})).not.toBeNull()
  })

  it('does not answer a lookup that asks for other props', async () => {
    const app = await openTwo()
    const [first] = app.layers()

    app.router.layerHandle(first.id)!.router.prefetch('/users/5/edit?tab=2', {}, { cacheFor: '30s' })
    await settled()

    expect(app.sent().at(-1)).toBe('get /users/5/edit?tab=2')
    expect(app.router.getCached('/users/5/edit?tab=2', { only: ['user'] })).toBeNull()
  })
})

describe('a reload or partial issued from inside a layer', () => {
  it("re-asks for the layer's own url when the reload carries the layer's id", async () => {
    const app = await open(index(), { '/users/5/edit': editWith() })

    scopeOf(app).router.reload({ only: ['user'] })
    await settled()

    expect(app.sent()).toEqual(['get /users/5/edit', 'get /users/5/edit'])
  })

  it('discards a reload the layer moved on from while it was in flight', async () => {
    const stale = held()
    let calls = 0
    const app = await open(index(), {
      '/users/5/edit': () => (++calls === 1 ? Promise.resolve(editWith()) : stale.answer()),
      '/users/6/edit': editWith({
        url: '/users/6/edit',
        props: { user: { id: 6 }, errors: {} },
      }),
    })

    scopeOf(app).router.reload()
    await settled()

    app.router.visit('/users/6/edit')
    await settled()

    stale.release(editWith({ props: { user: { id: 5 }, errors: {} } }))
    await settled()

    expect(app.layers().map((layer) => layer.url)).toEqual(['/users/6/edit'])
    expect(app.views()[0].page.props.user).toEqual({ id: 6 })
  })

  it('keeps a reload of a layer that stayed where it was while it was in flight', async () => {
    const pending = held()
    let calls = 0
    const app = await open(index(), {
      '/users/5/edit': () => (++calls === 1 ? Promise.resolve(editWith()) : pending.answer()),
    })

    scopeOf(app).router.reload()
    await settled()

    pending.release(editWith({ props: { user: { id: 5, seen: 1 }, errors: {} } }))
    await settled()

    expect(app.views()[0].page.props.user).toEqual({ id: 5, seen: 1 })
  })

  it('keeps the identity of the props a response left untouched, reading them off the layer', async () => {
    const app = await open(index(), { '/users/5/edit': editWith() })
    const untouched = app.views()[0].page.props.user

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.props.user).toBe(untouched)
  })

  it('keeps the identity of the props a base response left untouched', async () => {
    const app = await openAppSentCall(index({ props: { users: [{ id: 1 }], team: { id: 7 }, errors: {} } }), {
      '/users': index({
        props: { users: [{ id: 2 }], team: { id: 7 }, errors: {} },
      }),
    })
    const untouched = (await app.basePage()).props.team

    app.router.visit('/users')
    await settled()

    expect((await app.basePage()).props.team).toBe(untouched)
    expect((await app.basePage()).props.users).toEqual([{ id: 2 }])
  })

  it('never takes the identity of a base prop that happens to equal the layer prop', async () => {
    const app = await openAppSentCall(page('Users/Edit', '/users', { props: { user: { id: 5 }, errors: {} } }), {
      '/users/5/edit': editWith(),
    })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.props.user).not.toBe((await app.basePage()).props.user)
    expect(app.views()[0].page.props.user).toEqual({ id: 5 })
  })

  it('a bare reload re-asks for the base beneath the stack, not the address', async () => {
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      '/users': index({ props: { users: [{ id: 9 }], errors: {} } }),
    })
    const [layer] = app.layers()

    expect(window.location.pathname).toBe('/users/5/edit')

    app.router.reload()
    await settled()

    expect(app.sent().at(-1)).toBe('get /users')
    expect((await app.basePage()).props.users).toEqual([{ id: 9 }])
    expect(app.layers()).toEqual([layer])
  })

  it('names the layer in X-Inertia-Partial-Component when the reload carries the layer id', async () => {
    const app = await open(index(), { '/users/5/edit': editWith() })

    scopeOf(app).router.reload({ only: ['user'] })
    await settled()

    expect(app.requests.at(-1)!.headers['X-Inertia-Partial-Component']).toBe('Users/Edit')
  })

  it('strips the layer target from the request a 409 redirect re-issues', async () => {
    const app = await open(index(), { '/users/5/edit': editWith() })
    const requested: string[] = []
    const components: (string | undefined)[] = []

    app.core.http.setClient({
      request: async ({ url, headers }) => {
        requested.push(new URL(url).pathname)
        components.push((headers ?? {})['X-Inertia-Partial-Component'])

        return requested.length === 1
          ? {
              status: 409,
              data: '',
              headers: {
                'x-inertia-location': 'http://localhost/users',
                'x-inertia-redirect': 'http://localhost/users',
              },
            }
          : inertia(index({ props: { users: [{ id: 9 }], errors: {} } }))
      },
    })

    const [layer] = app.layers()

    scopeOf(app).router.reload({ only: ['users'] })
    await settled()

    expect(requested).toEqual(['/users/5/edit', '/users'])
    expect(components[1]).toBe('Users/Edit')
    expect(app.layers()).toEqual([layer])
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, errors: {} })
  })
})

describe('requests aimed at a layer and the page', () => {
  it('a visit to the page does not cancel an in-flight request aimed at a layer', async () => {
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      '/dashboard': page('Dashboard', '/dashboard'),
    })
    let cancelled = false
    const never = held()
    const answer = app.core.http.getClient()

    app.core.http.setClient({
      request: (config) =>
        config.url.endsWith('/users/5/edit') ? never.answer().then(inertia) : answer.request(config),
    })
    scopeOf(app).router.visit('/users/5/edit', {
      only: ['user'],
      async: true,
      onCancel: () => (cancelled = true),
    })
    await settled()

    app.router.visit('/dashboard')
    await settled()

    expect(cancelled).toBe(false)
    expect((await app.basePage()).component).toBe('Dashboard')
  })

  it("a reload aimed at a layer does not cancel the page's pending load", async () => {
    const pending = held()
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      '/users': () => pending.answer(),
    })
    let cancelled = false

    app.router.reload({ only: ['users'], onCancel: () => (cancelled = true) })
    await settled()
    expect(app.sent().at(-1)).toBe('get /users')

    scopeOf(app).router.reload({ only: ['user'] })
    await settled()

    expect(app.sent().at(-1)).toBe('get /users/5/edit')
    expect(cancelled).toBe(false)
  })

  it('discards a layer response whose layer closed while the request was in flight', async () => {
    const pending = held()
    let calls = 0
    const app = await open(index(), {
      '/users/5/edit': () => (++calls === 1 ? Promise.resolve(editWith()) : pending.answer()),
      '/users': index(),
    })

    scopeOf(app).router.reload({ only: ['user'] })
    await settled()

    const closing = app.router.close()
    exitShells(app)
    await closing
    await settled()

    pending.release(editWith())
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers()).toEqual([])
    expect(app.views()).toEqual([])
  })

  it('discards a response whose standalone layer closed, rather than reopening it over the page', async () => {
    const pending = held()
    let calls = 0
    const cold = editWith({ layer: { key: 'Users/Edit', base: '/users' } })
    const app = await openAppSentCall(index(), {
      '/users/5/edit': () => (++calls === 1 ? Promise.resolve(cold) : pending.answer()),
      '/users': index(),
    })

    app.router.layer('/users/5/edit')
    await settled()

    scopeOf(app).router.reload({ only: ['user'] })
    await settled()

    const closing = app.router.close()
    exitShells(app)
    await closing
    await settled()
    expect(app.layers()).toEqual([])

    pending.release(cold)
    await settled()

    expect(app.layers()).toEqual([])
    expect((await app.basePage()).component).toBe('Users/Index')
  })

  it('installs a page response for a visit whose layer closed, since it is a navigation', async () => {
    const pending = held()
    let calls = 0
    const app = await open(index(), {
      '/users/5/edit': () => (++calls === 1 ? Promise.resolve(editWith()) : pending.answer()),
      '/users': index(),
    })

    scopeOf(app).router.visit('/users/5/edit')
    await settled()

    const closing = app.router.close()
    exitShells(app)
    await closing
    await settled()

    pending.release(page('Dashboard', '/dashboard'))
    await settled()

    expect((await app.basePage()).component).toBe('Dashboard')
  })
})
