import { describe, expect, it } from 'vitest'
import { layerDialogAttributes } from '../../../src/layers/dialog'
import { addressOf, planBoot } from '../../../src/layers/entry'
import { createLayoutPropsStore } from '../../../src/layout'
import { asPage, dashboard, edit, layerEntry, teams, users } from './layers-fixtures'
import type { Answer } from './layers-fixtures'
import { failure, page, ported, settled } from './support'

describe('resolveLayers, the layout page', () => {
  const localEdit = { component: 'Users/Edit', props: { user: { id: 5 }, errors: { name: 'required' } } }

  it('keeps the layer url when the layer has one', async () => {
    const app = await ported(users, { '/users/5/edit': edit() })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.url).toBe('/users/5/edit')
  })

  it('derives the shell props from the layer and its place on the stack', async () => {
    const app = await ported(users, { '/users/5/edit': edit(), '/teams/1': teams })
    const first = app.router.layer('/users/5/edit')
    await settled()
    const second = app.router.layer('/teams/1')
    await settled()

    void app.router.close(second.id)
    await settled()

    expect(app.views().map((view) => view.shell)).toEqual([
      expect.objectContaining({ open: true, index: 0, isTop: false, type: 'routed' }),
      expect.objectContaining({ open: false, index: 1, isTop: true, type: 'routed' }),
    ])
    expect(app.views().map((view) => view.attributes.style.viewTransitionName)).toEqual([
      `inertia-layer-${first.id}`,
      `inertia-layer-${second.id}`,
    ])
    expect(app.views().map((view) => view.attributes['data-layer-id'])).toEqual([first.id, second.id])
  })

  it('reads a layer id back off the wrapper carrying its attributes', async () => {
    const app = await ported(users, { '/users/5/edit': edit() })
    const handle = app.router.layer('/users/5/edit')
    await settled()

    const wrapper = { parentElement: null } as unknown as Element
    const inner = { parentElement: wrapper } as unknown as Element
    const stranger = { parentElement: null } as unknown as Element

    app.core.layerSlot.bindElement(handle.id, wrapper)

    expect(app.core.layerSlot.scopeOf(inner)?.id).toBe(handle.id)
    expect(app.core.layerSlot.scopeOf(wrapper)?.id).toBe(handle.id)
    expect(app.core.layerSlot.scopeOf(stranger)).toBeNull()
  })

  it('invents no accessible name, leaving the app to give the dialog one', async () => {
    const app = await ported(users, { '/users/5/edit': edit() })
    app.router.layer('/users/5/edit')
    await settled()

    const attributes = layerDialogAttributes(app.views()[0].shell)

    expect(attributes).not.toHaveProperty('aria-label')
    expect(attributes).toEqual({
      open: true,
      'data-layer-index': 0,
      'data-layer-top': 'true',
      'data-layer-closing': 'false',
      'data-layer-type': 'routed',
    })
  })

  it('marks a local layer as one for the shell', async () => {
    const app = await ported(users, {})

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.views()[0].shell.type).toBe('local')
  })
})

describe('createLayoutPropsStore, per-layer slots', () => {
  const twoLayers = async () => {
    const app = await ported(users, { '/users/5/edit': edit(), '/teams/1': teams })
    const first = app.router.layer('/users/5/edit')
    await settled()
    const second = app.router.layer('/teams/1')
    await settled()

    return { app, first, second }
  }

  it("writes a layer's layout props to that layer alone, leaving the page's untouched", async () => {
    const { app, first } = await twoLayers()
    const base = createLayoutPropsStore()

    base.set({ base: 'chrome' })
    app.router.layerHandle(first.id)!.setLayoutProps({ fromLayer: 'panel' })

    expect(app.views()[0].layout.get()).toEqual({ shared: { fromLayer: 'panel' }, named: {} })
    expect(app.views()[1].layout.get()).toEqual({ shared: {}, named: {} })
    expect(base.get()).toEqual({ shared: { base: 'chrome' }, named: {} })
  })

  it('writes a named slot beside the shared one for the same layer', async () => {
    const { app, first } = await twoLayers()
    const scope = app.router.layerHandle(first.id)!

    scope.setLayoutProps('header' as never, { title: 'Settings' } as never)
    scope.setLayoutProps({ fromLayer: 'panel' })

    expect(app.views()[0].layout.get()).toEqual({
      shared: { fromLayer: 'panel' },
      named: { header: { title: 'Settings' } },
    })
  })

  it('retainLayers drops every slot outside the stack; reset() leaves the layer slots alone', async () => {
    const { app, first, second } = await twoLayers()
    const base = createLayoutPropsStore()

    base.set({ base: 'chrome' })
    app.router.layerHandle(first.id)!.setLayoutProps({ fromLayer: 'panel' })
    app.router.layerHandle(second.id)!.setLayoutProps({ other: 'x' })

    void app.router.close(second.id)
    await settled()
    app.exitShells()
    await settled()

    expect(app.router.layerHandle(second.id)).toBeUndefined()
    expect(app.views().map((view) => view.id)).toEqual([first.id])
    expect(app.views()[0].layout.get()).toEqual({ shared: { fromLayer: 'panel' }, named: {} })

    base.reset()

    expect(base.get()).toEqual({ shared: {}, named: {} })
    expect(app.views()[0].layout.get()).toEqual({ shared: { fromLayer: 'panel' }, named: {} })

    app.router.layer('/teams/1')
    await settled()

    expect(app.views()[1].layout.get()).toEqual({ shared: {}, named: {} })
  })

  it('swap drops the base slot unless state is preserved, and every layer slot no longer on the stack', async () => {
    const app = await ported(users, { '/users/5/edit': edit(), '/other': page('Other', '/other') })
    const handle = app.router.layer('/users/5/edit')
    await settled()
    const scope = app.router.layerHandle(handle.id)!

    scope.setLayoutProps({ other: 'x' })
    scope.router.visit('/users/5/edit', { preserveState: true })
    await settled()

    expect(app.views()[0].layout.get()).toEqual({ shared: { other: 'x' }, named: {} })

    scope.router.visit('/users/5/edit', { preserveState: false })
    await settled()

    expect(app.views()[0].layout.get()).toEqual({ shared: {}, named: {} })

    scope.setLayoutProps({ other: 'y' })
    app.router.visit('/other')
    await settled()

    expect(app.layers()).toEqual([])
    expect(app.router.layerHandle(handle.id)).toBeUndefined()
  })

  it('snapshot holds every tier at once', async () => {
    const { app, first, second } = await twoLayers()
    const base = createLayoutPropsStore()

    base.set({ base: 'chrome' })
    app.router.layerHandle(first.id)!.setLayoutProps('header' as never, { title: 'Settings' } as never)

    expect({
      base: base.get(),
      layers: Object.fromEntries(app.views().map((view) => [view.id, view.layout.get()])),
    }).toEqual({
      base: { shared: { base: 'chrome' }, named: {} },
      layers: {
        [first.id]: { shared: {}, named: { header: { title: 'Settings' } } },
        [second.id]: { shared: {}, named: {} },
      },
    })
  })

  it('setFor still names a slot, as it did before layers', () => {
    const store = createLayoutPropsStore()

    store.setFor('header' as never, { title: 'Settings' } as never)

    expect(store.get()).toEqual({ shared: {}, named: { header: { title: 'Settings' } } })
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

describe('openLayerFor', () => {
  const panel = (url: string, base?: string) =>
    page('Panel', url, { props: { errors: {}, at: url }, layer: { key: 'Panel', base } })

  const twoPanels = async () => {
    const app = await ported(dashboard, {
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
    const app = await ported(users, { '/panels/3': panel('/panels/3', '/users') })
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

describe('withAddressHash', () => {
  it('writes the hash onto the page url when there are no layers', async () => {
    const app = await ported(users, {})

    await app.anchor('/users#comments')

    expect(app.entry().url).toBe('http://localhost/users#comments')
  })

  it('writes it onto the page url when no layer has one', async () => {
    const app = await ported(users, {})
    app.router.layer({ component: 'Prompt' })
    await settled()

    await app.anchor('/users#comments')

    expect(app.entry().url).toBe('http://localhost/users#comments')
    expect(app.entry().layers!.map((layer) => [layer.type, layer.url])).toEqual([['local', '']])
  })

  it('replaces a hash the address already carries', async () => {
    const app = await ported(page('Users/Index', '/users#top'), {}, { href: 'http://localhost/users#top' })

    await app.anchor('/users#comments')

    expect(app.entry().url).toBe('http://localhost/users#comments')
  })

  it('does not mutate the page it is given', async () => {
    const app = await ported(users, { '/a': page('A', '/a', { layer: { key: 'A', base: '/users' } }) })
    app.router.visit('/a')
    await settled()
    const before = structuredClone(app.views()[0].page)

    await app.anchor('/a#comments')

    expect(app.views()[0].page).toEqual(before)
    expect(app.views()[0].page.url).toBe('/a')
  })
})

describe('encryptsHistory', () => {
  const encrypted = (app: Awaited<ReturnType<typeof ported>>) => app.rawEntry() instanceof ArrayBuffer

  const stacked = async (base: Answer, ...layers: Answer[]) => {
    const routes: Record<string, Answer> = {}

    layers.forEach((layer, index) => {
      routes[`/l${index}`] = page(`L${index}`, `/l${index}`, { layer: { key: `L${index}`, base: '/users' }, ...layer })
    })

    const app = await ported({ ...users, ...base }, routes)

    for (let index = 0; index < layers.length; index++) {
      app.router.visit(`/l${index}`)
      await settled()
    }

    return app
  }

  it('is false for a page nobody asked to encrypt', async () => {
    const app = await ported(users, {})

    expect(app.entry()).toMatchObject({ component: 'Users/Index', url: '/users' })
    expect(encrypted(app)).toBe(false)
  })

  it('is true for a page that asks for it', async () => {
    const app = await ported({ ...users, encryptHistory: true }, {})

    expect(encrypted(app)).toBe(true)
  })

  it('is false when neither the base nor its layer asks for it', async () => {
    const app = await stacked({}, {})

    expect(app.layers()).toHaveLength(1)
    expect(encrypted(app)).toBe(false)
  })

  it('is true when only the layer asks for it', async () => {
    const app = await stacked({}, { encryptHistory: true })

    expect(app.layers()).toHaveLength(1)
    expect(encrypted(app)).toBe(true)
  })

  it('is true when only the base asks for it', async () => {
    const app = await stacked({ encryptHistory: true }, {})

    expect(app.layers()).toHaveLength(1)
    expect(encrypted(app)).toBe(true)
  })

  it('is true when any layer in the stack asks for it', async () => {
    const app = await stacked({}, {}, { encryptHistory: true }, {})

    expect(app.layers()).toHaveLength(3)
    expect(encrypted(app)).toBe(true)
  })

  it('reads a layer with no encryptHistory of its own as not asking', async () => {
    const app = await stacked({}, {})

    expect(app.views()[0].page).not.toHaveProperty('encryptHistory')
    expect(encrypted(app)).toBe(false)
  })

  it('still reads the base beneath a layer with no encryptHistory of its own', async () => {
    const app = await stacked({ encryptHistory: true }, {})

    expect(app.views()[0].page).not.toHaveProperty('encryptHistory')
    expect(encrypted(app)).toBe(true)
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

describe('history entry counting', () => {
  const panel = page('A', '/a', { layer: { key: 'A', base: '/users' } })

  const unwound = () => {
    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)

    return deltas
  }

  it('never counts a layer below zero entries', async () => {
    const app = await ported(users, { '/a': panel, '/users': users })

    app.router.visit('/a', { replace: true })
    await settled()

    expect(app.entry().layers![0].entries).toBe(0)

    const deltas = unwound()
    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([])
    expect(app.layers()).toEqual([])
  })

  it('does nothing on a page with no layers', async () => {
    const app = await ported(users, { '/other': page('Other', '/other') })
    const before = structuredClone(await app.basePage())

    await app.router.close()
    await settled()

    expect(await app.basePage()).toEqual(before)
    expect(app.entry()).not.toHaveProperty('layers')
    expect(app.layers()).toEqual([])
  })
})
