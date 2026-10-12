import { describe, expect, it } from 'vitest'
import { base, counted, edit, holdBack, layerAt, page, ported, settled } from './layer-handles-support'

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
    const app = await ported(base(), routes())
    const handles = []

    for (const url of urls) {
      const [target, options] = typeof url === 'string' ? [url, {}] : url

      handles.push(app.router.layer(`http://localhost${target}`, options))
      await settled()
    }

    return { app, handles }
  }

  it('resolves once the layer is off the screen, not when it starts closing', async () => {
    const app = await ported(base(), {})
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
    const app = await ported(base(), { '/users': layerAt('Users/Edit', '/users') })

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
    const app = await ported(base(), routes())
    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)

    await settled()

    const go = app.go()

    await app.closing(handle)

    expect(go).toEqual([])
    expect(app.written().at(-1)).toEqual(['push', '/users'])
    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('leaves the page the stack was opened over in place', async () => {
    const app = await ported(base(), routes())
    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)

    await settled()

    const over = app.current.get()

    await app.closing(handle)
    await settled()

    expect(app.current.get().component).toBe('Users/Index')
    expect(app.current.get().props).toEqual(over.props)
  })

  it('does nothing when there is no stack to close', async () => {
    const app = await ported(base(), routes())
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
    const app = await ported(base(), { '/users/5/edit': edit({ encryptHistory: true }), '/users': base() })

    Object.assign(window, { crypto: globalThis.crypto })

    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)

    await settled()

    const entry = (window.history.state as { page: unknown }).page
    const { history } = await import('../../../src/history')

    expect(entry).toBeInstanceOf(ArrayBuffer)

    const restored = await history.decrypt(entry as ArrayBuffer)

    expect((restored as { layers: unknown[] }).layers).toEqual([
      expect.objectContaining({ id: handle.id, standalone: true }),
    ])
  })
})

describe('a dismissal and the refresh of a close', () => {
  it('a dismissal waits for the layers it marked, not for a close still refreshing', async () => {
    let answerRefresh = () => {}
    let holding = false
    const refresh = new Promise<void>((resolve) => (answerRefresh = resolve))
    const app = await ported(base(), {
      '/a': layerAt('Users/A', '/a'),
      '/b': () => (holding ? refresh : Promise.resolve()).then(() => layerAt('Users/B', '/b')),
      '/c': layerAt('Users/C', '/c'),
    })

    app.router.layer('http://localhost/a')
    await settled()
    app.router.layer('http://localhost/b')
    await settled()
    const c = app.router.layer('http://localhost/c')
    await settled()

    const [a, b] = app.layers()

    holding = true

    const closingC = c.close()

    await settled()
    app.exitShells()
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([a.id, b.id])

    let closedAbove = false
    const above = app.router.close(b.id).then(() => (closedAbove = true))

    await settled()
    answerRefresh()
    await settled()

    expect(closedAbove).toBe(false)

    app.exitShells()
    await above
    await closingC

    expect(app.layers().map((layer) => layer.id)).toEqual([a.id])
  })
})

describe('the window between close and done', () => {
  const stack = async (...urls: string[]) => {
    const app = await ported(base(), {
      '/users/5/edit': edit(),
      '/a': layerAt('Users/A', '/a'),
      '/b': layerAt('Users/B', '/b'),
      '/c': layerAt('Users/C', '/c'),
      '/users': base(),
    })
    const handles = []

    for (const url of urls) {
      handles.push(app.router.layer(`http://localhost${url}`))
      await settled()
    }

    const done = (id: string) =>
      app
        .views()
        .find((view) => view.id === id)!
        .shell.done()

    return { app, handles, done }
  }

  it('marks the layer rather than removing it', async () => {
    const { app, handles } = await stack('/users/5/edit')

    void handles[0].close()
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handles[0].id])
    expect(app.views().map((view) => !view.shell.open)).toEqual([true])
  })

  it('marks every layer above the one being closed', async () => {
    const { app, handles } = await stack('/a', '/b', '/c')

    void app.router.close(handles[1].id)
    await settled()

    expect(app.views().map((view) => !view.shell.open)).toEqual([false, true, true])
  })

  it('leaves history alone until the exit has run', async () => {
    const { app, handles } = await stack('/users/5/edit')
    const go = app.go()
    const writes = app.written().length

    void handles[0].close()
    await settled()

    expect(go).toEqual([])
    expect(app.written().length).toBe(writes)
  })

  it('removes the layer once the exit has run', async () => {
    const { app, handles } = await stack('/users/5/edit')
    const go = app.go()

    await app.closing(handles[0])

    expect(go).toEqual([-1])
    expect(app.layers()).toEqual([])
  })

  it('waits for every layer it marked before removing any of them', async () => {
    const { app, handles, done } = await stack('/a', '/b')
    const go = app.go()
    const closing = app.router.close(handles[0].id)

    await settled()
    done(handles[1].id)
    await settled()

    expect(go).toEqual([])

    done(handles[0].id)
    await closing

    expect(go).toEqual([-2])
  })

  it('ignores an exit reported by a layer nobody closed', async () => {
    const { app, handles, done } = await stack('/a', '/b')
    const go = app.go()

    done(handles[1].id)
    await settled()

    expect(go).toEqual([])
    expect(app.layers().map((layer) => layer.id)).toEqual(handles.map((handle) => handle.id))
  })

  it('does not restart an exit already under way', async () => {
    const { app, handles, done } = await stack('/a', '/b')
    const go = app.go()
    const first = app.router.close(handles[0].id)

    await settled()
    done(handles[1].id)
    await settled()

    const second = app.router.close(handles[0].id)

    await settled()
    done(handles[0].id)
    await Promise.all([first, second])

    expect(go).toEqual([-2])
  })

  it('keeps the exits already reported when a close extends to a lower layer', async () => {
    const { app, handles, done } = await stack('/a', '/b', '/c')
    const go = app.go()
    const upper = app.router.close(handles[1].id)

    await settled()
    done(handles[2].id)
    await settled()

    const lower = app.router.close(handles[0].id)

    await settled()
    done(handles[1].id)
    await settled()
    done(handles[0].id)
    await Promise.all([upper, lower])

    expect(go).toEqual([-3])
  })

  it('cancels the pending removal when the layer is superseded', async () => {
    const { app, handles, done } = await stack('/users/5/edit')
    const go = app.go()
    const closing = handles[0].close()

    await settled()

    const [before] = app.views()

    expect(before.shell.open).toBe(false)

    app.router.layer('http://localhost/users/5/edit')
    await settled()

    expect(app.views().map((view) => view.shell.open)).toEqual([true])

    done(handles[0].id)
    await settled()
    await closing

    expect(go).toEqual([])
    expect(app.layers().map((layer) => layer.id)).toEqual([handles[0].id])
  })

  it('keeps the pending removal when the layer is refreshed where it stands', async () => {
    let answer: Record<string, unknown> = edit()
    const app = await ported(base(), { '/users/5/edit': () => Promise.resolve(answer), '/users': base() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const go = app.go()
    const closing = handle.close()

    await settled()
    answer = edit({ props: { users: ['ada'], errors: {} } })
    app.router.layerHandle(handle.id)!.router.reload({ only: ['users'] })
    await settled()

    expect(app.views().map((view) => !view.shell.open)).toEqual([true])
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, users: ['ada'], errors: {} })

    app.exitShells()
    await closing

    expect(go).toEqual([-1])
  })

  it('keeps a layer being closed on the page it is rendered from', async () => {
    const { app, handles } = await stack('/a', '/b')

    void handles[1].close()
    await settled()
    await new Promise<void>((resolve) => {
      app.router.replace({ props: { users: ['ada'] }, onSuccess: () => resolve() })
    })

    expect(app.layers().map((layer) => layer.id)).toEqual(handles.map((handle) => handle.id))
    expect(app.views().map((view) => !view.shell.open)).toEqual([false, true])
  })

  it('does nothing on a page that has no stack at all', async () => {
    const app = await ported(base(), {})
    const go = app.go()
    const writes = app.written().length

    await app.router.close()
    await settled()

    expect(go).toEqual([])
    expect(app.written().length).toBe(writes)
    expect(app.views()).toEqual([])
  })
})

describe('while the unwind is in flight', () => {
  const stack = async (...urls: string[]) => {
    const app = await ported(base(), {
      '/users/5/edit': edit(),
      '/users/5/notes': layerAt('Users/Notes', '/users/5/notes'),
      '/users/9': page('Users/Show', '/users/9'),
      '/users': base(),
    })
    const handles = []

    for (const url of urls) {
      handles.push(app.router.layer(`http://localhost${url}`))
      await settled()
    }

    return { app, handles }
  }

  it('does not unwind a second time for a close issued inside the window', async () => {
    const { app, handles } = await stack('/users/5/edit')
    const browser = holdBack()
    const first = handles[0].close()

    await settled()
    app.exitShells()
    await settled()

    expect(browser.held).toEqual([-1])

    const second = app.router.close(handles[0].id)

    await settled()
    app.exitShells()
    await settled()

    expect(browser.held).toEqual([-1])

    browser.answer()
    await Promise.all([first, second])

    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/users')
  })

  it('runs a close issued inside the window once the browser has answered the step back [BEHAVIOUR CHANGED]', async () => {
    const { app, handles } = await stack('/users/5/edit', '/users/5/notes')
    const browser = holdBack()
    const first = handles[1].close()

    await settled()
    app.exitShells()
    await settled()

    const second = handles[0].close()

    await settled()

    expect(browser.held).toEqual([-1])
    expect(app.views().map((view) => view.shell.open)).toEqual([false, false])

    browser.answer()
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([handles[0].id])
    expect(app.views().map((view) => view.shell.open)).toEqual([false])

    const go = app.go()

    app.exitShells()
    await settled()

    expect(go).toEqual([-1])

    await Promise.all([first, second])

    expect(app.layers()).toEqual([])
    expect(window.location.pathname).toBe('/users')
  })

  it('resolves an exit only once the browser has restored what was beneath', async () => {
    const { app, handles } = await stack('/users/5/edit')
    const browser = holdBack()
    let resolved = false
    const closing = handles[0].close().then(() => (resolved = true))

    await settled()
    app.exitShells()
    await settled()

    expect(resolved).toBe(false)
    expect(app.layers()).toHaveLength(1)

    browser.answer()
    await closing

    expect(resolved).toBe(true)
    expect(app.layers()).toEqual([])
  })

  it('holds an instant visit until the step back has restored', async () => {
    const { app, handles } = await stack('/users/5/edit')
    const browser = holdBack()
    const closing = handles[0].close()

    await settled()
    app.exitShells()
    await settled()
    app.router.visit('/users/9', { component: 'Users/Show' } as never)
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')

    browser.answer()
    await closing
    await settled()

    expect((await app.basePage()).component).toBe('Users/Show')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('holds a response that lands mid-close until the step back has restored', async () => {
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    const app = await ported(base(), {
      '/users/5/edit': edit({ layer: { key: 'Users/Edit' } }),
      'post /users/5': () =>
        held.then(() => page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit' }, props: { errors: {} } })),
      '/users': base(),
    })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const result = new Promise<string>((resolve) => {
      app.router.visit('http://localhost/users/5', {
        method: 'post',
        onSuccess: () => resolve('success'),
        onError: () => resolve('error'),
      })
    })

    await settled()

    const browser = holdBack()
    const closing = handle.close()

    await settled()
    app.exitShells()
    await settled()
    answer()
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')

    browser.answer()
    await closing

    expect(await result).toBe('success')
    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })
})

describe('closing through the router', () => {
  it('closes the topmost layer when none is named', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })

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
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
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

describe('the layer handle lookup', () => {
  it('keeps no handle when there is no browser, so a server render never shares one', async () => {
    const app = await ported(base(), {})
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
    const app = await ported(base(), { '/users/5/edit': edit() })
    const handle = app.router.layer('http://localhost/users/5/edit')

    await settled()

    const scope = app.router.layerHandle(handle.id)!

    expect(scope.id).toBe(handle.id)
    expect(scope.key).toBe('Users/Edit')
    expect(app.router.layerHandle(handle.id)).toBe(scope)
    expect(app.router.layerHandle()).toBe(scope)
  })

  it('releases the handle of a layer once its removal has settled', async () => {
    const app = await ported(base(), { '/users/5/edit': edit(), '/users': base() })
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
    const app = await ported(base(), { '/users/5/edit': edit(), '/users/5': page('Users/Show', '/users/5') })
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
    const app = await ported(base(), { '/users/5/edit': edit() })
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
