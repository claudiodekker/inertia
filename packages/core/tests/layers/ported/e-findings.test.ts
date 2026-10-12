import { describe, expect, it, vi } from 'vitest'
import { bench, byPath, exitShells, gate, page, settled, type Bench } from './e-support'

const users = page('Users/Index', '/users', { props: { errors: {}, users: [] } })
const edit = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})
const partialOf = (app: Bench) =>
  app.requests.filter((request) => request.headers['X-Inertia-Partial-Data'] !== undefined)

describe("a layer's deferred and rescued props", () => {
  it('drops what a layer was owing when the write that lands has closed it', async () => {
    const resolving = gate()
    const app = await bench(users, byPath({ '/users/5/edit': { ...edit, deferredProps: { slow: ['stats'] } } }), {
      resolve: (name) => (name === 'Users/Edit' ? resolving.opened.then(() => ({ name })) : { name }),
    })

    app.router.visit('/users/5/edit')
    await settled()
    app.router.push({ component: 'Teams/Index', url: '/teams', props: {} })
    await settled()
    resolving.open()
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect(partialOf(app)).toEqual([])
    expect(app.requests.map((request) => request.path)).toEqual(['/users/5/edit'])
  })
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
      byPath({ '/users/5/edit': { ...edit, onceProps: { baseKey: { prop: 'baseProp' } } } }),
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

describe("an infinite scroll's url sync", () => {
  const item = (pageNumber: string): HTMLElement =>
    ({
      dataset: { infiniteScrollPage: pageNumber },
      offsetParent: {},
      getBoundingClientRect: () => ({ top: 0, bottom: 10, left: 0, right: 10 }),
    }) as unknown as HTMLElement

  const scene = async () => {
    const app = await bench(users, byPath({ '/users/5/edit': edit }))

    app.router.visit('/users/5/edit')
    await settled()

    const layer = app.router.layerHandle()!
    const { page: base } = await app.modules()
    const { useInfiniteScrollQueryString } = await import('../../../src/infiniteScroll/queryString')
    const replaced: { router: string; params: unknown }[] = []

    vi.spyOn(app.router, 'replace').mockImplementation((params) => {
      replaced.push({ router: 'page', params })
    })
    vi.spyOn(layer.router, 'replace').mockImplementation((params) => {
      replaced.push({ router: 'layer', params })
    })

    const items = [item('2'), item('2')]
    const scrollIn = (target: 'page' | 'layer') =>
      useInfiniteScrollQueryString({
        scope:
          target === 'layer'
            ? { router: layer.router, page: { get: () => app.views()[0].page } }
            : { router: app.router, page: { get: () => base.get() } },
        getPageName: () => 'page',
        getItemsElement: () => ({ children: items }) as unknown as HTMLElement,
        shouldPreserveUrl: () => false,
      })

    return { app, replaced, items, scrollIn }
  }

  it("keeps a layer and the page paginating at once out of each other's urls", async () => {
    const { replaced, items, scrollIn } = await scene()

    scrollIn('page').onItemIntersected(items[1])
    scrollIn('layer').onItemIntersected(items[1])
    await vi.waitFor(() => expect(replaced).toHaveLength(2))

    expect(replaced.map(({ router, params }) => `${router}:${(params as { url: string }).url}`).sort()).toEqual([
      'layer:/users/5/edit?page=2',
      'page:/users?page=2',
    ])
  })

  it('writes no page number for a layer with no url of its own', async () => {
    const app = await bench(users, byPath({}))
    const handle = app.router.layer({ component: 'Users/Pick' })

    await settled()

    const layer = app.router.layerHandle(handle.id)!
    const { page: base } = await app.modules()
    const { useInfiniteScrollQueryString } = await import('../../../src/infiniteScroll/queryString')
    const replaced: string[] = []

    vi.spyOn(app.router, 'replace').mockImplementation((params) => void replaced.push(`page:${params.url}`))
    vi.spyOn(layer.router, 'replace').mockImplementation((params) => void replaced.push(`layer:${params.url}`))

    const items = [item('2'), item('2')]
    const scrollIn = (scope: { router: typeof app.router; page: { get: () => { url: string } } }) =>
      useInfiniteScrollQueryString({
        scope: scope as never,
        getPageName: () => 'page',
        getItemsElement: () => ({ children: items }) as unknown as HTMLElement,
        shouldPreserveUrl: () => false,
      })

    scrollIn({ router: layer.router, page: { get: () => app.views()[0].page } }).onItemIntersected(items[1])
    scrollIn({ router: app.router, page: { get: () => base.get() } }).onItemIntersected(items[1])
    await vi.waitFor(() => expect(replaced).toContain('page:/users?page=2'))

    expect(replaced).toEqual(['page:/users?page=2'])
  })
})
