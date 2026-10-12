import { describe, expect, it } from 'vitest'
import { layerDialogAttributes } from '../../src/layers/dialog'
import { createLayoutPropsStore } from '../../src/layout'
import { openApp } from './support/app'
import { page, settled } from './support/browser'
import { edit, teams, users } from './support/pages'

const usersPage = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })

describe('resolveLayers, the layout page', () => {
  it('leaves the url empty for a layer with no url of its own, so it never reaches the address', async () => {
    const app = await openApp(usersPage(), {})

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

  it('keeps the layer url when the layer has one', async () => {
    const app = await openApp(users, { '/users/5/edit': edit() })

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.views()[0].page.url).toBe('/users/5/edit')
  })

  it('derives the shell props from the layer and its place on the stack', async () => {
    const app = await openApp(users, { '/users/5/edit': edit(), '/teams/1': teams })
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
    const app = await openApp(users, { '/users/5/edit': edit() })
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
    const app = await openApp(users, { '/users/5/edit': edit() })
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
    const app = await openApp(users, {})

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.views()[0].shell.type).toBe('local')
  })
})

describe('createLayoutPropsStore, per-layer slots', () => {
  const twoLayers = async () => {
    const app = await openApp(users, { '/users/5/edit': edit(), '/teams/1': teams })
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
    const app = await openApp(users, { '/users/5/edit': edit(), '/other': page('Other', '/other') })
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

  it('snapshot holds the page and every layer at once', async () => {
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
