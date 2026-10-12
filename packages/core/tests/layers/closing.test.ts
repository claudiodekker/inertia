import { describe, expect, it, vi } from 'vitest'
import { exitShells, held, openAppSentCall, type SentCallApp, type Route, openApp } from './support/app'
import { settled, page } from './support/browser'
import { holdBack, openCold, counted, veto } from './support/handles'
import { base, edit, layerAt } from './support/pages'

const routes = () => ({
  '/users/5/edit': edit(),
  '/users/5/notes': layerAt('Users/Notes', '/users/5/notes'),
  '/teams/9': layerAt('Teams/Show', '/teams/9'),
  '/users': base(),
})

const index = (extra: Record<string, unknown> = {}) =>
  page('Users/Index', '/users', { props: { users: [], errors: {} }, ...extra })

const editWith = (extra: Record<string, unknown> = {}) =>
  page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  })

const open = async (initial: Record<string, unknown>, routes: Record<string, Route>, url = '/users/5/edit') => {
  const app = await openAppSentCall(initial, routes)

  app.router.visit(url)
  await settled()

  return app
}

const scopeOf = (app: SentCallApp, index = 0) => app.router.layerHandle(app.layers()[index].id)!

describe('closing a layer', () => {
  it('unwinds the steps taken over a cold layer before writing the page beneath it', async () => {
    const app = await openApp(base(), routes())
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
    const app = await openApp(base(), routes())
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
    const app = await openApp(base(), routes())
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
    const app = await openApp(base(), { '/a': layerAt('Users/A', '/a'), '/b': layerAt('Users/B', '/b') })
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
    const app = await openApp(base(), routes())
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

describe('closing a layer', () => {
  const routes = () => ({
    '/users/5/edit': edit(),
    '/users/5/notes': layerAt('Users/Notes', '/users/5/notes'),
    '/teams/9': layerAt('Teams/Show', '/teams/9'),
    '/steps/1': layerAt('Wizard', '/steps/1'),
    '/steps/2': layerAt('Wizard', '/steps/2'),
    '/same': layerAt('Users/Same', '/users/5/edit'),
    '/users': base(),
  })

  const open = async (...urls: (string | [string, Record<string, unknown>])[]) => {
    const app = await openApp(base(), routes())
    const handles = []

    for (const url of urls) {
      const [target, options] = typeof url === 'string' ? [url, {}] : url

      handles.push(app.router.layer(`http://localhost${target}`, options))
      await settled()
    }

    return { app, handles }
  }

  it('resolves once the layer is off the screen, not when it starts closing', async () => {
    const app = await openApp(base(), {})
    const handle = app.router.layer({ component: 'Users/Notes' })
    let done = false

    await settled()

    const closing = handle.close().then(() => (done = true))

    await settled()

    expect(app.layers()).toHaveLength(1)
    expect(done).toBe(false)

    app.exitShells()
    await closing

    expect(app.layers()).toEqual([])
    expect(done).toBe(true)
  })

  it('unwinds to the entry the layer beneath is on', async () => {
    const { app, handles } = await open('/users/5/edit')
    const go = app.go()

    await app.closing(handles[0])

    expect(go).toEqual([-1])
    expect(window.location.pathname).toBe('/users')
  })

  it('unwinds past every layer above the one being closed', async () => {
    const { app, handles } = await open('/users/5/edit', '/teams/9')
    const go = app.go()

    await app.closing(handles[0])

    expect(go).toEqual([-2])
    expect(app.layers()).toEqual([])
  })

  it('closes the topmost layer when none is named', async () => {
    const { app, handles } = await open('/users/5/edit', '/teams/9')
    const go = app.go()
    const closing = app.router.close()

    await settled()
    app.exitShells()
    await closing

    expect(go).toEqual([-1])
    expect(app.layers().map((layer) => layer.id)).toEqual([handles[0].id])
  })

  it('does not unwind past a layer that never moved the address', async () => {
    const { app, handles } = await open('/users/5/edit', ['/users/5/notes', { replace: true }])
    const go = app.go()

    expect((app.entry().layers as { entries: number }[]).map((layer) => layer.entries)).toEqual([1, 0])

    await app.closing(handles[0])

    expect(go).toEqual([-1])
    expect(app.layers()).toEqual([])
  })

  it('does not unwind past a layer that only moved the address by a hash', async () => {
    const { app, handles } = await open('/users/5/edit', ['/same#notes', { replace: true }])
    const go = app.go()

    expect(app.layers().map((layer) => layer.url)).toEqual(['/users/5/edit', '/users/5/edit'])
    expect((app.entry().layers as { entries: number }[]).map((layer) => layer.entries)).toEqual([1, 0])

    await app.closing(handles[0])

    expect(go).toEqual([-1])
  })

  it('unwinds every entry the layer pushed, not just the one the open did', async () => {
    const { app, handles } = await open('/steps/1')

    app.router.layerHandle(handles[0].id)!.router.visit('/steps/2')
    await settled()

    const go = app.go()

    await app.closing(handles[0])

    expect(go).toEqual([-2])
    expect(app.layers()).toEqual([])
  })

  it('records each entry pushed on the layer that owns the address', async () => {
    const { app, handles } = await open('/steps/1')

    app.router.layerHandle(handles[0].id)!.router.visit('/steps/2')
    await settled()

    expect(app.layers().map((layer) => layer.url)).toEqual(['/steps/2'])
    expect((app.entry().layers as { entries: number }[]).map((layer) => layer.entries)).toEqual([2])
    expect(app.written().slice(-2)).toEqual([
      ['push', '/steps/1'],
      ['push', '/steps/2'],
    ])
  })

  it('records a step on a layer opened at the address the page beneath already has', async () => {
    const app = await openApp(base(), { '/users': layerAt('Users/Edit', '/users') })

    app.router.layer('http://localhost/users')
    await settled()

    expect((app.entry().layers as { entries: number }[]).map((layer) => layer.entries)).toEqual([1])
    expect(app.written().at(-1)).toEqual(['push', '/users'])
  })

  it('steps back only after the writes ahead of it have landed', async () => {
    const { app, handles } = await open('/users/5/edit')
    const order: string[] = []
    const { pushState, replaceState, go } = window.history

    window.history.pushState = (...args: Parameters<typeof pushState>) => (order.push('push'), pushState(...args))
    window.history.replaceState = (...args: Parameters<typeof replaceState>) => (
      order.push('replace'),
      replaceState(...args)
    )
    window.history.go = (delta: number) => (order.push(`go ${delta}`), go(delta))

    const write = new Promise<void>((resolve) => {
      app.router.replace({ props: { users: [{ id: 1 }] }, onSuccess: () => resolve() })
    })
    const closing = handles[0].close()

    await settled()
    app.exitShells()
    await write
    await closing

    expect(order.filter((step) => step !== 'push').slice(0, 2)).toEqual(['replace', 'go -1'])
    expect(order.indexOf('go -1')).toBeGreaterThan(order.indexOf('replace'))
  })

  it('writes the page beneath a layer that never moved the address', async () => {
    const { app, handles } = await open('/users/5/edit', ['/users/5/notes', { replace: true }])
    const go = app.go()
    const writes = app.written().length

    await app.closing(handles[1])

    expect(go).toEqual([])
    expect(app.written().slice(writes)).toEqual([
      ['replace', '/users/5/edit'],
      ['replace', '/users/5/edit'],
    ])
    expect(app.layers().map((layer) => layer.id)).toEqual([handles[0].id])
  })

  it('pushes the page beneath a standalone layer, leaving the entry the layer arrived on', async () => {
    const app = await openApp(base(), routes())
    const handle = await openCold(app)

    const go = app.go()

    await app.closing(handle)

    expect(go).toEqual([])
    expect(app.written().at(-1)).toEqual(['push', '/users'])
    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('leaves the page the stack was opened over in place', async () => {
    const app = await openApp(base(), routes())
    const handle = await openCold(app)

    const over = app.current.get()

    await app.closing(handle)
    await settled()

    expect(app.current.get().component).toBe('Users/Index')
    expect(app.current.get().props).toEqual(over.props)
  })

  it('does nothing when there is no stack to close', async () => {
    const app = await openApp(base(), routes())
    const go = app.go()
    const writes = app.written().length

    await app.router.close()

    expect(go).toEqual([])
    expect(app.written().length).toBe(writes)
  })

  it('does nothing when the layer named is not on the stack', async () => {
    const { app, handles } = await open('/users/5/edit')
    const go = app.go()
    const writes = app.written().length

    await app.router.close('layer-9')
    await settled()

    expect(go).toEqual([])
    expect(app.written().length).toBe(writes)
    expect(app.layers().map((layer) => layer.id)).toEqual([handles[0].id])
  })

  it('closes a stack restored from history to the same place', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit({ encryptHistory: true }), '/users': base() })

    Object.assign(window, { crypto: globalThis.crypto })

    const handle = await openCold(app)

    const entry = (window.history.state as { page: unknown }).page
    const { history } = await import('../../../src/history')

    expect(entry).toBeInstanceOf(ArrayBuffer)

    const restored = await history.decrypt(entry as ArrayBuffer)

    expect((restored as { layers: unknown[] }).layers).toEqual([
      expect.objectContaining({ id: handle.id, standalone: true }),
    ])
  })
})

describe('closing through the router', () => {
  it('closes the topmost layer when none is named', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })

    app.router.layer('http://localhost/users/5/edit')
    await settled()

    const go = app.go()
    const closing = app.router.close()

    await settled()
    app.exitShells()
    await closing

    expect(go).toEqual([-1])
    expect(app.layers()).toEqual([])
  })

  it('closes the layer a shell names', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const go = app.go()
    const closing = app.router.close(handle.id)

    await settled()
    app.exitShells()
    await closing

    expect(go).toEqual([-1])
    expect(app.layers()).toEqual([])
  })
})

describe('closing a layer that has a handle', () => {
  it('fires onClose once the removal and the refresh it triggered have settled, seeing the refreshed state', async () => {
    const app = await openApp(base(), {
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
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': () => held.then(() => base()) })
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
    const app = await openApp(
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
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': () => held.then(() => base()) })
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
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })
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
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })
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
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })
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

  it('does not refresh when the layer closed was standalone, since the blank recovery already fetches', async () => {
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': base() })
    const handle = await openCold(app)
    const calls = counted(handle)

    expect(app.paths()).toEqual(['/users/5/edit', '/users'])

    await app.closing(handle)

    expect(calls.closed).toBe(1)
    expect(app.paths()).toEqual(['/users/5/edit', '/users', '/users'])
  })

  it('does not refresh when the layer closed was standalone over a base still blank, since the recovery already fetches', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await openApp(base(), { '/users/5/edit': edit(), '/users': () => held.then(() => base()) })
    const handle = await openCold(app)
    const calls = counted(handle)

    expect(app.paths()).toEqual(['/users/5/edit', '/users'])

    const closing = handle.close()
    await settled()
    app.exitShells()
    await settled()
    answer()
    await closing

    expect(calls.closed).toBe(1)
    expect(app.paths().filter((path) => path === '/users')).toHaveLength(1)
  })
})

describe('a close: true response runs the close flow instead of installing', () => {
  const notes = page('Users/Notes', '/users/5/notes', {
    layer: { key: 'Users/Notes' },
    props: { errors: {} },
  })

  it('runs the top-layer close flow when close: true arrives over an open layer, installing nothing', async () => {
    const refreshed = index({ props: { users: [{ id: 9 }], errors: {} } })
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      'post /users/5/edit': index({ close: true, url: '/users/5/edit' }),
      '/users': refreshed,
    })
    const [layer] = app.layers()

    app.router.post('/users/5/edit')
    await settled()

    expect(await app.basePage()).toMatchObject({
      component: 'Users/Index',
      url: '/users',
      props: { users: [], errors: {} },
    })
    expect(await app.basePage()).not.toHaveProperty('close')
    expect(app.layers()).toEqual([layer])
    expect(app.views().map((view) => view.shell.open)).toEqual([false])
    expect(app.sent()).toEqual(['get /users/5/edit', 'post /users/5/edit'])

    exitShells(app)
    await settled()

    expect(app.sent()).toEqual(['get /users/5/edit', 'post /users/5/edit', 'get /users'])
    expect(window.location.pathname).toBe('/users')
    expect((await app.basePage()).props.users).toEqual([{ id: 9 }])
    expect(app.layers()).toEqual([])
  })

  it('reports the submit as a success, since nothing about it failed', async () => {
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      'post /users/5/edit': index({ close: true, url: '/users/5/edit' }),
      '/users': index(),
    })
    let succeeded = false
    let errored = false

    app.router.post('/users/5/edit', {}, { onSuccess: () => (succeeded = true), onError: () => (errored = true) })
    await settled()

    expect(succeeded).toBe(true)
    expect(errored).toBe(false)
  })

  it('hands the success callbacks the page as the close leaves it, not the one still showing the layer', async () => {
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      '/users/5/notes': notes,
      'post /users/5/notes': index({ close: true, url: '/users/5/notes' }),
      '/users': index(),
    })

    app.router.layer('/users/5/notes')
    await settled()

    let received: Record<string, unknown> | null = null

    app.router
      .layerHandle(app.layers()[1].id)!
      .router.post('/users/5/notes', {}, { onSuccess: (page) => (received = page) })
    await settled()

    expect(received).toMatchObject({
      component: 'Users/Edit',
      url: '/users/5/edit',
      props: { user: { id: 5 }, errors: {} },
    })
    expect(received).not.toHaveProperty('layers')
  })

  it('closes the layer the visit was made from, and every layer above it', async () => {
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      '/users/5/notes': notes,
      'post /users/5/edit': index({ close: true, url: '/users/5/edit' }),
      '/users': index(),
    })

    app.router.layer('/users/5/notes')
    await settled()
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit', 'Users/Notes'])

    scopeOf(app, 0).router.post('/users/5/edit')
    await settled()

    expect(app.views().map((view) => view.shell.open)).toEqual([false, false])

    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/users')
  })

  it('closes nothing when the layer the visit was made from has gone since', async () => {
    const answer = held()
    const app = await open(index(), {
      '/users/5/edit': editWith(),
      '/users/5/notes': notes,
      'post /users/5': () => answer.answer(),
      '/users': index(),
    })
    const gone = scopeOf(app)

    gone.router.post('/users/5')
    await settled()

    const closing = gone.close()
    exitShells(app)
    await closing
    await settled()

    app.router.layer('/users/5/notes')
    await settled()
    const written = app.written().length

    answer.release(index({ close: true }))
    await settled()

    expect(app.written().length).toBe(written)
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Notes'])
    expect(app.views().map((view) => view.shell.open)).toEqual([true])
  })

  it('refreshes the current page when close: true arrives with no layer open', async () => {
    const app = await openAppSentCall(index({ props: { stats: [1], errors: {} } }), {
      'post /users': index({
        close: true,
        props: { stats: [9, 9, 9], errors: {} },
      }),
    })

    app.router.post('/users')
    await settled()

    expect(app.sent()).toEqual(['post /users'])
    expect((await app.basePage()).props).toEqual({
      stats: [9, 9, 9],
      errors: {},
    })
    expect(app.layers()).toEqual([])
  })
})

describe('overlapping closes', () => {
  const twoLayers = async (extra: Record<string, Route> = {}) => {
    const app = await openApp(base(), {
      '/a': layerAt('A', '/a'),
      '/b': layerAt('B', '/b'),
      '/users': base(),
      ...extra,
    })
    const a = app.router.layer('/a')

    await settled()

    const b = app.router.layer('/b')

    await settled()
    expect(app.layers().map((layer) => layer.id)).toEqual([a.id, b.id])

    return { app, a, b }
  }

  it('leaves the base mounted when a refresh is cancelled while the next close steps back', async () => {
    const baseSwapsAfterSecondClose = async (
      firstRefresh: 'answered before' | 'answered during' | 'cancelled during',
    ) => {
      const refresh = held()
      let opened = false
      const { app, a, b } = await twoLayers({
        '/a': () => (opened ? refresh.answer() : Promise.resolve(layerAt('A', '/a'))),
      })

      opened = true

      const go = app.go()

      app.router.close(b.id)
      await settled()
      app.exitShells()
      await settled()

      expect(app.layers().map((layer) => layer.id)).toEqual([a.id])
      expect(app.sent).toEqual(['get /a', 'get /b', 'get /a'])

      if (firstRefresh === 'answered before') {
        refresh.release(layerAt('A', '/a'))
        await settled()
      }

      app.swaps.length = 0
      app.router.close(a.id)
      await settled()
      app.exitShells()

      // The step back is out and the browser has not answered it yet.
      expect(go).toEqual([-1, -1])
      expect(app.layers().map((layer) => layer.id)).toEqual([a.id])

      if (firstRefresh === 'answered during') {
        refresh.release(layerAt('A', '/a'))
      }

      if (firstRefresh === 'cancelled during') {
        app.router.cancelAll()
      }

      await settled()

      expect(app.layers()).toEqual([])

      return app.swaps.map((swap) => swap.preserveState)
    }

    expect(await baseSwapsAfterSecondClose('answered before')).toEqual([true])
    expect(await baseSwapsAfterSecondClose('answered during')).toEqual([true])
    expect(await baseSwapsAfterSecondClose('cancelled during')).toEqual([true])
  })

  it('steps back over the one entry still beneath when a close arrives during a Back dismissal', async () => {
    const { app, a } = await twoLayers()
    const browserBack = window.history.go.bind(window.history)
    const go = app.go()

    browserBack(-1)
    await settled()

    expect(window.location.pathname).toBe('/a')
    expect(app.views().map((view) => view.shell.open)).toEqual([true, false])

    app.router.close(a.id)
    await settled()
    app.exitShells()
    await settled()

    expect(go).toEqual([-1])
    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/users')
  })

  it('drops a pending close when a layer beneath it navigates, so no step back is made', async () => {
    const pendingCloseOfTopLayer = async (navigatesBottomLayer: boolean) => {
      const app = await openApp(base(), {
        '/a': layerAt('A', '/a'),
        '/a?page=2': layerAt('A', '/a?page=2'),
        '/b': layerAt('B', '/b'),
        '/c': layerAt('C', '/c'),
      })
      const go = app.go()
      const a = app.router.layer('/a')

      await settled()
      app.router.layer('/b')
      await settled()

      const c = app.router.layer('/c')

      await settled()

      app.router.close(c.id)
      await settled()

      if (navigatesBottomLayer) {
        app.router.layerHandle(a.id)!.router.visit('/a?page=2')
        await settled()
      }

      app.exitShells()
      await settled()

      return {
        went: go,
        sent: app.sent.slice(3),
        layers: app.layers().map((info) => info.url),
      }
    }

    expect(await pendingCloseOfTopLayer(false)).toEqual({
      went: [-1],
      sent: ['get /b'],
      layers: ['/a', '/b'],
    })
    expect(await pendingCloseOfTopLayer(true)).toEqual({
      went: [],
      sent: ['get /a?page=2'],
      layers: ['/a?page=2'],
    })
  })
})
