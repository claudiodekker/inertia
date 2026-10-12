import { describe, expect, it, afterEach, vi } from 'vitest'
import { addressOf } from '../../src/layers/entry'
import { openAppSync, openApp } from './support/app'
import { page, settled } from './support/browser'
import { asPage, dashboard, edit, layerEntry, users } from './support/pages'

const usersPage = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const layer = (name: string, url: string) => page(name, url, { layer: { key: name, base: '/users' } })

const usersIndex = page('Users/Index', '/users', {
  props: { errors: {}, users: [] },
})

const editOverUsers = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit', base: '/users' },
  props: { errors: {}, user: { id: 5 } },
})

const show = page('Users/Show', '/users/5', {
  props: { errors: {}, users: [] },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withAddressHash', () => {
  it('writes it onto the topmost layer that has a url', async () => {
    const app = await openApp(usersPage(), {
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
    const app = await openApp(usersPage(), { '/a': layer('A', '/a') })

    app.router.visit('/a')
    await settled()
    app.router.layer({ component: 'Prompt' })
    await settled()
    await app.anchor('/a#comments')

    expect(app.entry().layers![0].url).toBe('http://localhost/a#comments')
    expect(app.entry().url).toBe('/users')
  })

  it('writes the hash onto the page url when there are no layers', async () => {
    const app = await openApp(users, {})

    await app.anchor('/users#comments')

    expect(app.entry().url).toBe('http://localhost/users#comments')
  })

  it('writes it onto the page url when no layer has one', async () => {
    const app = await openApp(users, {})
    app.router.layer({ component: 'Prompt' })
    await settled()

    await app.anchor('/users#comments')

    expect(app.entry().url).toBe('http://localhost/users#comments')
    expect(app.entry().layers!.map((layer) => [layer.type, layer.url])).toEqual([['local', '']])
  })

  it('replaces a hash the address already carries', async () => {
    const app = await openApp(page('Users/Index', '/users#top'), {}, { href: 'http://localhost/users#top' })

    await app.anchor('/users#comments')

    expect(app.entry().url).toBe('http://localhost/users#comments')
  })

  it('does not mutate the page it is given', async () => {
    const app = await openApp(users, { '/a': page('A', '/a', { layer: { key: 'A', base: '/users' } }) })
    app.router.visit('/a')
    await settled()
    const before = structuredClone(app.views()[0].page)

    await app.anchor('/a#comments')

    expect(app.views()[0].page).toEqual(before)
    expect(app.views()[0].page.url).toBe('/a')
  })
})

describe('openLayerFor', () => {
  it("finds the layer open under the response's key", async () => {
    const dashboard = page('Dashboard', '/dashboard', { props: { errors: {}, stats: 3 } })
    const panel = (url: string, base?: string) =>
      page('Panel', url, { props: { errors: {}, at: url }, layer: { key: 'Panel', base } })
    const app = await openApp(dashboard, {
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

describe('the address the events report', () => {
  const eventDetail = (app: Awaited<ReturnType<typeof openAppSync>>, name: string) =>
    app.fired.findLast((event) => event.type === `inertia:${name}`)!.detail

  it("gives inertia:navigate the layer's address, while the page it carries keeps its own url", async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })

    app.router.layer('/users/5/edit')
    await settled()

    expect(window.location.pathname).toBe('/users/5/edit')
    expect(eventDetail(app, 'navigate').page.url).toBe('/users/5/edit')
  })

  it("gives inertia:navigate the page's own url when there are no layers", async () => {
    const app = await openAppSync(usersIndex, { '/users/5': show })

    app.router.visit('/users/5')
    await settled()

    expect(eventDetail(app, 'navigate').page.url).toBe('/users/5')
  })

  it('gives inertia:success the layer it landed in, address and page alike', async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })

    app.router.visit('/users/5/edit')
    await settled()

    expect(window.location.pathname).toBe('/users/5/edit')
    expect(eventDetail(app, 'success').page.url).toBe('/users/5/edit')
    expect(eventDetail(app, 'success').page.props.user).toEqual({ id: 5 })
  })

  it("hands onSuccess the layer's own props, not the page's beneath it", async () => {
    const app = await openAppSync(usersIndex, { '/users/5/edit': editOverUsers })

    const landed = await new Promise<{
      component: string
      props: Record<string, unknown>
    }>((resolve) => {
      app.router.visit('/users/5/edit', { onSuccess: (page) => resolve(page) })
    })

    expect(landed.component).toBe('Users/Edit')
    expect(landed.props).toEqual({ errors: {}, user: { id: 5 } })
  })

  it("gives inertia:success the page's own url when there are no layers", async () => {
    const app = await openAppSync(usersIndex, { '/users/5': show })

    app.router.visit('/users/5')
    await settled()

    expect(eventDetail(app, 'success').page.url).toBe('/users/5')
  })
})

describe('openLayerFor', () => {
  const panel = (url: string, base?: string) =>
    page('Panel', url, { props: { errors: {}, at: url }, layer: { key: 'Panel', base } })

  const twoPanels = async () => {
    const app = await openApp(dashboard, {
      '/go': panel('/panels/2', '/p1'),
      '/p1': panel('/panels/1', '/dashboard'),
      '/dashboard': dashboard,
      '/panels/3': panel('/panels/3', '/dashboard'),
      '/users/5/edit': edit(),
    })

    app.router.visit('/go')
    await settled()

    return app
  }

  it('prefers the layer the visit was made from where two share a key', async () => {
    const app = await twoPanels()
    const [lower, upper] = app.layers().map((layer) => layer.id)

    app.router.layerHandle(upper)!.router.visit('/panels/3')
    await settled()

    expect(app.layers().map((layer) => [layer.id, layer.url])).toEqual([
      [lower, '/panels/1'],
      [upper, '/panels/3'],
    ])
  })

  it('never matches a local layer', async () => {
    const app = await openApp(users, { '/panels/3': panel('/panels/3', '/users') })
    const local = app.router.layer({ component: 'Panel' })
    await settled()

    app.router.visit('/panels/3')
    await settled()

    expect(app.layers().map((layer) => [layer.type, layer.url])).toEqual([
      ['local', null],
      ['routed', '/panels/3'],
    ])
    expect(app.layers()[0].id).toBe(local.id)
  })

  it('finds nothing when no open layer carries the key', async () => {
    const app = await twoPanels()
    const before = app.layers().map((layer) => layer.id)

    app.router.visit('/users/5/edit')
    await settled()

    expect(
      app
        .layers()
        .map((layer) => layer.id)
        .slice(0, 2),
    ).toEqual(before)
    expect(app.layers().map((layer) => layer.key)).toEqual(['Panel', 'Panel', 'Users/Edit'])
  })
})

describe('addressOf', () => {
  const base = asPage(users)

  it('is the page url when there are no layers', () => {
    expect(addressOf(base, [])).toBe('/users')
  })

  it('is the topmost layer url', () => {
    expect(addressOf(base, [layerEntry('A', '/a'), layerEntry('B', '/b')])).toBe('/b')
  })

  it('falls through a layer that has no url of its own', () => {
    expect(addressOf(base, [layerEntry('A', '/a'), layerEntry('B', '', { type: 'local' })])).toBe('/a')
  })

  it('is the topmost layer url even when it is empty', () => {
    expect(addressOf(base, [layerEntry('A', '')])).toBe('')
  })

  it('is the page url when no layer has one', () => {
    expect(addressOf(base, [layerEntry('A', '', { type: 'local' })])).toBe('/users')
  })
})
