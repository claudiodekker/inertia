import { describe, expect, it } from 'vitest'
import { openApp } from './support/app'
import { page, settled } from './support/browser'
import { counted } from './support/handles'
import { base, edit, notes } from './support/pages'

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
    const app = await openApp(base(), routes)
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
    const app = await openApp(base(), routes)
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
    const app = await openApp(base(), routes)

    app.router.layer('http://localhost/a')
    await settled()

    const b = app.router.layer('http://localhost/b')
    await settled()

    expect(() => app.router.layerHandle(b.id)!.emit('saved', { id: 1 })).not.toThrow()
  })

  it('drops an event a layer emits to the page, which has no handle to hear it', async () => {
    const app = await openApp(base(), routes)
    const a = app.router.layer('http://localhost/a')

    await settled()

    expect((app.entry().layers as { owner: string | null }[])[0].owner).toBeNull()
    expect(() => app.router.layerHandle(a.id)!.emit('saved', { id: 1 })).not.toThrow()
    expect(app.layers().map((layer) => layer.id)).toEqual([a.id])
  })

  it('closes a child opened through layer.layer(), leaving the layer that opened it', async () => {
    const app = await openApp(base(), routes)
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
    const app = await openApp(base(), routes)
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
    const app = await openApp(base(), routes)
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
    const app = await openApp(base(), {
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

describe('layer handles across restores and navigations', () => {
  const dashboard = page('Dashboard', '/dashboard')

  it('fires a handle onClose exactly once when the restore drops its layer, then clears it', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit() })
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
    const app = await openApp(base(), {
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
    const app = await openApp(base(), { '/users/5/edit': edit() })
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
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users/5/notes': notes(), '/users': base() })
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
    const app = await openApp(base(), { '/users/5/edit': edit(), '/teams': page('Teams/Index', '/teams') })
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
    const app = await openApp(base(), { '/users/5/edit': edit({ clearHistory: true }) })
    const handle = app.router.layer('http://localhost/users/5/edit')
    const calls = counted(handle)

    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('open')
  })
})
