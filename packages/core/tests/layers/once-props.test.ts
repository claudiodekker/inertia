import { describe, expect, it, vi } from 'vitest'
import { bench, byPath, page, settled, type Bench } from './support/e-support'

const users = page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const editPage = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

describe('once props per layer', () => {
  const cached = (app: Awaited<ReturnType<Awaited<ReturnType<typeof bench>>['modules']>>) =>
    (app.prefetchedRequests as unknown as { cached: { response: Promise<{ getPageResponse(): Promise<any> }> }[] })
      .cached

  const baseOnce = page('Users/Index', '/users', {
    props: { errors: {}, baseProp: 'base value' },
    onceProps: { baseKey: { prop: 'baseProp' } },
  })

  it("does not put the page's once props into a cached layer response", async () => {
    const app = await bench(
      baseOnce,
      byPath({ '/users/5/edit': { ...editPage, onceProps: { baseKey: { prop: 'baseProp' } } } }),
    )
    const modules = await app.modules()

    app.router.prefetch('/users/5/edit', {}, { cacheFor: '30s' })
    await vi.waitFor(() => expect(cached(modules)).toHaveLength(1))
    modules.prefetchedRequests.updateCachedOncePropsFromCurrentPage()

    const response = await cached(modules)[0].response.then((answered) => answered.getPageResponse())

    modules.prefetchedRequests.removeAll()

    expect(response.props).not.toHaveProperty('baseProp')
    expect(response.props).toEqual({ errors: {}, user: { id: 5 } })
  })
})

describe('once props per layer', () => {
  const baseOnce = page('Users/Index', '/users', {
    props: { errors: {}, baseProp: 'base value' },
    onceProps: { baseKey: { prop: 'baseProp' } },
  })
  const layerOnce = {
    ...editPage,
    onceProps: { layerKey: { prop: 'layerProp' } },
    props: { errors: {}, user: { id: 5 }, layerProp: 'layer value' },
  }
  const cached = (app: Awaited<ReturnType<Bench['modules']>>) =>
    (
      app.prefetchedRequests as unknown as {
        cached: { response: Promise<{ getPageResponse(): Promise<any> }> }[]
      }
    ).cached
  const except = (request: { headers: Record<string, string> }) => request.headers['X-Inertia-Except-Once-Props']

  it('names no once keys at all on the visit that opens a layer', async () => {
    const app = await bench(baseOnce, byPath({ '/users/5/edit': editPage }))

    app.router.layer('/users/5/edit')
    await settled()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit'])
    expect(app.requests.map(except)).toEqual(['baseKey'])
  })

  it("a layer-targeted partial names the layer's once keys in the except header", async () => {
    const app = await bench(baseOnce, byPath({ '/users/5/edit': layerOnce }))

    app.router.visit('/users/5/edit')
    await settled()
    app.router.layerHandle()!.router.reload({ only: ['user'] })
    await settled()

    expect(app.requests.map(except)).toEqual(['baseKey', 'layerKey'])
  })

  it("a layer response's once props back-fill into the layer, never with the page's value", async () => {
    const answers = [
      layerOnce,
      {
        ...editPage,
        onceProps: { layerKey: { prop: 'layerProp' } },
        props: { errors: {}, user: { id: 9 } },
      },
    ]
    const app = await bench(baseOnce, () => answers.shift()!)

    app.router.visit('/users/5/edit')
    await settled()
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.layers()).toHaveLength(1)
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 9 },
      layerProp: 'layer value',
    })
    expect(app.views()[0].page.props).not.toHaveProperty('baseProp')
  })

  it("re-syncs a cached prefetch when the once props on screen are only a layer's", async () => {
    const live = {
      ...editPage,
      onceProps: { token: { prop: 'token' } },
      props: { errors: {}, user: { id: 5 }, token: 'live' },
    }
    const app = await bench(users, (request) =>
      request.path === '/users/5/notes'
        ? {
            ...editPage,
            url: '/users/5/notes',
            onceProps: { token: { prop: 'token' } },
          }
        : live,
    )
    const modules = await app.modules()

    app.router.prefetch('/users/5/notes', {}, { cacheFor: '30s' })
    await vi.waitFor(() => expect(cached(modules)).toHaveLength(1))

    app.router.visit('/users/5/edit')
    await settled()
    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/notes', '/users/5/edit'])

    app.router.layerHandle()!.router.visit('/users/5/notes')
    await settled()

    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/notes', '/users/5/edit'])
    expect(app.layers()).toEqual([
      expect.objectContaining({
        component: 'Users/Edit',
        url: '/users/5/notes',
      }),
    ])
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      token: 'live',
    })
    modules.prefetchedRequests.removeAll()
  })

  it('flushes the cached prefetch of the layer a fresh response landed on', async () => {
    const app = await bench(users, (request) =>
      request.method === 'post' ? { ...editPage, props: { errors: {}, user: { id: 9 } } } : editPage,
    )
    const modules = await app.modules()

    app.router.visit('/users/5/edit', { preserveUrl: true })
    await settled()
    app.router.prefetch('/users/5/edit', {}, { cacheFor: '30s' })
    await vi.waitFor(() => expect(cached(modules)).toHaveLength(1))

    app.router.layerHandle()!.router.visit('/users/5/edit', { method: 'post' })
    await settled()

    expect(cached(modules)).toHaveLength(0)
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 9 } })
  })
})
