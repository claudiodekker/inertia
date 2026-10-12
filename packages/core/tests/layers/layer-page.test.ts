import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  globalThis.window = {
    location: new URL('http://localhost/users'),
    history: { state: null, pushState: () => {}, replaceState: () => {} },
    navigator: { userAgent: 'node' },
    addEventListener: () => {},
    scrollTo: () => {},
  } as unknown as Window & typeof globalThis

  globalThis.document = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    querySelectorAll: () => [],
    visibilityState: 'visible',
  } as unknown as Document
})

type Core = typeof import('../../src')
type Singletons = {
  history: typeof import('../../src/history').history
  prefetchedRequests: typeof import('../../src/prefetched').prefetchedRequests
  Scroll: typeof import('../../src/scroll').Scroll
  eventHandler: typeof import('../../src/eventHandler').eventHandler
  page: typeof import('../../src/page').page
  LayerInstance: typeof import('../../src/layers/instance').LayerInstance
}

const incoming = () => ({
  component: 'Users/Edit',
  props: { errors: {}, plans: ['basic'] },
  url: '/users/1',
  version: null,
  clearHistory: true,
  onceProps: { plans: { prop: 'plans' } },
  deferredProps: { default: ['stats'] },
  flash: {},
  rescuedProps: [],
  rememberedState: {},
})

describe('LayerPage.set', () => {
  let core: Core
  let s: Singletons

  beforeAll(async () => {
    core = await import('../../src')
    s = {
      history: (await import('../../src/history')).history,
      prefetchedRequests: (await import('../../src/prefetched')).prefetchedRequests,
      Scroll: (await import('../../src/scroll')).Scroll,
      eventHandler: (await import('../../src/eventHandler')).eventHandler,
      page: (await import('../../src/page')).page,
      LayerInstance: (await import('../../src/layers/instance')).LayerInstance,
    }
  })

  afterEach(() => vi.restoreAllMocks())

  const spyOnGlobals = () => ({
    clear: vi.spyOn(s.history, 'clear').mockImplementation(() => {}),
    clearInitialState: vi.spyOn(s.history, 'clearInitialState').mockImplementation(() => {}),
    updateCachedOnceProps: vi
      .spyOn(s.prefetchedRequests, 'updateCachedOncePropsFromCurrentPage')
      .mockImplementation(() => {}),
    scrollReset: vi.spyOn(s.Scroll, 'reset').mockImplementation(() => {}),
    fireInternalEvent: vi.spyOn(s.eventHandler, 'fireInternalEvent').mockImplementation(() => {}),
  })

  it('runs none of the global side effects of the base set()', async () => {
    const spies = spyOnGlobals()
    const reported: unknown[] = []
    const port = {
      layerCommitting: async (
        layer: InstanceType<Singletons['LayerInstance']>,
        page: { url: string },
        replace: boolean,
      ) => {
        reported.push(['committing', page.url, replace])
        layer.lastWrite = 'push'
      },
      layerSwapped: async () => void reported.push(['swapped']),
      route: () => undefined,
      captured: () => {},
      rewriteEntry: () => {},
      clearHistory: () => void reported.push(['clearHistory']),
      key: () => 'users-edit',
      index: () => 0,
      close: async () => {},
      emit: () => {},
    }
    const layer = new s.LayerInstance('layer-1' as never, 'routed', port, {
      resolveComponent: () => ({ name: 'UsersEdit' }),
      version: null,
    })
    const loadDeferred = vi.spyOn(layer.router, 'loadDeferred').mockImplementation(() => {})

    await layer.page.set(incoming(), { preserveScroll: false })

    expect(spies.clear).not.toHaveBeenCalled()
    expect(spies.clearInitialState).not.toHaveBeenCalled()
    expect(spies.updateCachedOnceProps).not.toHaveBeenCalled()
    expect(spies.scrollReset).not.toHaveBeenCalled()
    expect(spies.fireInternalEvent).not.toHaveBeenCalled()

    expect(reported).toEqual([['clearHistory'], ['committing', '/users/1', false], ['swapped']])
    expect(loadDeferred).toHaveBeenCalledWith({ default: ['stats'] })
    expect(layer.page.get().url).toBe('/users/1')
    expect(layer.view).toEqual({ component: { name: 'UsersEdit' }, page: layer.page.get(), renderKey: 1 })
  })

  it('the base set() runs each of them, so the spies would see a layer that did', async () => {
    const spies = spyOnGlobals()

    s.page.init({
      initialPage: {
        component: 'Users/Index',
        props: { errors: {} },
        url: '/users',
        version: null,
        flash: {},
        rescuedProps: [],
        rememberedState: {},
      },
      resolveComponent: () => ({ name: 'UsersEdit' }),
      swapComponent: async () => {},
    })

    await s.page.set(incoming(), { preserveScroll: false })

    expect(spies.clear).toHaveBeenCalledTimes(1)
    expect(spies.clearInitialState).toHaveBeenCalledWith('rememberedState')
    expect(spies.updateCachedOnceProps).toHaveBeenCalledTimes(1)
    expect(spies.scrollReset).toHaveBeenCalledTimes(1)
    expect(spies.fireInternalEvent).toHaveBeenCalledWith('loadDeferredProps', { default: ['stats'] })
    expect(core.router).toBeDefined()
  })
})
