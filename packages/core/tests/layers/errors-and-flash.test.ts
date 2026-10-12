import { describe, expect, it } from 'vitest'
import { exitShells, openAppSentCall, type SentCallApp, type Route, openApp, byPath, gate } from './support/app'
import { page, settled } from './support/browser'

const index = (extra: Record<string, unknown> = {}) =>
  page('Users/Index', '/users', { props: { users: [], errors: {} }, ...extra })

const editWith = (extra: Record<string, unknown> = {}) =>
  page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  })

const users = page('Users/Index', '/users', {
  props: { errors: {}, users: [] },
})

const editPage = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit' },
  props: { errors: {}, user: { id: 5 } },
})

const teamsShow = page('Teams/Show', '/teams/9', {
  layer: { key: 'Teams/Show' },
  props: { errors: {}, team: { id: 9 } },
})

describe('a submit answered by the tier the layer stands on', () => {
  const openLocal = async (routes: Record<string, Route>) => {
    const app = await openAppSentCall(index(), routes)
    const handle = app.router.layer({
      component: 'Users/Confirm',
      props: { user: 5 },
    })

    await settled()

    return { app, handle }
  }

  const openLocalOverALayer = async (routes: Record<string, Route>) => {
    const app = await openAppSentCall(index(), { '/users/5/edit': editWith(), ...routes })

    app.router.visit('/users/5/edit')
    await settled()

    const handle = app.router.layer({
      component: 'Users/Confirm',
      props: { user: 5 },
    })

    await settled()

    return { app, handle, editId: app.layers()[0].id }
  }

  const submit = (app: SentCallApp, id: string) =>
    new Promise<unknown>((resolve) => {
      app.router.layerHandle(id)!.router.post('/users', {}, { onError: resolve, onSuccess: () => resolve({}) })
    })

  it('keeps a local layer up and gives it the errors the server handed back', async () => {
    const { app, handle } = await openLocal({
      'post /users': index({
        props: { users: [], errors: { name: 'The name is required.' } },
      }),
    })

    const announced = await submit(app, handle.id)

    expect(announced).toEqual({ name: 'The name is required.' })
    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id])
    expect(app.views()[0].page.props.errors).toEqual({
      name: 'The name is required.',
    })
    expect((await app.basePage()).props.errors).toEqual({})
  })

  it('hands the flash back to the layer along with the errors', async () => {
    const { app, handle } = await openLocal({
      'post /users': index({
        props: { users: [], errors: { name: 'Required.' } },
        flash: { message: 'Check the form.' },
      }),
    })
    const flashes: unknown[] = []

    await new Promise<void>((resolve) => {
      app.router.layerHandle(handle.id)!.router.post(
        '/users',
        {},
        {
          onFlash: (flash) => flashes.push(flash),
          onError: () => resolve(),
          onSuccess: () => resolve(),
        },
      )
    })

    expect(flashes).toEqual([{ message: 'Check the form.' }])
    expect(app.views()[0].page.flash).toEqual({ message: 'Check the form.' })
    expect((await app.basePage()).flash).toEqual({})
  })

  it('clears the stack when the same submit comes back without errors', async () => {
    const { app, handle } = await openLocal({
      'post /users': index({ props: { users: [{ id: 9 }], errors: {} } }),
    })

    await submit(app, handle.id)
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect((await app.basePage()).props).toEqual({
      users: [{ id: 9 }],
      errors: {},
    })
  })

  it('clears the stack when the errors come back on another page altogether', async () => {
    const { app, handle } = await openLocal({
      'post /users': page('Users/Create', '/users/create', {
        props: { errors: { name: 'Required.' } },
      }),
    })

    await submit(app, handle.id)
    exitShells(app)
    await settled()

    expect(app.layers()).toEqual([])
    expect((await app.basePage()).component).toBe('Users/Create')
  })

  it('keeps a local layer up when the address it was submitted from belongs to the layer beneath it', async () => {
    const { app, handle, editId } = await openLocalOverALayer({
      'post /users': editWith({
        props: { user: { id: 5 }, errors: { name: 'The name is required.' } },
      }),
    })

    const announced = await submit(app, handle.id)

    expect(announced).toEqual({ name: 'The name is required.' })
    expect(app.layers().map((layer) => layer.id)).toEqual([editId, handle.id])
    expect(app.views()[1].page.props.errors).toEqual({
      name: 'The name is required.',
    })
    expect(app.views()[0].page.props.errors).toEqual({})
  })

  it('closes the local layer when the errors come back from another url of that layer', async () => {
    const { app, handle, editId } = await openLocalOverALayer({
      'post /users': editWith({
        url: '/users/6/edit',
        props: { user: { id: 6 }, errors: { name: 'Required.' } },
      }),
    })

    await submit(app, handle.id)
    exitShells(app)
    await settled()

    expect(app.layers().map((layer) => layer.id)).toEqual([editId])
    expect(app.views()[0].page.props.errors).toEqual({ name: 'Required.' })
  })
})

describe("a layer response's errors", () => {
  const rejected = {
    ...editPage,
    props: { errors: { note: 'The note is required.' }, user: { id: 5 } },
  }

  const observing = () => {
    const seen = { events: [] as string[], errors: undefined as unknown }

    return {
      seen,
      callbacks: {
        onError: (errors: unknown) => {
          seen.errors = errors
          seen.events.push('error')
        },
        onSuccess: () => seen.events.push('success'),
      },
    }
  }

  it("announces a layer response's errors through the layer's bag, not the page's", async () => {
    const app = await openApp(users, byPath({ '/users/5/edit': rejected }))
    const { seen, callbacks } = observing()

    app.router.visit('/users/5/edit', callbacks)
    await settled()

    expect(seen.events).toEqual(['error'])
    expect(seen.errors).toEqual({ note: 'The note is required.' })
    expect(app.views()[0].page.props.errors).toEqual({
      note: 'The note is required.',
    })
    expect((await app.basePage()).props.errors).toEqual({})
  })

  it('announces the errors a rewrite of an open layer brings through that layer', async () => {
    let answers = [editPage, rejected]
    const app = await openApp(users, () => answers.shift()!)

    app.router.visit('/users/5/edit')
    await settled()

    const [open] = app.layers()
    const { seen, callbacks } = observing()

    app.router.visit('/users', { method: 'post', ...callbacks })
    await settled()

    expect(seen.errors).toEqual({ note: 'The note is required.' })
    expect(seen.events).toEqual(['error'])
    expect(app.layers()).toEqual([open])
    expect(app.views()[0].page.props.errors).toEqual({
      note: 'The note is required.',
    })
  })

  it('announces a rewrite of a non-top layer through that layer, not the top', async () => {
    const bare = { ...teamsShow, props: { team: { id: 9 } } }
    const answers = [editPage, bare, rejected]
    const app = await openApp(users, () => answers.shift()!)

    app.router.visit('/users/5/edit')
    await settled()
    app.router.visit('/teams/9')
    await settled()

    const [beneath] = app.layers()
    const top = app.views()[1].page
    const { seen, callbacks } = observing()

    expect(app.layers()).toHaveLength(2)

    app.router.visit('/users', { method: 'post', ...callbacks })
    await settled()
    exitShells(app)
    await settled()

    expect(seen.errors).toEqual({ note: 'The note is required.' })
    expect(seen.events).toEqual(['error'])
    expect(app.layers()).toEqual([beneath])
    expect(app.views()[0].page.props.errors).toEqual({
      note: 'The note is required.',
    })
    expect(top.props).not.toHaveProperty('errors')
  })

  it("a page response's errors announce exactly as they always have", async () => {
    const app = await openApp(
      users,
      byPath({
        '/users': {
          ...users,
          props: { errors: { name: 'The name is required.' }, users: [] },
        },
      }),
    )
    const { seen, callbacks } = observing()

    app.router.visit('/users', callbacks)
    await settled()

    expect(seen.events).toEqual(['error'])
    expect(seen.errors).toEqual({ name: 'The name is required.' })
  })
})

describe("a layer response's flash", () => {
  const saved = { ...editPage, flash: { message: 'Saved.' } }

  it("announces a layer response's flash through the layer, whose own page carries it", async () => {
    const app = await openApp(users, byPath({ '/users/5/edit': saved }))
    const announced: unknown[] = []

    app.router.visit('/users/5/edit', {
      onFlash: (flash) => announced.push(flash),
    })
    await settled()

    expect(announced).toEqual([{ message: 'Saved.' }])
    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })
    expect((await app.basePage()).flash).toEqual({})
  })

  it("strips a layer's flash from the history entry it leaves", async () => {
    const app = await openApp(users, byPath({ '/users/5/edit': saved }))

    app.router.visit('/users/5/edit')
    await settled()

    expect(app.written().at(-1)).toEqual(['push', '/users/5/edit'])
    expect(app.entry().layers![0].flash).toBeUndefined()
    expect(app.entry().flash).toEqual({})
    expect(JSON.stringify(window.history.state)).not.toContain('Saved.')
  })

  it("a layer's live flash survives a history merge that does not touch it", async () => {
    const app = await openApp(users, byPath({ '/users/5/edit': saved }))

    app.router.visit('/users/5/edit')
    await settled()
    app.router.layerHandle()!.router.remember('typed', 'note')

    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })

    await settled()

    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })
    expect(app.entry().layers![0].rememberedState).toEqual({ note: 'typed' })
  })

  it("router.flash with no layer open fires onFlash with the page's flash", async () => {
    const baseFlashes: unknown[] = []
    const app = await openApp(users, byPath({}), {
      onFlash: (flash) => baseFlashes.push(flash),
    })

    app.router.flash('message', 'Saved.')

    expect((await app.basePage()).flash).toEqual({ message: 'Saved.' })
    expect(baseFlashes).toEqual([{ message: 'Saved.' }])
  })

  it("a flash written to a layer never reaches the page's own flash", async () => {
    const baseFlashes: unknown[] = []
    const app = await openApp(users, byPath({ '/users/5/edit': editPage }), {
      onFlash: (flash) => baseFlashes.push(flash),
    })

    app.router.visit('/users/5/edit')
    await settled()
    app.router.layerHandle()!.router.flash('message', 'Saved.')

    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })
    expect((await app.basePage()).flash).toEqual({})
    expect(baseFlashes).toEqual([])
  })

  it('re-renders the layer a flash was written to, since no callback carries it', async () => {
    const app = await openApp(users, byPath({ '/users/5/edit': editPage }))

    app.router.visit('/users/5/edit')
    await settled()

    const painted: unknown[] = []

    app.core.layerSlot.subscribe(() => {
      painted.push(app.views().map((view) => view.page.flash))
    })
    app.router.layerHandle()!.router.flash('message', 'Saved.')
    await settled()

    expect(painted).toEqual([[{ message: 'Saved.' }]])
  })

  it("router.flash from inside a layer targets the layer's flash", async () => {
    const app = await openApp(users, byPath({ '/users/5/edit': editPage }))

    app.router.visit('/users/5/edit')
    await settled()

    const [open] = app.layers()

    app.router.layerHandle(open.id)!.router.flash('message', 'Saved.')

    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })
    expect((await app.basePage()).flash).toEqual({})
  })

  it("a layer's deferred response keeps the flash the layer already had", async () => {
    const follow = gate()
    const app = await openApp(users, (request) =>
      request.headers['X-Inertia-Partial-Data'] === undefined
        ? {
            ...saved,
            deferredProps: { slow: ['stats'] },
            rescuedProps: ['stats'],
          }
        : follow.opened.then(() => ({
            ...editPage,
            props: { errors: {}, user: { id: 5 }, stats: [1, 2, 3] },
            rescuedProps: [],
          })),
    )

    app.router.visit('/users/5/edit')
    await settled()
    follow.open()
    await settled()

    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1, 2, 3],
    })
    expect(app.views()[0].page.flash).toEqual({ message: 'Saved.' })
  })
})
