import { describe, expect, it } from 'vitest'
import { page, scenario, settled } from './a-support'
import { bench, byPath, gate } from './e-support'

const users = (url = '/users') => page('Users/Index', url, { props: { errors: {}, users: [] } })
const edit = (base: string) =>
  page('Users/Edit', '/users/5/edit', { layer: { key: 'Users/Edit', base }, props: { errors: {}, user: { id: 5 } } })

describe('a layer that declares its own url as its base, landing in session', () => {
  it('lands as an ordinary page and sends for no base', async () => {
    const app = await scenario(page('Auth/Login', '/login'), { '/users/5': edit('/users/5/edit') })

    app.router.visit('/users/5')
    await settled()

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(app.layers()).toEqual([])
    expect(app.sent()).toEqual(['get /users/5'])
    expect(app.written().at(-1)).toEqual(['push', '/users/5/edit'])
  })
})

describe('the entry a page commit writes while a stack is open', () => {
  it('pushes the page a navigation lands when it drops a layer that owned the address', async () => {
    const app = await scenario(users(), { '/users/5/edit': edit('/users'), '/users': users() })

    app.router.visit('/users/5/edit')
    await settled()

    const before = app.written().length

    app.router.visit('/users')
    await settled()

    expect(app.layers()).toEqual([])
    expect(app.written().slice(before)).toEqual([['push', '/users']])
  })

  it('rewrites the entry when a navigation to the very same page drops a layer that owned no address', async () => {
    const app = await scenario(users(), { '/users': users() })

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.entry().layers).toHaveLength(1)

    const before = app.written().length

    app.router.visit('/users')
    await settled()

    expect(app.layers()).toEqual([])
    expect(app.written().slice(before)).toEqual([['replace', '/users']])
    expect(app.entry()).not.toHaveProperty('layers')
  })

  it('charges the top layer for the entry a refresh pushes beneath a stack that owns no address', async () => {
    const app = await scenario(users(), { '/users?page=2': users('/users?page=2') })

    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.entry().layers!.map((layer) => layer.entries)).toEqual([1])

    app.router.visit('/users?page=2', { only: ['users'], preserveState: true, preserveScroll: true })
    await settled()

    expect(app.written().at(-1)).toEqual(['push', '/users?page=2'])
    expect(app.entry().layers!.map((layer) => layer.entries)).toEqual([2])
  })
})

describe('a partial reload answered while nothing is open', () => {
  it('keeps a layer that opened before the answer was committed', async () => {
    const resolving = gate()
    let held = false
    const app = await bench(users(), byPath({ '/users?page=2': users('/users?page=2') }), {
      resolve: (name) => (held && name === 'Users/Index' ? resolving.opened.then(() => ({ name })) : { name }),
    })

    held = true
    app.router.visit('/users?page=2', { only: ['users'], preserveState: true, preserveScroll: true })
    await settled()
    app.router.layer({ component: 'Prompt' })
    await settled()

    expect(app.layers().map((layer) => layer.type)).toEqual(['local'])

    resolving.open()
    await settled()

    expect((await app.basePage()).url).toBe('/users?page=2')
    expect(app.layers().map((layer) => layer.type)).toEqual(['local'])
  })
})
