import { describe, expect, it } from 'vitest'
import {
  base,
  counted,
  edit,
  notes,
  openCold,
  page,
  ported,
  rawResponse,
  settled,
  veto,
} from './support/layer-handles-support'

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

  it('lands a baseless layer answer on the placeholder its open put up, keeping the handle', async () => {
    const app = await ported(base(), {
      '/users/5/edit': page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit' }, props: { errors: {} } }),
    })
    const handle = app.router.layer('http://localhost/users/5/edit', { component: 'Users/Loading' } as never)
    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(0)
    expect(handle.state).toBe('open')
    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((layer) => [layer.id, layer.component])).toEqual([[handle.id, 'Users/Edit']])
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

    const handle = await openCold(app)
    const calls = counted(handle)

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
