import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, settled, start, type App } from './f-support'

const users = page('Users/Index', '/users', { props: { errors: {}, users: [] } })
const edit = page('Users/Edit', '/users/5/edit', {
  layer: { key: 'Users/Edit', base: '/users' },
  props: { errors: {}, user: { id: 5 } },
})
const notes = page('Users/Notes', '/users/5/notes', {
  layer: { key: 'Users/Notes', base: '/users' },
  props: { errors: {} },
})

const walkOnto = async (app: App, address: string) => {
  window.location.href = address
  app.popstate(null)
  await settled()
  await app.history.processQueue()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the history entry a layer open leaves behind', () => {
  it('gives the count back when the browser refuses the entry', async () => {
    const app = await start(users, { '/users/5/edit': edit })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusal = new Error('Attempt to use history.pushState() more than 100 times per 10 seconds')

    refusal.name = 'SecurityError'
    vi.spyOn(window.history, 'pushState').mockImplementation(() => {
      throw refusal
    })

    const handle = app.router.layer('/users/5/edit')

    await settled()

    vi.mocked(window.history.pushState).mockRestore()
    app.router.layerHandle(handle.id)!.router.remember({ note: 'x' }, 'note')
    await settled()

    expect(error).toHaveBeenCalledWith(refusal.message)
    expect(app.entry().layers![0].entries).toBe(0)
  })
})

describe('a hash the browser wrote', () => {
  it('writes it onto the layer that owns the address, leaving the base beneath it alone', async () => {
    const app = await start(users, { '/users/5/edit': edit })

    app.router.layer('/users/5/edit')
    await settled()

    const before = app.written().length

    await walkOnto(app, 'http://localhost/users/5/edit#comments')

    expect(app.written().slice(before)).toEqual([['replace', 'http://localhost/users/5/edit#comments']])
    expect(app.entry()).toMatchObject({ url: '/users', layers: [{ url: 'http://localhost/users/5/edit#comments' }] })
  })

  it('writes it onto the layer beneath one with no url of its own', async () => {
    const app = await start(users, { '/users/5/edit': edit, '/users/5/notes': notes })

    app.router.layer('/users/5/edit')
    await settled()
    app.router.layer('/users/5/notes', { preserveUrl: true })
    await settled()

    const before = app.written().length

    await walkOnto(app, 'http://localhost/users/5/edit#comments')

    expect(app.written().slice(before)).toEqual([['replace', 'http://localhost/users/5/edit#comments']])
    expect(app.entry()).toMatchObject({
      url: '/users',
      layers: [{ url: 'http://localhost/users/5/edit#comments' }, { url: '/users/5/notes' }],
    })
  })
})
