import { describe, expect, it } from 'vitest'
import { planBoot, compose } from '../../src/layers/entry'
import { marksOf } from '../../src/layers/facts'
import { asPage, dashboard, edit, users, type Answer, held, layerEntry, teams } from './support/layers-fixtures'
import { page, ported, settled, failure } from './support/support'

const usersPage = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const layer = (name: string, url: string) => page(name, url, { layer: { key: name, base: '/users' } })

describe('composeLayer', () => {
  it('strips the layer mark from the layer it composes', async () => {
    const edit = page('Users/Edit', '/users/5/edit', {
      props: { errors: {}, user: { id: 5 } },
      layer: { key: 'Users/Edit', base: '/users' },
    })
    const app = await ported(usersPage(), { '/users/5/edit': edit })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.layers().map((open) => open.key)).toEqual(['Users/Edit'])
    expect(app.entry().layers![0]).not.toHaveProperty('layer')
    expect(app.views()[0].page).not.toHaveProperty('layer')
  })
})

describe('promoteDeepestLayer', () => {
  const editBeneath = page('Users/Edit', '/users/5/edit', {
    props: { errors: {} },
    layer: { key: 'Users/Edit', base: '/users/5' },
  })

  const show = (extra: Answer = {}) =>
    page('Users/Show', '/users/5?tab=profile', {
      props: { errors: {}, user: { id: 5 } },
      layer: { key: 'Users/Show', base: '/users' },
      ...extra,
    })

  const promoted = async (answers: { show?: Answer; initial?: Answer; cold?: Answer; pending?: boolean } = {}) => {
    const app = await ported(answers.initial ?? dashboard, {
      '/go': answers.cold ?? editBeneath,
      '/users/5': answers.show ?? show(),
      '/users/5?tab=profile': () =>
        answers.pending
          ? new Promise<Answer>(() => {})
          : Promise.resolve(
              page('Users/Show', '/users/5?tab=profile', { props: { errors: {}, user: { id: 5 }, activity: [] } }),
            ),
      '/users': failure,
    })

    app.router.visit('/go')
    await settled()

    return app
  }

  it('makes the deepest layer the page the rest of the stack stands on', async () => {
    const app = await promoted()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Show',
      props: { errors: {}, user: { id: 5 } },
      url: '/users/5?tab=profile',
    })
  })

  it('leaves the layers above it standing', async () => {
    const app = await promoted()

    expect(app.layers().map((layer) => [layer.key, layer.url])).toEqual([['Users/Edit', '/users/5/edit']])
    expect(app.entry().layers).toEqual([expect.objectContaining({ key: 'Users/Edit', standalone: true })])
  })

  it('has no stack left when the layer it promotes is the only one', async () => {
    const app = await promoted({
      cold: page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit', base: '/users' } }),
    })

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('carries the encryption the promoted layer asked for onto the page', async () => {
    const app = await promoted({
      cold: page('Users/Edit', '/users/5/edit', {
        layer: { key: 'Users/Edit', base: '/users' },
        encryptHistory: true,
      }),
    })

    expect((await app.basePage()).encryptHistory).toBe(true)
    expect(app.rawEntry()).toBeInstanceOf(ArrayBuffer)
  })

  it('does not carry the flash of the base it discards onto the page', async () => {
    const app = await promoted({ initial: { ...dashboard, flash: { message: 'Saved.' } } })

    expect((await app.basePage()).flash).toEqual({})
  })

  it('leaves a page with no layers alone', async () => {
    const app = await ported(users, {}, { boot: true })

    expect(await app.basePage()).toEqual({
      ...users,
      flash: {},
      rescuedProps: [],
      rememberedState: {},
    })
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it("carries the promoted layer's deferred, rescued, once and scroll props onto the page", async () => {
    const notes = { pageName: 'page', previousPage: null, nextPage: 2, currentPage: 1, reset: false }
    const app = await promoted({
      pending: true,
      show: show({
        deferredProps: { default: ['activity'] },
        rescuedProps: ['permissions'],
        onceProps: { banner: { prop: 'banner' } },
        scrollProps: { notes },
      }),
    })

    const base = await app.basePage()

    expect(base.deferredProps).toEqual({ default: ['activity'] })
    expect(base.initialDeferredProps).toEqual({ default: ['activity'] })
    expect(base.rescuedProps).toEqual(['permissions'])
    expect(base.onceProps).toEqual({ banner: { prop: 'banner' } })
    expect(base.scrollProps).toEqual({ notes })
  })

  it("leaves the promoted layer's stack fields behind", async () => {
    const app = await promoted()
    const base = await app.basePage()

    expect(base).not.toHaveProperty('id')
    expect(base).not.toHaveProperty('key')
    expect(base).not.toHaveProperty('standalone')
    expect(base).not.toHaveProperty('entries')
    expect(base).not.toHaveProperty('owner')
    expect(base).not.toHaveProperty('layer')
  })
})

describe('promoteLayer', () => {
  const response = () =>
    page('Users/Edit', '/users/5/edit', { props: { errors: {}, users: [] }, layer: { key: 'Users/Edit' } })

  const promote = async () => {
    const app = await ported(dashboard, { '/go': response() })

    app.router.visit('/go')
    await settled()

    return app
  }

  it('drops the layer mark and the stack', async () => {
    const app = await promote()

    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(await app.basePage()).not.toHaveProperty('layers')
    expect(app.entry()).not.toHaveProperty('layer')
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.layers()).toEqual([])
  })

  it('keeps everything the page itself is made of', async () => {
    const app = await promote()

    expect(await app.basePage()).toEqual({
      component: 'Users/Edit',
      url: '/users/5/edit',
      props: { errors: {}, users: [] },
      version: 'v1',
      flash: {},
      rescuedProps: [],
      rememberedState: {},
    })
  })

  it('does not mutate the response', () => {
    const marked = asPage(response())
    const copy = structuredClone(marked)

    planBoot(marked, '#profile')

    expect(marked).toEqual(copy)
  })
})

describe('closeLayer', () => {
  const panel = (name: string) => page(`Panels/${name}`, `/panels/${name}`, { layer: { key: name, base: '/users' } })

  const open = async (...names: string[]) => {
    const app = await ported(users, {
      '/users': users,
      ...Object.fromEntries(names.map((name) => [`/panels/${name}`, panel(name)])),
    })
    const handles = []

    for (const name of names) {
      handles.push(app.router.layer(`/panels/${name}`))
      await settled()
    }

    return { app, handles }
  }

  const closed = async (app: Awaited<ReturnType<typeof ported>>, id?: string) => {
    const done = app.router.close(id)

    await settled()
    app.exitShells()
    await settled()

    return done
  }

  it('leaves the page the stack was drawn over', async () => {
    const { app } = await open('A')

    await closed(app)

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', url: '/users' })
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.layers()).toEqual([])
  })

  it('removes every layer above the one being closed', async () => {
    const { app, handles } = await open('A', 'B', 'C')

    await closed(app, handles[1].id)

    expect(app.layers().map((layer) => layer.id)).toEqual([handles[0].id])
    expect(handles.map((handle) => handle.state)).toEqual(['open', 'closed', 'closed'])
  })

  it('keeps a base remember key named after the layer it closes', async () => {
    const { app, handles } = await open('A')

    app.router.remember('mine', handles[0].id)
    await closed(app)

    expect((await app.basePage()).rememberedState).toEqual({ [handles[0].id]: 'mine' })
  })

  it('leaves the stack alone when the layer is not on it', async () => {
    const { app, handles } = await open('A', 'B')

    await closed(app, 'missing')

    expect(app.layers().map((layer) => layer.id)).toEqual(handles.map((handle) => handle.id))
    expect(handles.map((handle) => handle.state)).toEqual(['open', 'open'])
  })

  it('does not mutate the page', async () => {
    const { app } = await open('A')
    const before = structuredClone(await app.basePage())

    await closed(app)

    expect(await app.basePage()).toEqual(before)
  })
})

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
