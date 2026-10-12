import { describe, expect, it } from 'vitest'
import { exitShells, page, scenario, settled, type Answer, type Route } from './support/a-support'

const users = page('Users/Index', '/users', {
  props: { users: [], errors: {} },
})

const editLayerPage = (extra: Answer = {}) =>
  page('Users/Edit', '/users/5/edit', {
    layer: { key: 'Users/Edit' },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  })

const teams = page('Teams/Show', '/teams/9', {
  layer: { key: 'Teams/Show' },
  props: { errors: {} },
})

const open = async (initial: Answer = users, routes: Record<string, Route> = {}) => {
  const app = await scenario(initial, {
    '/users/5/edit': editLayerPage(),
    '/teams/9': teams,
    ...routes,
  })

  app.router.visit('/users/5/edit')
  await settled()

  return app
}

const ids = (app: Awaited<ReturnType<typeof scenario>>) => app.layers().map((layer) => layer.id)

/** Records what each base swap hands the adapter. */
async function recordSwaps() {
  const { page: basePage } = await import('../../../src/page')
  const recorded: { component: unknown; preserveState: boolean }[] = []
  const target = basePage as unknown as {
    swapComponent: (args: any) => Promise<void>
  }

  target.swapComponent = async ({ component, preserveState }) => {
    recorded.push({ component, preserveState })
  }

  return () => recorded
}

describe('base generation', () => {
  it('changes when a page response replaces the base', async () => {
    const app = await open(users, {
      '/users/5': page('Users/Show', '/users/5'),
    })

    app.router.visit('/users/5')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Show')
    expect(app.layers()).toEqual([])
  })

  it('survives a layer composed onto the base', async () => {
    const app = await open()
    const [first] = app.layers()

    app.router.visit('/teams/9')
    await settled()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit', 'Teams/Show'])
    expect(app.layers()[0].id).toBe(first.id)
    expect((await app.basePage()).component).toBe('Users/Index')
  })

  it('changes when a navigation lands on the very same page', async () => {
    const app = await open(users, { '/users': users })
    const before = ids(app)

    app.router.visit('/users')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(before).toHaveLength(1)
    expect(ids(app)).toEqual([])
  })

  it('survives a partial reload of the same page', async () => {
    const app = await open(users, {
      '/users': page('Users/Index', '/users', {
        props: { users: [{ id: 1 }], errors: {} },
      }),
    })
    const before = ids(app)

    app.router.reload({ only: ['users'] })
    await settled()

    expect(ids(app)).toEqual(before)
    expect((await app.basePage()).props).toEqual({
      users: [{ id: 1 }],
      errors: {},
    })
  })

  it('survives a client visit that only rewrites the url', async () => {
    const app = await open()
    const before = ids(app)

    app.router.replace({ url: 'http://localhost/users?page=2' })
    await settled()

    expect(ids(app)).toEqual(before)
    expect((await app.basePage()).url).toBe('http://localhost/users?page=2')
  })

  it('changes when a client visit declares another component', async () => {
    const app = await open()

    app.router.push({
      component: 'Users/Create',
      url: 'http://localhost/users/create',
    })
    await settled()

    expect((await app.basePage()).component).toBe('Users/Create')
    expect(app.layers()).toEqual([])
  })

  it('changes when a client visit pushes another page state', async () => {
    const app = await open()

    app.router.push({
      url: 'http://localhost/users/2',
      props: { users: [{ id: 2 }] },
    })
    await settled()

    expect((await app.basePage()).url).toBe('http://localhost/users/2')
    expect(app.layers()).toEqual([])
  })

  it('survives the prop helpers rewriting the page in place', async () => {
    const app = await open()
    const before = ids(app)

    app.router.replaceProp('users', [{ id: 1 }])
    expect(ids(app)).toEqual(before)
    expect((await app.basePage()).props.users).toEqual([{ id: 1 }])

    app.router.appendToProp('users', { id: 2 })
    expect(ids(app)).toEqual(before)
    expect((await app.basePage()).props.users).toEqual([{ id: 1 }, { id: 2 }])

    app.router.prependToProp('users', { id: 0 })
    expect(ids(app)).toEqual(before)
    expect((await app.basePage()).props.users).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }])
  })

  it('changes when history restores a page', async () => {
    const app = await scenario(users, {
      '/dashboard': page('Dashboard', '/dashboard'),
      '/users/5/edit': editLayerPage(),
    })

    app.router.visit('/dashboard')
    await settled()
    app.router.visit('/users/5/edit')
    await settled()
    expect(app.layers().map((layer) => layer.component)).toEqual(['Users/Edit'])

    window.history.go(-2)
    await settled()

    expect((await app.basePage()).component).toBe('Users/Index')
    expect(app.layers()).toEqual([])
  })

  it('survives a prop refresh of the base', async () => {
    const app = await open(users, {
      '/users': page('Users/Index', '/users', {
        props: { users: [{ id: 1 }], errors: {} },
      }),
    })
    const before = ids(app)

    app.router.reload({ only: ['users'], preserveState: true })
    await settled()

    expect(ids(app)).toEqual(before)
    expect((await app.basePage()).props.users).toEqual([{ id: 1 }])
  })
})

describe('base id', () => {
  const ownersOf = (app: Awaited<ReturnType<typeof scenario>>) =>
    (app.entry().layers as { owner: string | null }[]).map((layer) => layer.owner)

  it('is created for the base it is given', async () => {
    const app = await open()

    expect(ownersOf(app)).toEqual([null])
    expect((await app.basePage()).component).toBe('Users/Index')
  })

  it('survives a layer composed onto the base', async () => {
    const app = await open()
    const [first] = app.layers()

    app.router.visit('/teams/9')
    await settled()

    expect(app.layers()[0].id).toBe(first.id)
    expect((app.entry().layers as { owner: string | null }[])[0].owner).toBeNull()
  })

  it('survives a partial reload of the same page', async () => {
    const app = await open(users, {
      '/users': page('Users/Index', '/users', {
        props: { users: [{ id: 1 }], errors: {} },
      }),
    })
    const [first] = app.layers()

    app.router.reload({ only: ['users'] })
    await settled()

    expect(app.layers()).toEqual([first])
    expect(ownersOf(app)).toEqual([null])
  })

  it('survives a plain reload of the same page', async () => {
    const app = await open(users, {
      '/users': page('Users/Index', '/users', {
        props: { users: [{ id: 9 }], errors: {} },
      }),
    })
    const [first] = app.layers()

    app.router.reload()
    await settled()

    expect(app.layers()).toEqual([first])
    expect(ownersOf(app)).toEqual([null])
  })

  it('changes when a navigation replaces the base', async () => {
    const app = await open(users, {
      '/users/5': page('Users/Show', '/users/5'),
    })
    const [first] = app.layers()

    app.router.visit('/users/5')
    await settled()
    app.router.visit('/teams/9')
    await settled()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Teams/Show'])
    expect(app.layers()[0].id).not.toBe(first.id)
    expect(ownersOf(app)).toEqual([null])
  })

  it('survives a preserved visit to another url of the same component', async () => {
    const app = await scenario(users, {
      '/users?filter=x': page('Users/Index', '/users?filter=x', {
        props: { users: [], errors: {} },
      }),
    })
    const swaps = await recordSwaps()

    app.router.visit('/users?filter=x', { preserveState: true })
    await settled()

    expect(swaps()).toEqual([{ component: { name: 'Users/Index' }, preserveState: true }])
  })

  it('changes when a preserved visit installs another component', async () => {
    const app = await open(users, {
      '/users/7': page('Users/Show', '/users/7'),
    })

    app.router.visit('/users/7', { preserveState: true })
    await settled()

    expect((await app.basePage()).component).toBe('Users/Show')
    expect(app.layers()).toEqual([])
  })

  it('never changes on a history restore', async () => {
    const app = await open()
    const [first] = app.layers()

    window.history.back()
    await settled()
    exitShells(app)
    await settled()
    expect(app.layers()).toEqual([])

    window.history.go(1)
    await settled()

    expect(app.layers()).toEqual([first])
    expect(ownersOf(app)).toEqual([null])
  })
})

describe('an open stack across a client visit', () => {
  it('leaves the stack behind when a client visit installs another page', async () => {
    const app = await open()

    app.router.push({
      component: 'Reports/Index',
      url: 'http://localhost/reports',
    })
    await settled()

    expect((await app.basePage()).component).toBe('Reports/Index')
    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('leaves the stack behind when a client visit pushes another state of the same component', async () => {
    const app = await open()

    app.router.push({
      url: 'http://localhost/users/2',
      props: { users: [{ id: 2 }] },
    })
    await settled()

    expect(app.layers()).toEqual([])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('keeps the stack when a client visit only rewrites the page beneath it', async () => {
    const app = await open()

    app.router.replace({ url: 'http://localhost/users?page=2' })
    await settled()

    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
  })

  it('keeps the stack when a prop helper rewrites the page beneath it', async () => {
    const app = await open()

    app.router.replace({ props: { users: [{ id: 1 }] } })
    await settled()

    expect((await app.basePage()).props).toEqual({ users: [{ id: 1 }] })
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
  })
})
