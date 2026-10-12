import { describe, expect, it } from 'vitest'
import { page, runtime, settled } from './runtime'

const users = page('Users/Index', '/users')
const picker = page('Users/Pick', '/users/pick', { layer: { key: 'picker', base: '/users' } })
const invite = page('Users/Invite', '/users/invite', { layer: { key: 'invite', base: '/users' } })
const roles = page('Roles/Pick', '/roles/pick', { layer: { key: 'roles', base: '/users' } })

/** Counts onClose calls, so "exactly once" is a number. */
const counted = (handle: { onClose(listener: () => void): unknown }) => {
  const calls = { closed: 0 }

  handle.onClose(() => calls.closed++)

  return calls
}

/** The shells report their exit as the adapters' dialogs do. */
const exitShells = (app: Awaited<ReturnType<typeof runtime>>) =>
  app
    .views()
    .filter((view) => !view.shell.open)
    .forEach((view) => view.shell.done())

describe('router.layer() with a url', () => {
  it('returns a pending handle that opens under its own id once the answer lands', async () => {
    const app = await runtime(users, { '/users/pick': picker })
    const handle = app.router.layer('/users/pick')
    const id = handle.id

    expect(handle.state).toBe('pending')
    expect(app.layers()).toEqual([])

    await settled()

    expect(handle.state).toBe('open')
    expect(handle.id).toBe(id)
    expect(app.layers()).toEqual([{ id, key: 'picker', component: 'Users/Pick', url: '/users/pick', type: 'routed' }])
    expect(app.sent).toEqual(['get /users/pick'])
    expect(app.written().at(-1)).toEqual(['push', '/users/pick'])
  })

  it('takes the id of the layer its answer rewrote', async () => {
    const app = await runtime(users, {
      '/users/pick': picker,
      '/users/pick?page=2': { ...picker, url: '/users/pick?page=2' },
    })

    app.router.visit('/users/pick')
    await settled()

    const [existing] = app.layers()
    const handle = app.router.layer('/users/pick?page=2')

    expect(handle.id).not.toBe(existing.id)

    await settled()

    expect(handle.id).toBe(existing.id)
    expect(handle.state).toBe('open')
    expect(app.layers().map((layer) => layer.url)).toEqual(['/users/pick?page=2'])
  })

  it('hands a layer opened from the page to the top layer, and one opened from a layer to that layer', async () => {
    const app = await runtime(users, { '/users/pick': picker, '/users/invite': invite, '/roles/pick': roles })

    const first = app.router.layer('/users/pick')
    await settled()
    const second = app.router.layer('/users/invite')
    await settled()
    const third = app.router.layerHandle(first.id)!.router.layer('/roles/pick')
    await settled()

    expect(
      (app.entry().layers as { key: string; owner: string | null }[]).map(({ key, owner }) => [key, owner]),
    ).toEqual([
      ['picker', null],
      ['invite', first.id],
      ['roles', first.id],
    ])
    expect([second.state, third.state]).toEqual(['open', 'open'])
  })
})

describe('onClose fires exactly once however the layer ends', () => {
  it('when onBefore refuses the open, with no request sent', async () => {
    const app = await runtime(users, { '/users/pick': picker })
    const handle = app.router.layer('/users/pick', { onBefore: () => false })
    const calls = counted(handle)

    await settled()

    expect(app.sent).toEqual([])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })

  it('when onBefore refuses an open that names a component to show at once, with no layer put up', async () => {
    const app = await runtime(users, { '/users/pick': picker })
    const handle = app.router.layer('/users/pick', { component: 'Users/Pick', onBefore: () => false })
    const calls = counted(handle)

    await settled()

    expect(app.sent).toEqual([])
    expect(app.layers()).toEqual([])
    expect(app.written()).toEqual([['replace', '/users']])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })

  it('when the handle is closed while its request is out, which cancels the request', async () => {
    const cancelled: string[] = []
    const app = await runtime(users, { '/users/pick': () => new Promise(() => {}) })
    const handle = app.router.layer('/users/pick', { onCancel: () => cancelled.push('cancelled') })
    const calls = counted(handle)

    await settled()
    expect(handle.state).toBe('pending')

    await handle.close()

    expect(cancelled).toEqual(['cancelled'])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
    expect(app.layers()).toEqual([])
  })

  it('when router.cancelAll() cancels the open', async () => {
    const app = await runtime(users, { '/users/pick': () => new Promise(() => {}) })
    const handle = app.router.layer('/users/pick')
    const calls = counted(handle)

    await settled()
    app.router.cancelAll()
    await settled()

    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })

  it('when the answer is an ordinary page, which becomes the page', async () => {
    const app = await runtime(users, { '/users/pick': page('Auth/Login', '/login') })
    const handle = app.router.layer('/users/pick')
    const calls = counted(handle)

    await settled()

    expect((await app.basePage()).component).toBe('Auth/Login')
    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })

  it('when the page beneath navigates away', async () => {
    const app = await runtime(users, { '/users/pick': picker, '/dashboard': page('Dashboard', '/dashboard') })
    const handle = app.router.layer('/users/pick')
    const calls = counted(handle)

    await settled()
    app.router.visit('/dashboard')
    await settled()

    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })

  it('when the handle closes the open layer, and a second close changes nothing', async () => {
    const app = await runtime(users, { '/users/pick': picker, '/users': users })
    const handle = app.router.layer('/users/pick')
    const calls = counted(handle)

    await settled()

    const closing = handle.close()

    expect(app.views().map((view) => view.shell.open)).toEqual([false])
    exitShells(app)
    await closing

    expect(window.location.pathname).toBe('/users')
    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')

    await handle.close()

    expect(calls.closed).toBe(1)
  })

  it('when Back leaves the entry the layer was pushed on', async () => {
    const app = await runtime(users, { '/users/pick': picker })
    const handle = app.router.layer('/users/pick')
    const calls = counted(handle)

    await settled()
    window.history.back()
    await settled()
    exitShells(app)
    await settled()

    expect(window.location.pathname).toBe('/users')
    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })

  it('when the server closes the layer', async () => {
    const app = await runtime(users, {
      '/users/pick': picker,
      'post /users/pick': { ...users, close: true },
      '/users': users,
    })
    const handle = app.router.layer('/users/pick')
    const calls = counted(handle)

    await settled()
    app.router.layerHandle(handle.id)!.router.post('/users/pick')
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })

  it('at once for a listener added after the layer ended', async () => {
    const app = await runtime(users, { '/users/pick': picker })
    const handle = app.router.layer('/users/pick', { onBefore: () => false })

    await settled()

    const calls = counted(handle)

    await settled()

    expect(calls.closed).toBe(1)
  })
})

describe('history traversal while a close refreshes the page beneath', () => {
  it('reopens the closed layer when its entry is restored before the refresh answers', async () => {
    let answerRefresh = () => {}
    const refresh = new Promise<void>((resolve) => (answerRefresh = resolve))
    const app = await runtime(users, { '/users/pick': picker, '/users': () => refresh.then(() => users) })
    const handle = app.router.layer('/users/pick')
    const calls = counted(handle)

    await settled()

    const id = handle.id

    void handle.close()
    exitShells(app)
    await settled()

    expect(app.sent).toEqual(['get /users/pick', 'get /users'])
    expect(app.layers()).toEqual([])

    window.history.go(1)
    await settled()
    answerRefresh()
    await settled()

    expect(window.location.pathname).toBe('/users/pick')
    expect(app.layers()).toEqual([{ id, key: 'picker', component: 'Users/Pick', url: '/users/pick', type: 'routed' }])
    expect(app.views().map((view) => view.shell.open)).toEqual([true])
    expect(calls.closed).toBe(1)
  })
})

describe('messages', () => {
  it('reach the handle and the scope of the layer that opened the sender, and no layer further down', async () => {
    const app = await runtime(users, { '/users/pick': picker, '/users/invite': invite, '/roles/pick': roles })
    const heard: unknown[] = []

    const bottom = app.router.layer('/users/pick')
    bottom.on('saved', (payload) => heard.push(['bottom handle', payload]))
    await settled()

    const middle = app.router.layer('/users/invite')
    middle.on('saved', (payload, from) => heard.push(['middle handle', payload, from]))
    await settled()
    app.router.layerHandle(middle.id)!.on('saved', (payload) => heard.push(['middle scope', payload]))

    const top = app.router.layer('/roles/pick')
    await settled()

    app.router.layerHandle(top.id)!.emit('saved', { id: 5 })

    expect(heard).toEqual([
      ['middle scope', { id: 5 }],
      [
        'middle handle',
        { id: 5 },
        { id: top.id, key: 'roles', component: 'Roles/Pick', url: '/roles/pick', type: 'routed' },
      ],
    ])
  })

  it('stop for a listener that was removed, and after the first one for once()', async () => {
    const app = await runtime(users, { '/users/pick': picker, '/users/invite': invite })
    const heard: string[] = []
    const owner = app.router.layer('/users/pick')
    const stop = owner.on('saved', () => heard.push('on'))

    owner.once('saved', () => heard.push('once'))
    await settled()

    const child = app.router.layer('/users/invite')
    await settled()

    const emit = () => app.router.layerHandle(child.id)!.emit('saved')

    emit()
    emit()
    stop()
    emit()

    expect(heard).toEqual(['on', 'once', 'on'])
  })
})

describe('router.layer() with a component', () => {
  it('opens a local layer with no request, as a history step on the address beneath', async () => {
    const app = await runtime(users, {})
    const handle = app.router.layer({ component: 'Confirm', props: { message: 'Discard?' } })
    const calls = counted(handle)

    await settled()

    expect(app.sent).toEqual([])
    expect(handle.state).toBe('open')
    expect(app.layers()).toEqual([{ id: handle.id, key: 'Confirm', component: 'Confirm', url: null, type: 'local' }])
    expect(app.views()[0].page.props).toEqual({ errors: {}, message: 'Discard?' })
    expect(app.written().at(-1)).toEqual(['push', '/users'])
    expect(calls.closed).toBe(0)

    window.history.back()
    await settled()
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect(calls.closed).toBe(1)
  })

  it('opens nothing when the handle was closed before the component resolved', async () => {
    const app = await runtime(users, {})
    const handle = app.router.layer({ component: 'Confirm' })
    const calls = counted(handle)

    void handle.close()
    await settled()

    expect(app.layers()).toEqual([])
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })
})

describe('error hand-back', () => {
  const rejected = page('Users/Index', '/users', {
    props: { errors: { name: 'The name is required.' } },
    flash: { notice: 'Not saved' },
  })

  it('lands the errors and flash on a layer that owns no address, and leaves the page beneath alone', async () => {
    const app = await runtime(users, { '/users/invite': invite, 'post /users': rejected })
    const events: unknown[] = []

    app.router.visit('/users/invite', { preserveUrl: true })
    await settled()
    expect(window.location.pathname).toBe('/users')

    const layer = app.router.layerHandle()!

    layer.router.post(
      '/users',
      {},
      { onError: (errors) => events.push(['error', errors]), onSuccess: () => events.push(['success']) },
    )
    await settled()

    expect(events).toEqual([['error', { name: 'The name is required.' }]])
    expect(app.views()[0].page).toMatchObject({
      component: 'Users/Invite',
      url: '/users/invite',
      props: { errors: { name: 'The name is required.' } },
      flash: { notice: 'Not saved' },
    })
    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', props: { errors: {} }, flash: {} })
    expect(app.layers().map((open) => open.component)).toEqual(['Users/Invite'])
  })

  it('does not apply to a layer that owns the address: the answer navigates, and the errors show on the page', async () => {
    const app = await runtime(users, { '/users/invite': invite, 'post /users': rejected })

    app.router.visit('/users/invite')
    await settled()
    app.router.layerHandle()!.router.post('/users')
    await settled()

    expect(app.layers()).toEqual([])
    expect((await app.basePage()).props.errors).toEqual({ name: 'The name is required.' })
  })

  it('does not apply to an answer without errors', async () => {
    const app = await runtime(users, { '/users/invite': invite, 'post /users': users })

    app.router.visit('/users/invite', { preserveUrl: true })
    await settled()
    app.router.layerHandle()!.router.post('/users')
    await settled()

    expect(app.layers()).toEqual([])
    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', props: { errors: {} } })
  })
})

describe('an interstitial prompt', () => {
  const prompt = page('Auth/Confirm', '/confirm', { interstitial: true })
  const card = page('Billing/Card', '/billing/card', { layer: { key: 'card', base: '/billing' } })

  it('sets the page aside and brings it back under the layer with no request, in one replace of the prompt entry', async () => {
    const answers = [prompt, card]
    const app = await runtime(users, { '/billing/card': () => Promise.resolve(answers.shift()!) })
    const handle = app.router.layer('/billing/card')
    const calls = counted(handle)

    await settled()

    expect((await app.basePage()).component).toBe('Auth/Confirm')
    expect(handle.state).toBe('pending')
    expect(app.written().at(-1)).toEqual(['push', '/confirm'])

    const writes = app.written().length

    app.router.visit('/billing/card')
    await settled()

    expect(app.sent).toEqual(['get /billing/card', 'get /billing/card'])
    expect((await app.basePage()).component).toBe('Users/Index')
    expect(handle.state).toBe('open')
    expect(app.layers()).toEqual([
      { id: handle.id, key: 'card', component: 'Billing/Card', url: '/billing/card', type: 'routed' },
    ])
    expect(app.written().slice(writes)).toEqual([['replace', '/billing/card']])
    expect(app.entry()).toMatchObject({ component: 'Users/Index', layers: [{ id: handle.id, entries: 1 }] })
    expect(calls.closed).toBe(0)

    window.history.back()
    await settled()
    exitShells(app)
    await settled()

    expect(window.location.pathname).toBe('/users')
    expect((await app.basePage()).component).toBe('Users/Index')
    expect(calls.closed).toBe(1)
  })

  it('is over once the page navigates away: the handle closes and the next layer opens over the page on screen', async () => {
    const answers = [prompt, card]
    const app = await runtime(users, {
      '/billing/card': () => Promise.resolve(answers.shift()!),
      '/dashboard': page('Dashboard', '/dashboard'),
    })
    const handle = app.router.layer('/billing/card')
    const calls = counted(handle)

    await settled()
    app.router.visit('/dashboard')
    await settled()

    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)

    app.router.visit('/billing/card')
    await settled()

    expect((await app.basePage()).component).toBe('Dashboard')
    expect(app.layers().map((open) => open.component)).toEqual(['Billing/Card'])
  })

  it('lets go of a handle closed while it shows: the layer answer after it still returns over the page set aside', async () => {
    const answers = [prompt, card]
    const app = await runtime(users, { '/billing/card': () => Promise.resolve(answers.shift()!) })
    const handle = app.router.layer('/billing/card')
    const calls = counted(handle)

    await settled()
    await handle.close()

    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)

    app.router.visit('/billing/card')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers().map((open) => [open.component, open.id === handle.id])).toEqual([['Billing/Card', false]])
    expect(calls.closed).toBe(1)
  })

  it('is over after Back: the handle closes and the page set aside is the one history restores', async () => {
    const app = await runtime(users, { '/billing/card': prompt })
    const handle = app.router.layer('/billing/card')
    const calls = counted(handle)

    await settled()
    window.history.back()
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(handle.state).toBe('closed')
    expect(calls.closed).toBe(1)
  })
})
