import { afterEach, describe, expect, it, vi } from 'vitest'
import createHeadManager, { resolveServerHead } from '../../../src/head'
import { planBoot } from '../../../src/layers/entry'
import Queue from '../../../src/queue'
import type { Page, PageProps } from '../../../src/types'
import { page, settled, start } from './f-support'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('clonePageProps', () => {
  const pageWith = (props: PageProps): Page => ({
    component: 'Users/Index',
    props: { errors: {}, ...props },
    url: '/users',
    version: null,
    rescuedProps: [],
    flash: {},
    rememberedState: {},
  })

  const clonePageProps = async (input: Page): Promise<Page> => {
    const { history } = await import('../../../src/history')

    return (history as unknown as { clonePageProps(page: Page): Page }).clonePageProps(input)
  }

  it('returns props the browser can store in history', async () => {
    const cloned = await clonePageProps(pageWith({ name: 'Joe', user: new Proxy({ id: 5 }, {}) }))

    expect(() => structuredClone(cloned.props)).not.toThrow()
    expect(cloned.props).toEqual({ errors: {}, name: 'Joe', user: { id: 5 } })
  })

  it('returns the page untouched when its props are already cloneable', async () => {
    const input = pageWith({ name: 'Joe' })

    expect(await clonePageProps(input)).toBe(input)
  })

  it('does not mutate the original props', async () => {
    const onClick = () => {}
    const input = pageWith({ onClick, user: new Proxy({ id: 5 }, {}) })

    await clonePageProps(input)

    expect(input.props.onClick).toBe(onClick)
  })

  it('returns props the browser can store when the unstorable ones are on a layer', async () => {
    const app = await start(page('Users/Index', '/users'), {})
    const handle = app.router.layer({
      component: 'Confirm',
      props: { message: 'Discard?', user: new Proxy({ id: 5 }, {}) },
    })

    await settled()

    expect(handle.state).toBe('open')
    expect(app.written().at(-1)).toEqual(['push', '/users'])
    expect(() => structuredClone(window.history.state)).not.toThrow()
    expect(app.entry().layers).toEqual([
      expect.objectContaining({
        id: handle.id,
        component: 'Confirm',
        props: { errors: {}, message: 'Discard?', user: { id: 5 } },
      }),
    ])
  })
})

describe('the write queue', () => {
  it('runs an item added while the item ahead of it was settling', async () => {
    const queue = new Queue<Promise<void>>()
    const ran: string[] = []
    let first!: Promise<void>

    queue.add(() => (first = Promise.resolve().then(() => void ran.push('first'))))
    await first.then(() => queue.add(() => Promise.resolve().then(() => void ran.push('second'))))
    await new Promise((resolve) => setTimeout(resolve))

    expect(ran).toEqual(['first', 'second'])
  })
})

describe('remembering state on the server', () => {
  const withoutWindow = async (run: (history: { remember(data: unknown, key: string): void }) => void) => {
    vi.resetModules()

    const browser = globalThis.window

    // @ts-expect-error the server has none
    delete globalThis.window

    try {
      run((await import('../../../src/history')).history)
    } finally {
      globalThis.window = browser
    }
  }

  it('does nothing, since a render has no history to remember into', async () => {
    await withoutWindow((history) => expect(() => history.remember({ name: 'Joe' }, 'default')).not.toThrow())
  })
})

describe('createHeadManager', () => {
  describe('server head', () => {
    const response = (props: Page['props'] = {}) => ({
      component: 'Users/Edit',
      props: { errors: {}, ...props },
      url: '/users/5/edit',
      version: null,
      rescuedProps: [],
      flash: {},
      rememberedState: {},
      layer: { key: 'Users/Edit', base: '/users' },
    })

    const cold = (props: Page['props'] = {}) => planBoot(response(props) as Page, '')

    it('resolves a cold layer server head from the top layer when the base is blank', () => {
      const plan = cold({ head: ['<title>Layer</title>'] })

      expect(plan.base.component).toBe('')
      expect(resolveServerHead(plan.top, (p) => p.props.head as string[])).toEqual([
        '<title data-inertia="server-head-0">Layer</title>',
      ])
    })

    it('resolves a cold layer server head from a named prop on the top layer', () => {
      expect(
        resolveServerHead(cold({ metaTags: ['<meta name="description" content="Layer">'] }).top, 'metaTags'),
      ).toEqual(['<meta data-inertia="server-head-0" name="description" content="Layer">'])
    })

    it('resolves a warm layer server head from the top layer, not the base beneath it', async () => {
      const base = page('Users/Index', '/users', {
        props: { errors: {}, head: ['<title>Base</title>'] },
      })
      const layer = page('Users/Edit', '/users/5/edit', {
        layer: { key: 'Users/Edit', base: '/users' },
        props: { errors: {}, head: ['<title>Layer</title>'] },
      })
      const app = await start(base, { '/users/5/edit': layer })

      app.router.layer('/users/5/edit')
      await settled()

      expect(resolveServerHead(app.topPage()!, true)).toEqual(['<title data-inertia="server-head-0">Layer</title>'])
      expect(resolveServerHead(app.basePage(), true)).toEqual(['<title data-inertia="server-head-0">Base</title>'])
    })

    it('returns no head for a cold layer that carries none', () => {
      expect(resolveServerHead(cold().top, true)).toEqual([])
      expect(resolveServerHead(cold().top, (p) => p.props.head as string[])).toEqual([])
    })
  })

  describe('stack order', () => {
    const managed = (initialServerHead: string[] = []) => {
      const collected: string[][] = []
      const manager = createHeadManager(
        true,
        (title) => title,
        (elements) => collected.push(elements),
        initialServerHead,
      )

      return { manager, last: () => collected[collected.length - 1] }
    }

    const rankIn = (stack: () => string[], id: string) => () => stack().indexOf(id) + 1

    it('orders the page beneath the layers, the layers by their index, and keeps only the top title', () => {
      const { manager, last } = managed()
      const stack = () => ['layer-1', 'layer-2']

      const firstBase = manager.createProvider()
      const layerOne = manager.createProvider(rankIn(stack, 'layer-1'))
      const layerTwo = manager.createProvider(rankIn(stack, 'layer-2'))
      const secondBase = manager.createProvider()

      firstBase.update(['<meta data-inertia="first-base" content="first">'])
      secondBase.update(['<meta data-inertia="second-base" content="second">'])
      layerOne.update(['<title data-inertia="">Layer One</title>', '<meta data-inertia="one" content="1">'])
      layerTwo.update(['<title data-inertia="">Layer Two</title>'])

      expect(last()).toEqual([
        '<meta data-inertia="first-base" content="first">',
        '<meta data-inertia="second-base" content="second">',
        '<title data-inertia="">Layer Two</title>',
        '<meta data-inertia="one" content="1">',
      ])
    })

    it("keeps the top layer's title when another layer is inserted beneath it", () => {
      const { manager, last } = managed()
      let stack = ['outer']

      const outer = manager.createProvider(rankIn(() => stack, 'outer'))
      outer.update(['<title data-inertia="">Outer</title>'])

      stack = ['inner', 'outer']
      const inner = manager.createProvider(rankIn(() => stack, 'inner'))
      inner.update(['<title data-inertia="">Inner</title>'])

      expect(last()).toEqual(['<title data-inertia="">Outer</title>'])
    })

    it("keeps a layer's title winning over the page's when its provider disconnects and reconnects", () => {
      const { manager, last } = managed()
      const stack = () => ['layer-1']

      const layerOne = manager.createProvider(rankIn(stack, 'layer-1'))
      const base = manager.createProvider()

      layerOne.update(['<title data-inertia="">Layer</title>'])
      base.update(['<title data-inertia="">Base</title>'])

      layerOne.disconnect()
      layerOne.reconnect()
      layerOne.update(['<title data-inertia="">Layer</title>'])

      expect(last()).toEqual(['<title data-inertia="">Layer</title>'])
    })

    it('keeps the server head first', () => {
      const { manager, last } = managed(['<title data-inertia="server-head-0">Server Head</title>'])
      const layerOne = manager.createProvider(rankIn(() => ['layer-1'], 'layer-1'))

      layerOne.update(['<meta data-inertia="one" content="1">'])

      expect(last()).toEqual([
        '<title data-inertia="server-head-0">Server Head</title>',
        '<meta data-inertia="one" content="1">',
      ])
    })
  })
})

describe('partialReloadFillsDeferred', () => {
  const edit = page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit', base: '/users' },
    props: { errors: {}, user: { id: 5 } },
  })
  const withStats = { props: { errors: {}, stats: 3 } }

  type App = Awaited<ReturnType<typeof start>>

  const startedOf = (app: App) => app.fired.findLast((event) => event.type === 'inertia:start')!.detail.visit

  it('matches a base reload against the base url while a layer owns the address', async () => {
    const app = await start(page('Users/Index', '/users'), {
      '/users/5/edit': edit,
      '/users': { ...page('Users/Index', '/users'), ...withStats },
    })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    const layer = app.router.layerHandle(handle.id)!

    app.router.reload({ only: ['stats'] })
    await settled()

    const reload = startedOf(app)

    expect(app.sent).toEqual(['get /users/5/edit', 'get /users'])
    expect(app.basePage().props).toEqual({ errors: {}, stats: 3 })
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 5 } })
    expect(reload.url.pathname).toBe('/users')
    expect(window.location.pathname).toBe('/users/5/edit')
    expect(app.layerSlot.fillsDeferred(reload, null, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(reload, layer, ['stats'])).toBe(false)

    layer.router.reload({ only: ['stats'] })
    await settled()

    expect(app.layerSlot.fillsDeferred(startedOf(app), null, ['stats'])).toBe(false)
  })

  it('matches a base reload against the address when no layer is open', async () => {
    const app = await start(page('Users/Index', '/users'), {
      '/users': { ...page('Users/Index', '/users'), ...withStats },
    })

    app.router.reload({ only: ['stats'] })
    await settled()

    const reload = startedOf(app)

    expect(app.sent).toEqual(['get /users'])
    expect(reload.url.href).toBe(window.location.href)
    expect(app.layerSlot.fillsDeferred(reload, null, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(reload, null, ['other'])).toBe(false)
  })

  it('matches a layer reload against the layer url, on that layer only', async () => {
    const app = await start(page('Users/Index', '/users'), {
      '/users/5/edit': () => Promise.resolve(app.sent.length > 1 ? { ...edit, ...withStats } : edit),
    })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    const layer = app.router.layerHandle(handle.id)!

    layer.router.reload({ only: ['stats'] })
    await settled()

    const reload = startedOf(app)

    expect(app.sent).toEqual(['get /users/5/edit', 'get /users/5/edit'])
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: 3,
    })
    expect(app.basePage().props).toEqual({ errors: {} })
    expect(app.layerSlot.fillsDeferred(reload, layer, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(reload, null, ['stats'])).toBe(false)
    expect(app.layerSlot.fillsDeferred(reload, layer, ['other'])).toBe(false)
  })

  it('tells a layer and the page apart when both sit on the same path', async () => {
    const picker = page('Users/Pick', '/users?pick=1', {
      layer: { key: 'Users/Pick', base: '/users' },
      props: { errors: {} },
    })
    const app = await start(page('Users/Index', '/users'), {
      '/users?pick=1': picker,
      '/users': page('Users/Index', '/users'),
    })
    const handle = app.router.layer('/users?pick=1')

    await settled()

    const layer = app.router.layerHandle(handle.id)!

    layer.router.reload({ only: ['stats'] })
    await settled()

    const ofTheLayer = startedOf(app)

    app.router.reload({ only: ['stats'] })
    await settled()

    const ofThePage = startedOf(app)

    expect(app.sent).toEqual(['get /users?pick=1', 'get /users?pick=1', 'get /users'])
    expect(app.layerSlot.fillsDeferred(ofTheLayer, layer, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(ofTheLayer, null, ['stats'])).toBe(false)
    expect(app.layerSlot.fillsDeferred(ofThePage, null, ['stats'])).toBe(true)
    expect(app.layerSlot.fillsDeferred(ofThePage, layer, ['stats'])).toBe(false)
  })
})
