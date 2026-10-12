import { describe, expect, it } from 'vitest'
import { base, counted, edit, holdBack, layerAt, openCold, ported, settled } from './layer-handles-support'

const routes = () => ({
  '/users/5/edit': edit(),
  '/users/5/notes': layerAt('Users/Notes', '/users/5/notes'),
  '/teams/9': layerAt('Teams/Show', '/teams/9'),
  '/users': base(),
})

describe('closing a layer', () => {
  it('unwinds the steps taken over a cold layer before writing the page beneath it', async () => {
    const app = await ported(base(), routes())
    const cold = await openCold(app)

    app.router.layer('http://localhost/users/5/notes')
    await settled()

    const go = app.go()
    const written = app.written().length

    await app.closing(cold)

    expect(go).toEqual([-1])
    expect(app.written().slice(written)).toEqual([['push', '/users']])
  })

  it('counts a history entry an anchor pushed inside a layer', async () => {
    const app = await ported(base(), routes())
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    window.history.pushState(null, '', '/users/5/edit#notes')
    window.history.go(0)
    await settled()

    expect((app.entry().layers as { entries: number }[]).map((layer) => layer.entries)).toEqual([2])

    const go = app.go()

    await app.closing(handle)

    expect(go).toEqual([-2])
  })

  it('closes every layer above the one it was asked to close', async () => {
    const app = await ported(base(), routes())
    const cold = await openCold(app)

    app.router.layer('http://localhost/users/5/notes')
    await settled()
    app.router.layer('http://localhost/teams/9')
    await settled()

    const browser = holdBack()
    let resolved = false
    const closing = cold.close().then(() => (resolved = true))

    await settled()
    app.exitShells()
    await settled()

    expect(browser.held).toEqual([-2])
    expect(resolved).toBe(false)
    expect(app.layers()).toHaveLength(3)

    browser.answer()
    await closing

    expect(app.layers()).toEqual([])
  })

  it('keeps a layer being closed out of the entry a write leaves behind', async () => {
    const app = await ported(base(), { '/a': layerAt('Users/A', '/a'), '/b': layerAt('Users/B', '/b') })
    const a = app.router.layer('http://localhost/a')

    await settled()

    const b = app.router.layer('http://localhost/b')

    await settled()
    void b.close()
    await settled()

    const writes = app.written().length

    await new Promise<void>((resolve) => {
      app.router.replace({ props: { users: ['ada'] }, onSuccess: () => resolve() })
    })

    expect(app.written().slice(writes)).toEqual([['replace', '/b']])
    expect((app.entry().layers as { id: string }[]).map((layer) => layer.id)).toEqual([a.id])
  })

  it('does not put a standalone layer back on screen when the step back restores the entry holding it', async () => {
    const app = await ported(base(), routes())
    const cold = await openCold(app)

    app.router.layer('http://localhost/users/5/notes')
    await settled()

    const go = app.go()

    await app.closing(cold)
    await settled()

    expect(go).toEqual([-1])
    expect(app.layers()).toEqual([])
    expect((await app.basePage()).component).toBe('Users/Index')
  })
})

describe('a partial a layer made', () => {
  it("keeps a layer's handle when a partial it made is answered by a page that keeps the stack", async () => {
    const app = await ported(base(), {
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
