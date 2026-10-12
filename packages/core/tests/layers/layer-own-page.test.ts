import { describe, expect, it } from 'vitest'
import type { Page } from '../../src/types'
import { edit, users, type Answer } from './support/layers-fixtures'
import { page, ported, settled } from './support/support'

const usersPage = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const layer = (name: string, url: string) => page(name, url, { layer: { key: name, base: '/users' } })

describe('layerPageOf', () => {
  it('falls back to the address for a layer with no url of its own', async () => {
    const app = await ported(usersPage(), {})

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.views()[0].page.url).toBe('/users')
  })

  it('falls back to the address beneath it, never the address of a layer above it', async () => {
    const notes = page('Users/Notes', '/users/9/notes', { layer: { key: 'notes', base: '/users' } })
    const app = await ported(usersPage(), { '/users/9/notes': notes, '/a': layer('A', '/a') })

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
    const app = await ported(usersPage(), { '/users?page=2': { ...usersPage(), url: '/users?page=2' } })

    app.router.layer({ component: 'Prompt' })
    await settled()
    app.router.visit('/users?page=2', { only: ['users'], preserveState: true, preserveScroll: true })
    await settled()

    expect(app.layers().map((open) => open.type)).toEqual(['local'])
    expect(app.views()[0].page.url).toBe('/users?page=2')
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
