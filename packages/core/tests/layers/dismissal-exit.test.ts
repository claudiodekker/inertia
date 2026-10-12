import { describe, expect, it } from 'vitest'
import { openApp } from './support/app'
import { page, settled } from './support/browser'
import { holdBack } from './support/handles'
import { base, edit, layerAt } from './support/pages'

describe('a dismissal and the refresh of a close', () => {
  it('a dismissal waits for the layers it marked, not for a close still refreshing', async () => {
    let answerRefresh = () => {}
    let holding = false
    const refresh = new Promise<void>((resolve) => (answerRefresh = resolve))
    const app = await openApp(base(), {
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
    const app = await openApp(base(), {
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
    const app = await openApp(base(), { '/users/5/edit': () => Promise.resolve(answer), '/users': base() })
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
    const app = await openApp(base(), {})
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
    const app = await openApp(base(), {
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
    const app = await openApp(base(), {
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
