import { describe, expect, it } from 'vitest'
import { bootId, compose, planBoot } from '../../../src/layers/entry'
import { marksOf } from '../../../src/layers/facts'
import type { Page } from '../../../src/types'
import { asPage, dashboard, edit, held, layerAtBase, layerEntry, teams, users } from './layers-fixtures'
import type { Answer } from './layers-fixtures'
import { page, ported, settled } from './support'

describe('isLayerResponse', () => {
  it('is true when the response carries a layer mark', () => {
    expect(marksOf(asPage(page('Users/Index', '/users', { layer: { key: 'Users/Edit' } }))).layer).toEqual({
      key: 'Users/Edit',
      base: null,
    })
  })

  it('is true for a layer mark that declares nothing', () => {
    expect(marksOf(asPage(page('Users/Index', '/users', { layer: {} }))).layer).toEqual({
      key: 'Users/Index',
      base: null,
    })
  })

  it('is false for an ordinary page response', () => {
    expect(marksOf(asPage(users)).layer).toBeNull()
  })

  it('is false when the layer mark is null', () => {
    expect(marksOf(asPage(page('Users/Index', '/users', { layer: null }))).layer).toBeNull()
  })
})

describe('nextLayerId', () => {
  const panel = (name: string) => page(`Panels/${name}`, `/panels/${name}`, { layer: { key: name, base: '/users' } })

  it("skips ids already on the base's stack", async () => {
    const app = await ported(users, { '/panels/A': panel('A'), '/panels/B': panel('B') })
    const first = app.router.layer('/panels/A')
    await settled()
    const second = app.router.layer('/panels/B')
    await settled()

    expect(second.id).not.toBe(first.id)
    expect(app.entry().layers!.map((layer) => layer.id)).toEqual([first.id, second.id])
  })

  it('does not collide with a restored stack after the counter resets', async () => {
    const app = await ported(users, { '/panels/A': panel('A'), '/panels/B': panel('B') })
    const first = app.router.layer('/panels/A')
    await settled()

    window.history.back()
    await settled()
    app.exitShells()
    await settled()
    expect(app.layers()).toEqual([])

    window.history.go(1)
    await settled()
    expect(app.layers().map((layer) => layer.id)).toEqual([first.id])

    const second = app.router.layer('/panels/B')
    await settled()

    expect(second.id).not.toBe(first.id)
    expect(app.layers().map((layer) => layer.id)).toEqual([first.id, second.id])
  })

  it('gives every layer on a stack a different id', async () => {
    const app = await ported(users, {
      '/panels/C0': panel('C0'),
      '/panels/C1': panel('C1'),
      '/panels/C2': panel('C2'),
    })

    for (const name of ['C0', 'C1', 'C2']) {
      app.router.visit(`/panels/${name}`)
      await settled()
    }

    expect(new Set(app.layers().map((layer) => layer.id)).size).toBe(3)
    expect(new Set(app.entry().layers!.map((layer) => layer.id)).size).toBe(3)
  })
})

describe('composeLayer', () => {
  const open = async (routes: Record<string, Answer | (() => Promise<Answer>)> = {}) =>
    ported(users, { '/users/5/edit': edit(), '/teams/1': teams, ...routes })

  it('keeps the page it composes onto as the base', async () => {
    const app = await open()
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.entry()).toMatchObject({ component: 'Users/Index', url: '/users', props: { errors: {}, users: [] } })
    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', url: '/users' })
  })

  it('appends the response as a layer', async () => {
    const app = await open()
    const handle = app.router.layer('/users/5/edit')
    await settled()

    expect(app.entry().layers).toHaveLength(1)
    expect(app.entry().layers![0]).toMatchObject({
      id: handle.id,
      key: 'Users/Edit',
      type: 'routed',
      component: 'Users/Edit',
      props: { errors: {}, user: { id: 5 } },
      url: '/users/5/edit',
      version: 'v1',
      owner: null,
      entries: 1,
      rescuedProps: [],
      rememberedState: {},
    })
    expect(app.entry().layers![0]).not.toHaveProperty('flash')
  })

  it('does not mark a layer opened over a page as standalone', async () => {
    const app = await open()
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.entry().layers![0]).not.toHaveProperty('standalone')
  })

  it('marks a layer opened over nothing as standalone', async () => {
    const app = await ported(dashboard, { '/go': edit(), '/users': users })
    app.router.visit('/go')
    await settled()

    expect(app.entry().layers![0]).toMatchObject({ key: 'Users/Edit', url: '/users/5/edit', standalone: true })
  })

  it('defaults the key to the component name when the key is empty', async () => {
    const app = await open({ '/users/5/edit': edit({ layer: { key: '', base: '/users' } }) })
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.entry().layers![0].key).toBe('Users/Edit')
    expect(app.layers()[0].key).toBe('Users/Edit')
  })

  it('defaults the key to the component name when the layer declares none', async () => {
    const app = await open({ '/users/5/edit': edit({ layer: {} }) })
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.entry().layers![0].key).toBe('Users/Edit')
    expect(app.layers()[0].key).toBe('Users/Edit')
  })

  it('carries a null base when none was declared', async () => {
    const app = await open({ '/users/5/edit': edit({ layer: { key: 'Users/Edit' } }) })
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.sent).toEqual(['get /users/5/edit'])
    expect(app.entry().layers![0]).not.toHaveProperty('layer')
    expect(app.entry().layers![0]).not.toHaveProperty('base')
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
  })

  it('stacks onto layers already present', async () => {
    const app = await open()
    const first = app.router.layer('/users/5/edit')
    await settled()
    const second = app.router.layer('/teams/1')
    await settled()

    expect(app.entry().layers!.map((layer) => layer.id)).toEqual([first.id, second.id])
    expect(app.entry().component).toBe('Users/Index')
  })

  it('rewrites a layer whose key is already open, at its index', async () => {
    let answer: Answer = edit()
    const app = await open({ '/users/5/edit': async () => answer })

    app.router.visit('/users/5/edit')
    await settled()

    answer = edit({ props: { user: { id: 5 }, errors: { name: 'The name field is required.' } } })
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.entry().layers).toHaveLength(1)
    expect(app.entry().layers![0].props).toEqual({
      user: { id: 5 },
      errors: { name: 'The name field is required.' },
    })
  })

  it('leaves the layers above the one it rewrites where they are', async () => {
    const app = await open()
    const first = app.router.layer('/users/5/edit')
    await settled()
    const second = app.router.layer('/teams/1')
    await settled()

    app.router.visit('/users/5/edit')
    await settled()
    app.exitShells()
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([first.id])
    expect(second.state).toBe('closed')
  })

  it('keeps the id of the layer it rewrites', async () => {
    const app = await open()
    const first = app.router.layer('/users/5/edit')
    await settled()

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.entry().layers!.map((layer) => layer.id)).toEqual([first.id])
  })

  it('keeps whether the layer it rewrites was standalone', async () => {
    const cold = edit()
    const app = await ported(cold, { '/users': users, '/users/5/edit': cold }, { boot: true })
    await settled()
    const [seeded] = app.layers()

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([seeded.id])
    expect(app.entry().layers![0]).toMatchObject({ id: seeded.id, standalone: true })
  })

  it('appends a second layer of the same component opened under another key', async () => {
    const app = await open({
      '/users/6/edit': edit({ url: '/users/6/edit', layer: { key: 'Users/Edit:6', base: '/users' } }),
    })
    const first = app.router.layer('/users/5/edit')
    await settled()
    const second = app.router.layer('/users/6/edit')
    await settled()

    expect(app.entry().layers!.map((layer) => layer.id)).toEqual([first.id, second.id])
  })

  it('does not rewrite an open key when the new layer is standalone', async () => {
    const app = await ported(dashboard, {
      '/go': edit(),
      '/users': edit({ layer: { key: 'Users/Edit', base: '/dashboard' } }),
      '/dashboard': dashboard,
    })
    app.router.visit('/go')
    await settled()

    expect(app.entry().layers).toHaveLength(2)
    expect(app.entry().layers!.map((layer) => [layer.key, layer.standalone])).toEqual([
      ['Users/Edit', true],
      ['Users/Edit', true],
    ])
    expect(new Set(app.entry().layers!.map((layer) => layer.id)).size).toBe(2)
  })

  it('does not mutate the stack it rewrites', () => {
    const base = asPage(users)
    const layers = [layerEntry('a', '/a'), layerEntry('b', '/b')]
    const copy = structuredClone({ base, layers })

    compose(base, layers, false)

    expect({ base, layers }).toEqual(copy)
  })

  it('does not mutate either input', () => {
    const base = asPage(users)
    const layers = [layerEntry('a', '/a')]
    const copy = structuredClone({ base, layers })

    compose(base, layers, false)
    compose(base, layers, true)

    expect({ base, layers }).toEqual(copy)
  })

  it('updates initialDeferredProps when a rewrite brings new deferred groups', async () => {
    let answer: Answer = edit({ deferredProps: { default: ['stats'] } })
    const app = await open({
      '/users/5/edit': async (config) =>
        config.headers['X-Inertia-Partial-Data']
          ? edit({ props: { errors: {}, user: { id: 5 }, stats: 1, history: 1 } })
          : answer,
    })

    app.router.visit('/users/5/edit')
    await settled()
    expect(app.entry().layers![0].initialDeferredProps).toEqual({ default: ['stats'] })

    answer = edit({ deferredProps: { default: ['history'] } })
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.entry().layers).toHaveLength(1)
    expect(app.entry().layers![0].initialDeferredProps).toEqual({ default: ['history'] })
  })
})

describe('insertLayerBeneath', () => {
  const cold = edit()
  const fetched = page('Users/Index', '/users', {
    props: { errors: {}, users: [] },
    layer: { key: 'Users/Index', base: '/dashboard' },
  })

  const walk = async (routes: Record<string, Answer | (() => Promise<Answer>)> = {}) => {
    const app = await ported(dashboard, { '/go': cold, '/users': fetched, '/dashboard': dashboard, ...routes })

    app.router.visit('/go')
    await settled()

    return app
  }

  it('inserts the fetched base as the bottom layer', async () => {
    const app = await walk()

    expect(app.entry().layers![0]).toMatchObject({
      key: 'Users/Index',
      type: 'routed',
      component: 'Users/Index',
      props: { errors: {}, users: [] },
      url: '/users',
      standalone: true,
      entries: 0,
      owner: null,
      rescuedProps: [],
      rememberedState: {},
    })
  })

  it('keeps the page beneath the stack as the base', async () => {
    const app = await walk()

    expect(app.entry()).toMatchObject({ component: 'Dashboard', url: '/dashboard', props: { errors: {}, stats: 3 } })
    expect(await app.basePage()).toMatchObject({
      component: 'Dashboard',
      url: '/dashboard',
      props: { errors: {}, stats: 3 },
    })
  })

  it('strips the layer mark from the page', async () => {
    const app = await walk()

    expect(app.entry()).not.toHaveProperty('layer')
    expect(await app.basePage()).not.toHaveProperty('layer')
  })

  it('leaves the layers above it exactly where they were', async () => {
    const hop = held(page('Teams/Show', '/teams/1', { layer: { key: 'Teams/Show', base: '/dashboard' } }))
    const app = await walk({
      '/users': { ...fetched, layer: { key: 'Users/Index', base: '/teams/1' } },
      '/teams/1': hop.route,
    })
    const hopped = app.layers()

    expect(hopped.map((layer) => layer.key)).toEqual(['Users/Index', 'Users/Edit'])

    hop.release()
    await settled()

    const walked = app.layers()

    expect(walked.map((layer) => layer.key)).toEqual(['Teams/Show', 'Users/Index', 'Users/Edit'])
    expect(walked.slice(1)).toEqual(hopped)
  })

  it('marks the inserted layer standalone, like the ones above it', async () => {
    const app = await walk()

    expect(app.entry().layers!.map((layer) => layer.standalone)).toEqual([true, true])
  })

  it('does not rewrite a layer already open under the same key', async () => {
    const app = await walk({ '/users': { ...cold, layer: { key: 'Users/Edit', base: '/dashboard' } } })

    expect(app.entry().layers!.map((layer) => layer.key)).toEqual(['Users/Edit', 'Users/Edit'])
    expect(new Set(app.entry().layers!.map((layer) => layer.id)).size).toBe(2)
  })

  it('does not mutate the page it is given', () => {
    const base = asPage(page('', '/dashboard'))
    const layers = [layerEntry('a', '/a', { standalone: true }), layerEntry('b', '/b', { standalone: true })]
    const copy = structuredClone({ base, layers })

    compose(base, layers, true)

    expect({ base, layers }).toEqual(copy)
  })
})

describe('composeColdLayer', () => {
  const cold = edit()

  const arrive = async (visit: Record<string, unknown> = {}, answer: Answer = cold) => {
    const hop = held(users)
    const app = await ported(dashboard, { '/go': answer, '/users': hop.route })

    app.router.visit('/go', visit)
    await settled()

    return { app, hop }
  }

  it('leaves the page blank until the base beneath the layer is fetched', async () => {
    const { app } = await arrive()

    expect((await app.basePage()).component).toBe('')
  })

  it('sets the page url to the base it is fetching', async () => {
    const { app } = await arrive()

    expect((await app.basePage()).url).toBe('/users')
    expect(app.sent).toEqual(['get /go', 'get /users'])
  })

  it('marks the layer standalone, since nothing was ever beneath it', async () => {
    const { app, hop } = await arrive()

    hop.release()
    await settled()

    expect(app.entry().layers).toEqual([
      expect.objectContaining({ key: 'Users/Edit', url: '/users/5/edit', standalone: true }),
    ])
  })

  it('gives the layer no url of its own when the visit preserved the url', async () => {
    const app = await ported(users, { '/users/5/edit': cold })

    app.router.visit('/users/5/edit', { preserveUrl: true })
    await settled()

    expect(window.location.pathname).toBe('/users')
    expect(app.written().at(-1)).toEqual(['push', '/users'])
    expect(app.entry().layers![0]).toMatchObject({ key: 'Users/Edit', url: '/users/5/edit', preservesUrl: true })
  })

  it('strips the layer mark from the page', async () => {
    const { app } = await arrive()

    expect(await app.basePage()).not.toHaveProperty('layer')
  })

  it('keeps the errors the layer arrived with off the page beneath it', async () => {
    const { app } = await arrive({}, edit({ props: { user: { id: 5 }, errors: { name: 'Required.' } } }))

    expect((await app.basePage()).props).toEqual({ errors: {} })
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, errors: { name: 'Required.' } })
  })

  it('carries the flash the layer arrived with onto the page beneath it', async () => {
    const { app } = await arrive({}, edit({ flash: { message: 'Saved.' } }))

    expect((await app.basePage()).flash).toEqual({})
    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })
  })
})

describe('resolveInitialPage', () => {
  const layerAt = (url: string, component: string, base?: string) =>
    page(component, url, { props: { errors: {} }, layer: { key: component, base } })

  it('leaves a response that is not a layer exactly as it arrived', async () => {
    const response = asPage(users)

    expect(planBoot(response, '').base).toBe(response)
    expect(planBoot(response, '').layers).toEqual([])

    const app = await ported(users, {}, { boot: true })

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', url: '/users' })
    expect(app.swaps.map((swap) => swap.component)).toEqual([{ name: 'Users/Index' }])
    expect(app.layers()).toEqual([])
  })

  it('opens a layer loaded cold over a base that has not arrived yet', async () => {
    const hop = held(users)
    const app = await ported(layerAt('/users/5/edit', 'Users/Edit', '/users'), { '/users': hop.route }, { boot: true })

    expect((await app.basePage()).component).toBe('')
    expect((await app.basePage()).url).toBe('/users')
    expect(app.swaps.map((swap) => swap.component)).toEqual([{ name: 'Blank' }])
    expect(app.layers()).toEqual([
      { id: bootId('/users/5/edit'), key: 'Users/Edit', component: 'Users/Edit', url: '/users/5/edit', type: 'routed' },
    ])
    expect(app.views()[0].component).toEqual({ name: 'Users/Edit' })
  })

  it('renders a layer that declares no base as an ordinary page', async () => {
    const app = await ported(layerAt('/users/5/edit', 'Users/Edit'), {}, { boot: true })

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(app.swaps.map((swap) => swap.component)).toEqual([{ name: 'Users/Edit' }])
    expect(app.layers()).toEqual([])
  })

  it('does not touch the response it was given', () => {
    const response = asPage(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    const copy = structuredClone(response)

    planBoot(response, '#profile')

    expect(response).toEqual(copy)
  })

  it("puts the browser's hash on the layer that owns the address", async () => {
    const app = await ported(
      layerAt('/users/5/edit', 'Users/Edit', '/users'),
      { '/users': held(users).route },
      {
        boot: true,
        href: 'http://localhost/users/5/edit#profile',
      },
    )

    expect(app.layers()[0].url).toBe('/users/5/edit#profile')
    expect((await app.basePage()).url).toBe('/users')
  })

  it('does not append the hash to a url that already carries it', async () => {
    const app = await ported(
      layerAt('/users/5/edit#profile', 'Users/Edit', '/users'),
      { '/users': held(users).route },
      {
        boot: true,
        href: 'http://localhost/users/5/edit#profile',
      },
    )

    expect(app.layers()[0].url).toBe('/users/5/edit#profile')
  })

  it('resolves the base a cold open is missing through the loading resolver', async () => {
    const seen: unknown[] = []
    const app = await ported(
      layerAt('/users/5/edit', 'Users/Edit', '/users'),
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url, context) => {
          seen.push([url, context])

          return { name: 'Loading' }
        },
      },
    )

    expect(app.swaps[0].component).toEqual({ name: 'Loading' })
    expect(seen).toEqual([
      [
        '/users',
        {
          layers: [
            {
              id: bootId('/users/5/edit'),
              key: 'Users/Edit',
              component: 'Users/Edit',
              url: '/users/5/edit',
              type: 'routed',
            },
          ],
        },
      ],
    ])
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
  })

  it('never calls the loading resolver for an ordinary page', async () => {
    const app = await ported(
      users,
      {},
      {
        boot: true,
        loading: () => {
          throw new Error('consulted')
        },
      },
    )

    expect(app.swaps[0].component).toEqual({ name: 'Users/Index' })
  })
})

describe('loadingBase', () => {
  const cold = layerAtBase('/users/5/edit', 'Users/Edit', '/users')

  it('is the base the blank page is waiting on', async () => {
    const seen: unknown[] = []
    await ported(
      cold,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url) => void seen.push(url),
      },
    )

    expect(seen).toEqual(['/users'])
  })

  it("is the blank page's own url once the layer above it has gone", async () => {
    const seen: unknown[] = []
    const app = await ported(
      cold,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url, context) => void seen.push([url, context.layers.length]),
      },
    )

    seen.length = 0
    void app.router.close()
    await settled()
    app.exitShells()
    await settled()
    await app.resolve('', asPage(page('', '/users')))

    expect(app.layers()).toEqual([])
    expect(seen).toEqual([['/users', 0]])
  })

  it('is undefined for a page that has a component', async () => {
    const seen: unknown[] = []
    const app = await ported(users, {}, { boot: true, loading: (url) => void seen.push(url) })

    await app.resolve('Users/Index', asPage(users))

    expect(seen).toEqual([])
  })
})

describe('normalizeLoading', () => {
  const blank = { render: () => null }
  const resolver = async (
    loading: ((url: string, context: { layers: readonly unknown[] }) => unknown) | undefined,
    resolve: (name: string) => unknown = (name) => ({ name }),
  ) => {
    const { layerSlot } = await import('../../../src')

    return layerSlot.wrapResolver(resolve as never, loading as never, blank as never) as (
      name: string,
      page?: Page,
    ) => Promise<unknown>
  }
  const blankPage = asPage(page('', '/users'))

  it('resolves the blank when no option was given', async () => {
    await expect((await resolver(undefined))('', blankPage)).resolves.toBe(blank)
  })

  it('resolves a component as itself', async () => {
    const component = { render: () => null }

    await expect((await resolver(() => component))('', blankPage)).resolves.toBe(component)
  })

  it('resolves a module to the component it carries', async () => {
    const component = { render: () => null }

    await expect((await resolver(() => ({ default: component })))('', blankPage)).resolves.toBe(component)
  })

  it('hands a resolver the url and the page, and resolves what it returns', async () => {
    const component = { render: () => null }
    const seen: unknown[] = []
    const resolve = await resolver((url, context) => {
      seen.push(url, context)

      return component
    })

    await expect(resolve('', blankPage)).resolves.toBe(component)
    expect(seen).toEqual(['/users', { layers: [] }])
  })

  it('unwraps the module a resolver imports', async () => {
    const component = { render: () => null }

    await expect((await resolver(() => Promise.resolve({ default: component })))('', blankPage)).resolves.toBe(
      component,
    )
  })

  it('resolves the blank when the resolver declines', async () => {
    await expect((await resolver(() => undefined))('', blankPage)).resolves.toBe(blank)
  })

  it('resolves a component that throws when called as itself', async () => {
    const component = () => {
      throw new Error('not a resolver')
    }

    await expect((await resolver(() => component))('', blankPage)).resolves.toBe(component)
  })

  it('resolves a component whose call the rendered check recognises as itself', async () => {
    const component = () => ({ vnode: true })

    await expect((await resolver(() => component))('', blankPage)).resolves.toBe(component)
  })
})

describe('resolving a blank base through the page', () => {
  const coldEdit = layerAtBase('/users/5/edit', 'Users/Edit', '/users')

  it('resolves the placeholder for the base the blank is missing', async () => {
    const app = await ported(
      coldEdit,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url, { layers }) => ({ name: `loading:${url}:${layers.length}` }),
      },
    )

    await expect(app.resolve('', asPage(page('', '/users')))).resolves.toEqual({ name: 'loading:/users:1' })
  })

  it('resolves the placeholder for a blank page whose layer was dismissed', async () => {
    const app = await ported(
      coldEdit,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url) => ({ name: `loading:${url}` }),
      },
    )

    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    await expect(app.resolve('', asPage(page('', '/users')))).resolves.toEqual({ name: 'loading:/users' })
  })

  it('resolves nothing without a loading resolver', async () => {
    const app = await ported(coldEdit, { '/users': held(users).route }, { boot: true })

    await expect(app.resolve('', asPage(page('', '/users')))).resolves.toEqual({ name: 'Blank' })
  })

  it('never sends a blank page to the ordinary resolver', async () => {
    const named: string[] = []
    const app = await ported(
      coldEdit,
      { '/users': held(users).route },
      {
        boot: true,
        resolveComponent: (name) => {
          named.push(name)

          return { name }
        },
      },
    )

    named.length = 0
    await app.resolve('', asPage(page('', '/users')))

    expect(named).toEqual([])
  })
})

describe('layerPageOf', () => {
  const versioned = page('Users/Index', '/users', {
    props: { errors: { other: 'x' }, users: [] },
    version: 'v9',
    clearHistory: true,
  })

  const layerWith = (extra: Answer = {}) =>
    edit({ version: 'v9', props: { user: { id: 5 }, errors: { name: 'required' } }, ...extra })

  it("swaps in the layer's component, props and url in place of the page's", async () => {
    const app = await ported(versioned, { '/users/5/edit': layerWith() })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page).toMatchObject({
      component: 'Users/Edit',
      props: { user: { id: 5 }, errors: { name: 'required' } },
      url: '/users/5/edit',
    })
    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', url: '/users' })
  })

  it('keeps the global version and clearHistory for the layer', async () => {
    const app = await ported(versioned, { '/users/5/edit': layerWith({ clearHistory: true }) })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.version).toBe('v9')
    expect(app.views()[0].page.clearHistory).toBe(true)
  })

  it("reads errors from the layer's own props, not the page's", async () => {
    const app = await ported(versioned, { '/users/5/edit': layerWith() })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.props.errors).toEqual({ name: 'required' })
    expect((await app.basePage()).props.errors).toEqual({ other: 'x' })
  })

  it("carries the stack as structure only, never another tier's props", async () => {
    const app = await ported(users, {
      '/a': page('A', '/a', { layer: { key: 'A', base: '/users' } }),
      '/users/5/edit': edit(),
    })

    app.router.visit('/a')
    await settled()
    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[1].page).not.toHaveProperty('layers')
    expect(app.layers().slice(0, 1)).toEqual([
      { id: app.layers()[0].id, key: 'A', component: 'A', url: '/a', type: 'routed' },
    ])
  })

  it('takes encryptHistory from the layer, never from the page beneath it', async () => {
    const app = await ported(page('Users/Index', '/users', { encryptHistory: true }), {
      '/users/5/edit': edit({ encryptHistory: false }),
    })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.encryptHistory).toBe(false)
    expect((await app.basePage()).encryptHistory).toBe(true)
  })

  it("reads the flash the layer itself carries, never the page's", async () => {
    const app = await ported(page('Users/Index', '/users', { flash: { message: 'composite' } }), {
      '/users/5/edit': edit({ flash: { message: 'layer' } }),
    })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.flash).toEqual({ message: 'layer' })
    expect((await app.basePage()).flash).toEqual({ message: 'composite' })
  })

  it("resolves a layer component with the layer's own page, not the whole page", async () => {
    const resolved: [string, Page | undefined][] = []
    const app = await ported(
      users,
      { '/users/5/edit': edit() },
      {
        resolveComponent: (name, resolving) => {
          resolved.push([name, resolving])

          return { name }
        },
      },
    )

    app.router.visit('/users/5/edit')
    await settled()

    const layerResolve = resolved.find(([name]) => name === 'Users/Edit')

    expect(layerResolve![1]).toMatchObject({
      component: 'Users/Edit',
      props: { errors: {}, user: { id: 5 } },
      url: '/users/5/edit',
    })
    expect(layerResolve![1]).not.toHaveProperty('layers')
    expect(layerResolve![1]).toEqual(app.views()[0].page)
  })
})
