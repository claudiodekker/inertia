import { describe, expect, it, vi } from 'vitest'
import { base, counted, edit, layerAt, notes, page, ported, rawResponse, settled, veto } from './layer-handles-support'

describe('router.layer: the routed handle', () => {
  it('returns a handle that subscribes and closes', async () => {
    const app = await ported(base(), { '/users/5/edit': edit() })
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
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
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

  it('composes a cold layer under the carried id when the captured base went stale', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)

    await settled()

    expect(app.layers()).toEqual([
      { id: handle.id, key: 'Users/Edit', component: 'Users/Edit', url: '/users/5/edit', type: 'routed' },
    ])
    expect(handle.state).toBe('open')
    expect(app.paths()).toEqual(['/users/5/edit', '/users'])
    expect(app.entry().layers).toEqual([expect.objectContaining({ id: handle.id, standalone: true })])
  })

  it('closes the handle of an open whose base moved in flight, composing nothing [BEHAVIOUR CHANGED]', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), {
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
    const app = await ported(base(), {
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
    const app = await ported(base(), {
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
    const app = await ported(base(), { '/users/5/edit': () => Promise.resolve(answers.shift()!), '/users': base() })
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
    const app = await ported(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [handle.id, null],
    ])
  })

  it('keeps the layer a vetoed link was sent from, and closes the handle of a vetoed open', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users/5/notes': notes() })
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
    const app = await ported(base(), { '/users/5/edit': edit(), '/users/5/notes': notes() })
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
    const app = await ported(base(), { '/users/5/edit': edit(), '/users/5/notes': notes() })
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

describe('layer events', () => {
  const layerAt = (path: string, component: string) =>
    page(component, path, { layer: { key: component, base: '/users' }, props: { errors: {} } })

  const routes = {
    '/a': layerAt('/a', 'Users/A'),
    '/b': layerAt('/b', 'Users/B'),
    '/c': layerAt('/c', 'Users/C'),
    '/d': layerAt('/d', 'Users/D'),
    '/users': base(),
  }

  it('delivers an event to the immediate owner only, never up the chain', async () => {
    const app = await ported(base(), routes)
    const a = app.router.layer('http://localhost/a')
    await settled()
    const b = app.router.layer('http://localhost/b')
    await settled()
    const c = app.router.layer('http://localhost/c')
    await settled()

    const seen: string[] = []
    a.on('saved', () => seen.push('a'))
    b.on('saved', () => seen.push('b'))

    app.router.layerHandle(c.id)!.emit('saved', { id: 3 })
    expect(seen).toEqual(['b'])

    app.router.layerHandle(b.id)!.emit('saved', { id: 2 })
    expect(seen).toEqual(['b', 'a'])
  })

  it('distinguishes the same-named events of two children by the emitting id', async () => {
    const app = await ported(base(), routes)
    const a = app.router.layer('http://localhost/a')
    await settled()
    const b = app.router.layerHandle(a.id)!.router.layer('http://localhost/b')
    await settled()
    const d = app.router.layerHandle(a.id)!.router.layer('http://localhost/d')
    await settled()

    const seen: [string, unknown][] = []
    a.on('saved', (payload, from) => seen.push([from.id, payload]))

    app.router.layerHandle(b.id)!.emit('saved', { id: 1 })
    app.router.layerHandle(d.id)!.emit('saved', { id: 2 })

    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [a.id, null],
      [b.id, a.id],
      [d.id, a.id],
    ])
    expect(seen).toEqual([
      [b.id, { id: 1 }],
      [d.id, { id: 2 }],
    ])
  })

  it('drops an event no one subscribed to, silently', async () => {
    const app = await ported(base(), routes)

    app.router.layer('http://localhost/a')
    await settled()

    const b = app.router.layer('http://localhost/b')
    await settled()

    expect(() => app.router.layerHandle(b.id)!.emit('saved', { id: 1 })).not.toThrow()
  })

  it('drops an event a layer emits to the page, which has no handle to hear it', async () => {
    const app = await ported(base(), routes)
    const a = app.router.layer('http://localhost/a')

    await settled()

    expect((app.entry().layers as { owner: string | null }[])[0].owner).toBeNull()
    expect(() => app.router.layerHandle(a.id)!.emit('saved', { id: 1 })).not.toThrow()
    expect(app.layers().map((layer) => layer.id)).toEqual([a.id])
  })

  it('closes a child opened through layer.layer(), leaving the layer that opened it', async () => {
    const app = await ported(base(), routes)
    const a = app.router.layer('http://localhost/a')
    await settled()
    const child = app.router.layerHandle(a.id)!.router.layer('http://localhost/b')
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([a.id, child.id])

    await app.closing(child)
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([a.id])
    expect(child.state).toBe('closed')
    expect(a.state).toBe('open')
  })

  it('hears a layer event through once() exactly once, and through on() every time', async () => {
    const app = await ported(base(), routes)
    const heard: string[] = []
    const a = app.router.layer('http://localhost/a')

    a.once('saved', () => heard.push('once'))
    a.on('saved', () => heard.push('on'))
    await settled()

    const b = app.router.layerHandle(a.id)!.router.layer('http://localhost/b')
    await settled()

    app.router.layerHandle(b.id)!.emit('saved')
    app.router.layerHandle(b.id)!.emit('saved')

    expect(heard).toEqual(['once', 'on', 'on'])
  })

  it('stops a once() subscription that never fired', async () => {
    const app = await ported(base(), routes)
    const heard: string[] = []
    const a = app.router.layer('http://localhost/a')
    const stop = a.once('saved', () => heard.push('once'))

    await settled()

    const b = app.router.layerHandle(a.id)!.router.layer('http://localhost/b')
    await settled()

    stop()
    app.router.layerHandle(b.id)!.emit('saved')

    expect(heard).toEqual([])
  })

  it('keeps the page hearing its children across a preserved visit of its own component', async () => {
    const app = await ported(base(), {
      ...routes,
      '/a?filter=x': page('Users/A', '/a?filter=x', {
        layer: { key: 'Users/A', base: '/users' },
        props: { errors: {}, filter: 'x' },
      }),
    })
    const heard: unknown[] = []
    const a = app.router.layer('http://localhost/a')

    a.on('saved', (payload) => heard.push(payload))
    await settled()
    app.router.layerHandle(a.id)!.router.visit('/a?filter=x', { preserveState: true, only: ['filter'] })
    await settled()

    expect(app.views()[0].page.props).toEqual({ errors: {}, filter: 'x' })

    const b = app.router.layerHandle(a.id)!.router.layer('http://localhost/b')
    await settled()

    app.router.layerHandle(b.id)!.emit('saved', { id: 1 })

    expect(heard).toEqual([{ id: 1 }])
  })
})

describe('closing a layer that has a handle', () => {
  it('fires onClose once the removal and the refresh it triggered have settled, seeing the refreshed state', async () => {
    const app = await ported(base(), {
      '/users/5/edit': edit(),
      '/users': base({ props: { users: [{ id: 9 }], errors: {} } }),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const seen: unknown[] = []
    handle.onClose(() => seen.push(app.current.get().props))

    await app.closing(handle)

    expect(seen).toEqual([{ users: [{ id: 9 }], errors: {} }])
    expect(handle.state).toBe('closed')
    expect(app.paths()).toEqual(['/users/5/edit', '/users'])
  })

  it('refreshes the layer beneath once, after the unwind settled, targeting the restored address', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': () => held.then(() => base()) })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const closing = handle.close()
    await settled()
    app.exitShells()
    await settled()

    expect(app.paths()).toEqual(['/users/5/edit', '/users'])
    expect(window.location.pathname).toBe('/users')
    expect(handle.state).toBe('open')

    answer()
    await closing

    expect(app.paths()).toEqual(['/users/5/edit', '/users'])
    expect(handle.state).toBe('closed')
  })

  it('aims the refresh at the base when the layer it lands on has no url of its own', async () => {
    const app = await ported(
      base({
        props: { users: [], errors: {}, token: 'base value' },
        onceProps: { baseKey: { prop: 'token' } },
      } as never),
      {
        '/users/5/edit': edit(),
        '/users': base({
          props: { users: [], errors: {}, token: 'base value' },
          onceProps: { baseKey: { prop: 'token' } },
        } as never),
      },
    )

    app.router.layer({ component: 'Layers/Local', props: {} })
    await settled()

    const handle = app.router.layer('http://localhost/users/5/edit')
    await settled()
    await app.closing(handle)

    expect(app.paths()).toEqual(['/users/5/edit', '/users'])
    expect(app.requests[1].headers).toMatchObject({ 'X-Inertia-Except-Once-Props': 'baseKey' })
    expect(app.layers().map((layer) => layer.component)).toEqual(['Layers/Local'])
  })

  it('completes the close itself when the browser never answers the step back', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': () => held.then(() => base()) })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()
    window.history.go = () => {}

    const closing = handle.close()
    await settled()
    app.exitShells()
    await new Promise((resolve) => setTimeout(resolve, 1200))

    expect(app.layers()).toEqual([])
    expect(app.paths()).toEqual(['/users/5/edit', '/users'])

    answer()
    await closing

    expect(handle.state).toBe('closed')
  })

  it('fires onClose when a before listener vetoes the refresh the close runs', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    const restore = veto('inertia:before')

    try {
      await app.closing(handle)
      await settled()
    } finally {
      restore()
    }

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.paths()).toEqual(['/users/5/edit'])
  })

  it('carries preserveState on the refresh, for the state of the layer beneath', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const visit = vi.spyOn(app.router, 'visit')

    await app.closing(handle)

    expect(visit.mock.calls.at(-1)).toEqual([
      '/users',
      expect.objectContaining({ preserveState: true, preserveScroll: true, async: true }),
    ])
  })

  it('does not refresh when a restore drops the layer, since the restored entry already holds the base', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    window.history.back()
    await settled()
    app.exitShells()
    await settled()

    expect(calls.closed).toBe(1)
    expect(app.paths()).toEqual(['/users/5/edit'])
    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')
  })

  it('does not refresh when the layer closed was standalone, since the blank recovery already fetches [BEHAVIOUR CHANGED]', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)

    await settled()
    expect(app.paths()).toEqual(['/users/5/edit', '/users'])

    await app.closing(handle)

    expect(handle.state).toBe('closed')
    expect(app.paths()).toEqual(['/users/5/edit', '/users', '/users'])
  })

  it('does not refresh when the layer closed was standalone over a base still blank, since the recovery already fetches', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': () => held.then(() => base()) })
    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)

    await settled()
    expect(app.paths()).toEqual(['/users/5/edit', '/users'])

    const closing = handle.close()
    await settled()
    app.exitShells()
    await settled()
    answer()
    await closing

    expect(handle.state).toBe('closed')
    expect(app.paths().filter((path) => path === '/users')).toHaveLength(1)
  })
})

describe('layer handles across restores and navigations', () => {
  const dashboard = page('Dashboard', '/dashboard')

  it('fires a handle onClose exactly once when the restore drops its layer, then clears it', async () => {
    const app = await ported(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    window.history.back()
    await settled()
    app.exitShells()
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
    expect(app.router.layerHandle(handle.id)).toBeUndefined()
  })

  it('gives a restored stack the page it lands on as its owner, so its events are still heard', async () => {
    const app = await ported(base(), {
      '/a': page('Users/A', '/a', { layer: { key: 'Users/A', base: '/users' } }),
      '/b': page('Users/B', '/b', { layer: { key: 'Users/B', base: '/users' } }),
      '/dashboard': dashboard,
    })
    const a = app.router.layer('http://localhost/a')
    await settled()
    const b = app.router.layer('http://localhost/b')
    await settled()
    const ids = [a.id, b.id]

    app.router.visit('/dashboard')
    await settled()

    expect(app.layers()).toEqual([])

    window.history.back()
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual(ids)
    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [ids[0], null],
      [ids[1], ids[0]],
    ])

    const heard: unknown[] = []
    app.router.layerHandle(ids[0])!.on('saved', (payload) => heard.push(payload))
    app.router.layerHandle(ids[1])!.emit('saved', { id: 5 })

    expect(heard).toEqual([{ id: 5 }])
  })

  it('keeps the layer and page handles when a newer write supersedes an older one', async () => {
    const app = await ported(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const scope = app.router.layerHandle(handle.id)!
    let closed = ''

    scope.onClose(() => (closed += 'layer'))
    handle.onClose(() => (closed += 'handle'))

    app.router.replace({ props: { users: [{ id: 0 }] } })
    await new Promise<void>((resolve) => {
      app.router.replace({ props: { users: [{ id: 1 }] }, onSuccess: () => resolve() })
    })
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(closed).toBe('')
    expect(app.router.layerHandle(handle.id)).toBe(scope)
    expect((await app.basePage()).props).toMatchObject({ users: [{ id: 1 }] })
  })

  it('keeps a handle whose layer the restored stack still holds', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users/5/notes': notes(), '/users': base() })
    const outer = app.router.layer('http://localhost/users/5/edit')
    const heard: string[] = []

    await settled()
    outer.onClose(() => heard.push('closed'))
    outer.on('saved', () => heard.push('saved'))
    app.router.layer('http://localhost/users/5/notes')
    await settled()

    expect(app.layers()).toHaveLength(2)

    window.history.back()
    await settled()
    app.exitShells()
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([outer.id])
    expect(heard).toEqual([])
    expect(app.router.layerHandle(outer.id)).toBeDefined()

    const reopened = app.router.layer('http://localhost/users/5/notes')
    await settled()

    expect(app.layers()).toHaveLength(2)

    app.router.layerHandle(reopened.id)!.emit('saved')

    expect(heard).toEqual(['saved'])
  })

  it('fires a handle onClose when a navigation from the base takes its layer away', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/teams': page('Teams/Index', '/teams') })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    const outcome = await new Promise<string>((resolve) => {
      app.router.visit('http://localhost/teams', {
        onSuccess: () => resolve('success'),
        onError: () => resolve('error'),
      })
    })

    await settled()

    expect(outcome).toBe('success')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.router.layerHandle(handle.id)).toBeUndefined()
  })

  it('keeps the handle of a layer whose own response clears the history', async () => {
    const app = await ported(base(), { '/users/5/edit': edit({ clearHistory: true }) })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('open')
  })
})

describe('the handle of a layer open that never lands', () => {
  const inertia = { 'x-inertia': 'true' }

  it('closes the handle when a 4xx is suppressed by onHttpException', async () => {
    const app = await ported(base(), {}, () => rawResponse(422, edit(), inertia))
    const handle = app.router.layer('http://localhost/users/5/edit', { onHttpException: () => false })
    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
  })

  it('closes the handle when the request is cancelled, and not twice if the response lands anyway', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), { '/users/5/notes': notes(), '/users/5/edit': () => held.then(() => edit()) })
    const open = app.router.layer('http://localhost/users/5/notes')
    const openCalls = counted(open)

    await settled()

    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.cancelAll()
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(openCalls.closed).toBe(0)

    answer()
    await settled()

    expect(calls.closed).toBe(1)
    expect(openCalls.closed).toBe(0)
    expect(app.layers().map((layer) => layer.id)).toEqual([open.id])
  })

  it('does not fire a handle whose layer composed before a late cancel arrives', async () => {
    let release = () => {}
    const app = await ported(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit', {
      onSuccess: () => new Promise<void>((resolve) => (release = resolve)),
    })
    const calls = counted(handle)

    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])

    app.router.cancelAll()
    release()
    await settled()

    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('open')
    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
  })

  it('closes the handle whose layer a back restore drops, exactly once', async () => {
    const app = await ported(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    window.history.back()
    await settled()
    app.exitShells()
    await settled()
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
  })

  it('closes the handle when onBefore vetoes the visit, leaving other handles alone', async () => {
    const app = await ported(base(), { '/notes': page('Notes', '/notes', { layer: { key: 'Notes', base: '/users' } }) })
    const open = app.router.layer('http://localhost/notes')
    const openCalls = counted(open)

    await settled()

    const handle = app.router.layer('http://localhost/users/5/edit', { onBefore: () => false })
    const calls = counted(handle)

    await settled()

    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
    expect(open.state).toBe('open')
    expect(openCalls.closed).toBe(0)
    expect(app.paths()).toEqual(['/notes'])
  })

  it('closes the handle when the layer response is promoted to a page instead of composing [BEHAVIOUR CHANGED]', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), {
      '/users/5/notes': notes(),
      '/users/5/edit': () => held.then(() => edit()),
      '/users/archive': page('Users/Archive', '/users/archive'),
    })
    const open = app.router.layer('http://localhost/users/5/notes')
    const openCalls = counted(open)

    await settled()

    const handle = app.router.layer('http://localhost/users/5/edit', { async: true })
    const calls = counted(handle)

    await settled()
    app.router.visit('/users/archive', { async: true })
    await settled()

    expect(openCalls.closed).toBe(1)

    answer()
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect((await app.basePage()).component).toBe('Users/Archive')
    expect(app.layers()).toEqual([])
    expect(openCalls.closed).toBe(1)
  })

  it('promotes a baseless layer answer to a page over its own placeholder, closing the handle', async () => {
    const app = await ported(base(), {
      '/users/5/edit': page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit' }, props: { errors: {} } }),
    })
    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)
    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(app.layers()).toEqual([])
  })

  it('closes the handle when an async visit response is dropped', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), {
      '/users/5/edit': () => held.then(() => base({ props: { users: [{ id: 9 }], errors: {} } })),
      '/users/archive': page('Users/Archive', '/users/archive'),
    })
    const handle = app.router.layer('http://localhost/users/5/edit', { async: true })
    const calls = counted(handle)

    await settled()
    app.router.visit('/users/archive', { async: true })
    await settled()
    answer()
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect((await app.basePage()).component).toBe('Users/Archive')
  })

  it('fires the handle of a layer opened cold exactly once when a back restore drops its stack, even if its walk then fails', async () => {
    let fail = (_response: ReturnType<typeof rawResponse>) => {}
    const walk = new Promise<ReturnType<typeof rawResponse>>((resolve) => (fail = resolve))
    const app = await ported(page('Auth/Login', '/login'), { '/users/5/edit': edit() }, (config) =>
      new URL(config.url, 'http://localhost').pathname === '/users' ? walk : undefined,
    )

    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)
    const calls = counted(handle)

    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(app.paths()).toEqual(['/users/5/edit', '/users'])

    window.history.back()
    await settled()
    app.exitShells()
    await settled()

    expect(calls.closed).toBe(1)

    fail(rawResponse(500, '<html>Server Error</html>'))
    await settled()

    expect(calls.closed).toBe(1)
  })

  it('closes the handle when the application vetoes the visit before it starts', async () => {
    const app = await ported(base(), {})
    const restore = veto('inertia:before')
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    restore()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
    expect(app.requests).toEqual([])
  })

  it('closes the handle when a 409 redirect re-issues the visit as a page navigation', async () => {
    const app = await ported(base(), { '/users': base({ props: { users: [{ id: 9 }], errors: {} } }) }, (config) =>
      new URL(config.url, 'http://localhost').pathname === '/users/5/edit'
        ? rawResponse(409, '', { 'x-inertia-redirect': 'http://localhost/users' })
        : undefined,
    )
    const handle = app.router.layer('http://localhost/users/5/edit', { async: true })
    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(1)
    expect(app.paths()).toEqual(['/users/5/edit', '/users'])
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
  })

  it('closes the handle when the request never brings a response back', async () => {
    const app = await ported(base(), {}, () => Promise.reject(new Error('offline')))
    const restore = veto('inertia:networkError')
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    restore()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
  })

  it('closes the handle when a 4xx reaches the error dialog', async () => {
    const app = await ported(base(), {}, () => rawResponse(500, '<html>Server Error</html>'))

    Object.assign(document, {
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        addEventListener: () => {},
        appendChild: () => {},
        prepend: () => {},
        querySelectorAll: () => [],
        showModal: () => {},
        focus: () => {},
        remove: () => {},
      }),
      head: { appendChild: () => {} },
      body: { prepend: () => {} },
    })

    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect(app.layers()).toEqual([])
  })
})

describe('a layer open answered by an interstitial', () => {
  const prompt = (extra: Record<string, unknown> = {}) =>
    page('Auth/Sudo', '/sudo', { interstitial: true, props: { errors: {} }, ...extra })

  const answering = (...responses: ReturnType<typeof page>[]) => {
    const queue = [...responses]

    return () => Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0])
  }

  it('keeps the handle open, since the prompt returns to it', async () => {
    const app = await ported(base(), { '/users/5/edit': answering(prompt()) })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    expect((await app.basePage()).component).toBe('Auth/Sudo')
    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('pending')
  })

  it('fires onClose when the layer the prompt returned to is closed', async () => {
    const app = await ported(base(), { '/users/5/edit': answering(prompt(), edit()), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.visit('http://localhost/users/5/edit')
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(calls.closed).toBe(0)

    const closing = app.router.close(handle.id)
    await settled()
    app.exitShells()
    await closing
    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
  })

  it('keeps the handle open when the prompt answers its own submit', async () => {
    const app = await ported(base(), {
      '/users/5/edit': answering(prompt(), edit()),
      'post /sudo': prompt({ props: { errors: { password: 'Wrong' } } }),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.visit('http://localhost/sudo', { method: 'post' })
    await settled()

    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('pending')
    expect((await app.basePage()).props).toEqual({ errors: { password: 'Wrong' } })

    app.router.visit('http://localhost/users/5/edit')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
  })

  it('fires onClose when a navigation away abandons the prompt', async () => {
    const app = await ported(base(), {
      '/users/5/edit': answering(prompt()),
      '/dashboard': page('Dashboard', '/dashboard'),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()
    app.router.visit('http://localhost/dashboard')
    await settled()

    expect(calls.closed).toBe(1)
    expect((await app.basePage()).component).toBe('Dashboard')
    expect(handle.state).toBe('closed')
  })

  it('closes the handle when the response is an ordinary page rather than a prompt', async () => {
    const app = await ported(base(), { '/users/5/edit': page('Auth/Login', '/login') })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(1)
    expect(handle.state).toBe('closed')
    expect((await app.basePage()).component).toBe('Auth/Login')
  })

  it('gives the returned layer the page it lands on as its owner [BEHAVIOUR CHANGED]', async () => {
    const app = await ported(base(), { '/users/5/edit': answering(prompt(), edit()) })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()
    app.router.visit('http://localhost/users/5/edit')
    await settled()

    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [handle.id, null],
    ])
    expect(() => app.router.layerHandle(handle.id)!.emit('saved', { id: 5 })).not.toThrow()
  })
})

describe('local layers: router.layer({ component, props })', () => {
  const local = (props: Record<string, unknown> = { user: { id: 5 } }) => ({ component: 'Users/Notes', props })

  it('opens a local layer with no url of its own, owned by the topmost layer', async () => {
    const app = await ported(base(), { '/users/5/edit': edit() })
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
    const app = await ported(base(), {})
    const handle = app.router.layer(local())

    await settled()

    expect((app.entry().layers as { id: string; owner: string | null }[]).map(({ id, owner }) => [id, owner])).toEqual([
      [handle.id, null],
    ])
  })

  it('writes a history entry for a local open, at the address the stack already owns', async () => {
    const app = await ported(base(), { '/users/5/edit': edit() })

    app.router.layer('http://localhost/users/5/edit')
    await settled()

    const writes = app.written().length

    app.router.layer(local())
    await settled()

    expect(app.written().slice(writes)).toEqual([['push', '/users/5/edit']])
    expect((app.entry().layers as { entries: number }[]).map((layer) => layer.entries)).toEqual([1, 1])
  })

  it('serialises a local layer into an entry', async () => {
    const app = await ported(base(), { '/users/5/edit': edit() })
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
    const app = await ported(base(), {})
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
    const app = await ported(base(), { '/users': base() })
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
    const app = await ported(base(), { '/users/5/edit': edit() })
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
