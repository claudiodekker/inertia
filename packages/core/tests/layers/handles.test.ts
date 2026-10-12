import { describe, expect, it } from 'vitest'
import { openApp } from './support/app'
import { settled, page } from './support/browser'
import { counted, holdBack, veto } from './support/handles'
import { base, edit, notes } from './support/pages'

describe('a partial a layer made', () => {
  it("keeps a layer's handle when a partial it made is answered by a page that keeps the stack", async () => {
    const app = await openApp(base(), {
      '/users/5/edit': edit(),
      '/users?search=x': base({ url: '/users?search=x', props: { users: [{ id: 9 }], errors: {} } }),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    const outcome = await new Promise<string>((resolve) => {
      app.router.layerHandle(handle.id)!.router.visit('http://localhost/users?search=x', {
        only: ['users'],
        onSuccess: () => resolve('success'),
        onError: () => resolve('error'),
      })
    })

    await settled()

    expect(outcome).toBe('success')
    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('open')
    expect((await app.basePage()).props).toEqual({ users: [{ id: 9 }], errors: {} })
  })
})

describe('the layer handle lookup', () => {
  it('keeps no handle when there is no browser, so a server render never shares one', async () => {
    const app = await openApp(base(), {})
    const browser = globalThis.window

    try {
      // @ts-expect-error the render has no window to read
      delete globalThis.window

      expect(app.router.layerHandle('rendered-layer')).toBeUndefined()
      expect(app.router.layerHandle()).toBeUndefined()
      await expect(app.router.close()).resolves.toBeUndefined()
    } finally {
      globalThis.window = browser
    }

    expect(app.router.layerHandle('rendered-layer')).toBeUndefined()
  })

  it('hands back the handle written for a layer id', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const scope = app.router.layerHandle(handle.id)!

    expect(scope.id).toBe(handle.id)
    expect(scope.key).toBe('Users/Edit')
    expect(app.router.layerHandle(handle.id)).toBe(scope)
    expect(app.router.layerHandle()).toBe(scope)
  })

  it('releases the handle of a layer once its removal has settled', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const browser = holdBack()
    const closing = handle.close()

    await settled()
    app.exitShells()
    await settled()

    expect(app.router.layerHandle(handle.id)).toBeDefined()

    browser.answer()
    await closing

    expect(app.router.layerHandle(handle.id)).toBeUndefined()
  })

  it('releases the handle of a layer whose close is dropped', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users/5': page('Users/Show', '/users/5') })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()
    void handle.close()
    await settled()
    app.router.visit('http://localhost/users/5')
    await settled()

    expect(app.router.layerHandle(handle.id)).toBeUndefined()
    expect(app.layers()).toEqual([])
  })

  it('keeps the handle of a layer that is superseded under its own id', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()
    void handle.close()
    await settled()
    app.router.layer('http://localhost/users/5/edit')
    await settled()

    expect(app.router.layerHandle(handle.id)?.id).toBe(handle.id)
    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
  })
})

describe('router.layer: the routed handle', () => {
  it('returns a handle that subscribes and closes', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    expect(app.layers()).toHaveLength(1)
    expect(typeof handle.on).toBe('function')
    expect(typeof handle.onClose).toBe('function')
    expect(typeof handle.close).toBe('function')

    const heard: unknown[] = []
    handle.on('saved', (payload) => heard.push(payload))
    app.router.layerHandle(handle.id)!.emit('saved', 1)

    expect(heard).toEqual([])
    expect(handle.state).toBe('open')
  })

  it('composes a warm layer under the id the handle was created with, and close() dismisses it', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const go = app.go()

    await settled()

    const [layer] = app.layers()

    expect(layer.id).toBe(handle.id)
    expect(app.router.layerHandle(layer.id)!.id).toBe(handle.id)

    const closing = handle.close()
    await settled()
    app.exitShells()
    await closing
    await settled()

    expect(go).toEqual([-1])
    expect(window.location.pathname).toBe('/users')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('closes the handle of an open whose base moved in flight, composing nothing', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await openApp(base(), {
      '/users/5/edit': () => held.then(() => edit()),
      '/users/archive': page('Users/Archive', '/users/archive'),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.visit('/users/archive', { async: true })
    await settled()
    answer()
    await settled()

    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
    expect(app.layers()).toEqual([])
    expect((await app.basePage()).component).toBe('Users/Archive')
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('re-keys the handle when the stack takes the id it was created with, and close() still works', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await openApp(base(), {
      '/users/5/edit': () => held.then(() => edit()),
      '/teams/9': page('Teams/Show', '/teams/9', { layer: { key: 'Teams/Show', base: '/users' } }),
      '/users': base(),
    })
    const handle = app.router.layer('http://localhost/users/5/edit', { async: true })
    const created = handle.id

    await settled()
    const taken = app.router.layer('http://localhost/teams/9')
    await settled()
    answer()
    await settled()

    expect(app.layers().map((layer) => [layer.key, layer.id])).toEqual([
      ['Teams/Show', taken.id],
      ['Users/Edit', handle.id],
    ])
    expect(handle.id).toBe(created)
    expect(taken.id).not.toBe(handle.id)

    const go = app.go()

    await app.closing(handle)

    expect(go).toEqual([-1])
    expect(app.layers().map((layer) => layer.id)).toEqual([taken.id])
    expect(handle.state).toBe('closed')
    expect(taken.state).toBe('open')
  })

  it('takes over the layer already open under the key, rather than opening another', async () => {
    const app = await openApp(base(), {
      '/users/5/edit': edit({ props: { user: { id: 5, name: 'Renamed' }, errors: {} } }),
      '/users': base(),
    })

    app.router.visit('/users/5/edit')
    await settled()

    const [open] = app.layers()
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([open.id])
    expect(handle.id).toBe(open.id)
    expect(handle.state).toBe('open')
    expect(app.views()[0].page.props).toEqual({ user: { id: 5, name: 'Renamed' }, errors: {} })

    const go = app.go()

    await app.closing(handle)

    expect(go).toEqual([-1])
    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/users')
  })

  it('keeps the first handle listening when a second open takes over the layer, and closes both', async () => {
    const answers = [edit(), edit({ props: { user: { id: 5, name: 'Renamed' }, errors: {} } })]
    const app = await openApp(base(), { '/users/5/edit': () => Promise.resolve(answers.shift()!), '/users': base() })
    const first = app.router.layer('http://localhost/users/5/edit')
    const closed: string[] = []

    await settled()
    first.onClose(() => closed.push('first'))

    const second = app.router.layer('http://localhost/users/5/edit')

    await settled()
    second.onClose(() => closed.push('second'))

    expect(app.views()[0].page.props).toEqual({ user: { id: 5, name: 'Renamed' }, errors: {} })
    expect(second.id).toBe(first.id)

    await app.closing(second)

    expect(closed).toEqual(['first', 'second'])
  })

  it('makes the page the owner of a layer opened from it', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [handle.id, null],
    ])
  })

  it('keeps the layer a vetoed link was sent from, and closes the handle of a vetoed open', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users/5/notes': notes() })
    const opener = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const restore = veto('inertia:before')

    try {
      app.router.layerHandle(opener.id)!.router.visit('http://localhost/users/5/notes')

      const refused = app.router.layer('http://localhost/users/5/notes')
      await settled()

      expect(refused.state).toBe('closed')
    } finally {
      restore()
    }

    expect(opener.state).toBe('open')
    expect(app.layers().map((layer) => layer.id)).toEqual([opener.id])
    expect(app.paths()).toEqual(['/users/5/edit'])
  })

  it('makes the layer a link was clicked in the owner of the layer it opens, keeping its handle', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users/5/notes': notes() })
    const opener = app.router.layer('http://localhost/users/5/edit')
    const heard: unknown[] = []

    opener.on('saved', (payload) => heard.push(payload))
    await settled()
    app.router.layerHandle(opener.id)!.router.visit('http://localhost/users/5/notes')
    await settled()

    const [, child] = app.layers()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit', 'Users/Notes'])
    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [opener.id, null],
      [child.id, opener.id],
    ])
    expect(opener.state).toBe('open')

    app.router.layerHandle(child.id)!.emit('saved', { id: 9 })

    expect(heard).toEqual([{ id: 9 }])
  })

  it('makes a layer the owner of a layer opened from inside it', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users/5/notes': notes() })
    const opener = app.router.layer('http://localhost/users/5/edit')

    await settled()
    app.router.layerHandle(opener.id)!.router.layer('http://localhost/users/5/notes')
    await settled()

    expect(
      (app.entry().layers as { key: string; owner: string | null }[]).map(({ key, owner }) => [key, owner]),
    ).toEqual([
      ['Users/Edit', null],
      ['Users/Notes', opener.id],
    ])
  })
})

describe('local layers: router.layer({ component, props })', () => {
  const local = (props: Record<string, unknown> = { user: { id: 5 } }) => ({ component: 'Users/Notes', props })

  it('opens a local layer with no url of its own, owned by the topmost layer', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
    const opener = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const handle = app.router.layer(local())

    await settled()

    expect(app.layers()).toEqual([
      { id: opener.id, key: 'Users/Edit', component: 'Users/Edit', url: '/users/5/edit', type: 'routed' },
      { id: handle.id, key: 'Users/Notes', component: 'Users/Notes', url: null, type: 'local' },
    ])
    expect(app.views()[1].page.props).toEqual({ errors: {}, user: { id: 5 } })
    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [opener.id, null],
      [handle.id, opener.id],
    ])
    expect(window.location.pathname).toBe('/users/5/edit')
    expect(app.router.layerHandle(handle.id)!.id).toBe(handle.id)
  })

  it('makes the page the owner of a local layer opened from it', async () => {
    const app = await openApp(base(), {})
    const handle = app.router.layer(local())

    await settled()

    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [handle.id, null],
    ])
  })

  it('writes a history entry for a local open, at the address the stack already owns', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })

    app.router.layer('http://localhost/users/5/edit')
    await settled()

    const writes = app.written().length

    app.router.layer(local())
    await settled()

    expect(app.written().slice(writes)).toEqual([['push', '/users/5/edit']])
    expect((app.entry().layers as { entries: number }[]).map((layer) => layer.entries)).toEqual([1, 1])
  })

  it('serialises a local layer into an entry', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
    const routed = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const handle = app.router.layer(local())

    await settled()
    await new Promise<void>((resolve) => {
      app.router.replace({ props: { users: [{ id: 9 }] }, onSuccess: () => resolve() })
    })

    const layers = app.entry().layers as { id: string; type: string; component: string; props: unknown }[]

    expect(layers.map((layer) => layer.id)).toEqual([routed.id, handle.id])
    expect(layers[1]).toMatchObject({ type: 'local', component: 'Users/Notes', props: { errors: {}, user: { id: 5 } } })
  })

  it('drops a local layer on restore, firing its handle onClose once', async () => {
    const app = await openApp(base(), {})
    const handle = app.router.layer(local())
    const calls = counted(handle)

    await settled()
    window.history.back()
    await settled()
    app.exitShells()
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('gives two local opens two ids and two handles, and closing one leaves the other', async () => {
    const app = await openApp(base(), { '/users': base() })
    const first = app.router.layer(local())
    await settled()
    const second = app.router.layer(local({ user: { id: 6 } }))
    await settled()

    expect(first.id).not.toBe(second.id)
    expect(app.layers().map((layer) => [layer.id, layer.key])).toEqual([
      [first.id, 'Users/Notes'],
      [second.id, 'Users/Notes'],
    ])
    expect(app.views().map((view) => view.page.props)).toEqual([
      { errors: {}, user: { id: 5 } },
      { errors: {}, user: { id: 6 } },
    ])

    await app.closing(second)
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([first.id])
    expect(second.state).toBe('closed')
    expect(first.state).toBe('open')
  })

  it('does not let a routed response rewrite an open local layer', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
    const open = app.router.layer({ component: 'Users/Edit', props: { user: { id: 5 } } })

    await settled()

    const before = app.views()[0].page
    const routed = app.router.layer('http://localhost/users/5/edit')

    await settled()

    expect(app.layers()).toEqual([
      { id: open.id, key: 'Users/Edit', component: 'Users/Edit', url: null, type: 'local' },
      { id: routed.id, key: 'Users/Edit', component: 'Users/Edit', url: '/users/5/edit', type: 'routed' },
    ])
    expect(app.views()[0].page).toEqual(before)
    expect(open.state).toBe('open')
    expect(routed.state).toBe('open')
  })
})
