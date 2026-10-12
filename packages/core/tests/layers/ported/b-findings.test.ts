import { describe, expect, it } from 'vitest'
import { page, ported, settled } from './support'

const users = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })
const layer = (name: string, url: string) => page(name, url, { layer: { key: name, base: '/users' } })

describe('withAddressHash', () => {
  it('writes it onto the topmost layer that has a url', async () => {
    const app = await ported(users(), {
      '/a': layer('A', '/a'),
      '/b': layer('B', '/b'),
    })

    app.router.visit('/a')
    await settled()
    app.router.visit('/b')
    await settled()
    await app.anchor('/b#comments')

    expect(app.entry().layers!.map((entry) => entry.url)).toEqual(['/a', 'http://localhost/b#comments'])
    expect(app.entry().url).toBe('/users')
    expect(window.location.href).toBe('http://localhost/b#comments')
  })

  it('falls through a layer that has no url of its own', async () => {
    const app = await ported(users(), { '/a': layer('A', '/a') })

    app.router.visit('/a')
    await settled()
    app.router.layer({ component: 'Prompt' })
    await settled()
    await app.anchor('/a#comments')

    expect(app.entry().layers![0].url).toBe('http://localhost/a#comments')
    expect(app.entry().url).toBe('/users')
  })
})

describe('history entry counting', () => {
  it('counts the entry against the layer that owns the address', async () => {
    const app = await ported(users(), { '/a': layer('A', '/a') })

    app.router.visit('/a')
    await settled()
    await app.anchor('/a#top')

    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)

    expect(app.entry().layers![0].entries).toBe(2)

    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([-2])
  })

  it('gives the entry back when the browser refused to write it', async () => {
    const app = await ported(users(), {
      '/a': layer('A', '/a'),
      '/users': users(),
    })
    const reloads: string[] = []
    const pushState = window.history.pushState

    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get: () => 'http://localhost/users',
      set: (value: string) => void reloads.push(value),
    })
    window.history.pushState = () => {
      const error = new Error('quota')

      error.name = 'QuotaExceededError'
      throw error
    }

    app.router.visit('/a')
    await settled()
    window.history.pushState = pushState

    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)
    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([])
  })
})

describe('resolveInitialPage', () => {
  it('renders a layer whose base is its own url as an ordinary page', async () => {
    const own = page('Users/Edit', '/users/5/edit', {
      props: { errors: {} },
      layer: { key: 'Users/Edit', base: '/users/5/edit' },
    })
    const app = await ported(own, { '/users/5/edit': own }, { boot: true })

    await settled()

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(app.layers()).toEqual([])
    expect(app.sent).toEqual([])
  })
})

describe('loadingBase', () => {
  it('is undefined for a blank with no url at all', async () => {
    const seen: unknown[] = []
    const app = await ported(
      users(),
      {},
      {
        loading: (url) => {
          seen.push(url)

          return { name: 'Loading' }
        },
      },
    )

    expect(await app.resolve('', { ...page('', ''), url: '' })).toEqual({
      name: 'Blank',
    })
    expect(seen).toEqual([])
  })
})

describe('openLayerFor', () => {
  it("finds the layer open under the response's key", async () => {
    const dashboard = page('Dashboard', '/dashboard', { props: { errors: {}, stats: 3 } })
    const panel = (url: string, base?: string) =>
      page('Panel', url, { props: { errors: {}, at: url }, layer: { key: 'Panel', base } })
    const app = await ported(dashboard, {
      '/go': panel('/panels/2', '/p1'),
      '/p1': panel('/panels/1', '/dashboard'),
      '/dashboard': dashboard,
      '/panels/3': panel('/panels/3', '/dashboard'),
    })

    app.router.visit('/go')
    await settled()

    const [lower] = app.layers().map((open) => open.id)

    app.router.visit('/panels/3')
    await settled()

    expect(app.layers()[0]).toMatchObject({ id: lower, url: '/panels/3' })
  })
})

describe('composeLayer', () => {
  it('strips the layer mark from the layer it composes', async () => {
    const edit = page('Users/Edit', '/users/5/edit', {
      props: { errors: {}, user: { id: 5 } },
      layer: { key: 'Users/Edit', base: '/users' },
    })
    const app = await ported(users(), { '/users/5/edit': edit })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.layers().map((open) => open.key)).toEqual(['Users/Edit'])
    expect(app.entry().layers![0]).not.toHaveProperty('layer')
    expect(app.views()[0].page).not.toHaveProperty('layer')
  })
})

describe('layerPageOf', () => {
  it('falls back to the address for a layer with no url of its own', async () => {
    const app = await ported(users(), {})

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.views()[0].page.url).toBe('/users')
  })

  it('falls back to the address beneath it, never the address of a layer above it', async () => {
    const notes = page('Users/Notes', '/users/9/notes', { layer: { key: 'notes', base: '/users' } })
    const app = await ported(users(), { '/users/9/notes': notes, '/a': layer('A', '/a') })

    app.router.layer({ component: 'Prompt' })
    await settled()
    app.router.visit('/users/9/notes')
    await settled()

    expect(app.views().map((view) => view.page.url)).toEqual(['/users', '/users/9/notes'])

    app.router.layer({ component: 'Confirm' })
    await settled()

    expect(app.views().map((view) => view.page.url)).toEqual(['/users', '/users/9/notes', '/users/9/notes'])
  })

  it('follows the page beneath it to the url a partial reload moves it to', async () => {
    const app = await ported(users(), { '/users?page=2': { ...users(), url: '/users?page=2' } })

    app.router.layer({ component: 'Prompt' })
    await settled()
    app.router.visit('/users?page=2', { only: ['users'], preserveState: true, preserveScroll: true })
    await settled()

    expect(app.layers().map((open) => open.type)).toEqual(['local'])
    expect(app.views()[0].page.url).toBe('/users?page=2')
  })
})

describe('resolveLayers, the layout page', () => {
  it('leaves the url empty for a layer with no url of its own, so it never reaches the address', async () => {
    const app = await ported(users(), {})

    app.router.layer({ component: 'Users/Edit', props: { user: { id: 5 }, errors: { name: 'required' } } })
    await settled()

    const [view] = app.views()

    expect(view.layoutPage.component).toBe('Users/Edit')
    expect(view.layoutPage.props).toEqual({ user: { id: 5 }, errors: { name: 'required' } })
    expect(view.layoutPage.url).toBe('')
    expect(view.page.url).toBe('/users')
    expect(app.entry().layers![0].url).toBe('')
    expect(window.location.pathname).toBe('/users')
    expect(app.written().at(-1)).toEqual(['push', '/users'])
  })
})
