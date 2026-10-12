import { describe, expect, it } from 'vitest'
import { page, ported, settled } from './support'

const users = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })
const layer = (name: string, url: string) => page(name, url, { layer: { key: name, base: '/users' } })

describe('withAddressHash', () => {
  it('writes it onto the topmost layer that has a url', async () => {
    const app = await ported(users(), { '/a': layer('A', '/a'), '/b': layer('B', '/b') })

    app.router.visit('/a')
    await settled()
    app.router.visit('/b')
    await settled()
    await app.anchor('/b#comments')

    expect(app.entry().layers!.map((entry) => entry.url)).toEqual(['/a', 'http://localhost/b#comments'])
    expect(app.entry().url).toBe('/users')
    expect(window.location.href).toBe('http://localhost/b#comments')
  })

  it('falls through a layer that has no url of its own', async () => {
    const app = await ported(users(), { '/a': layer('A', '/a') })

    app.router.visit('/a')
    await settled()
    app.router.layer({ component: 'Prompt' })
    await settled()
    await app.anchor('/a#comments')

    expect(app.entry().layers![0].url).toBe('http://localhost/a#comments')
    expect(app.entry().url).toBe('/users')
  })
})

describe('history entry counting', () => {
  it('counts the entry against the layer that owns the address', async () => {
    const app = await ported(users(), { '/a': layer('A', '/a') })

    app.router.visit('/a')
    await settled()
    await app.anchor('/a#top')

    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)

    expect(app.entry().layers![0].entries).toBe(2)

    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([-2])
  })

  it('gives the entry back when the browser refused to write it', async () => {
    const app = await ported(users(), { '/a': layer('A', '/a') })
    const reloads: string[] = []
    const pushState = window.history.pushState

    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get: () => 'http://localhost/users',
      set: (value: string) => void reloads.push(value),
    })
    window.history.pushState = () => {
      const error = new Error('quota')

      error.name = 'QuotaExceededError'
      throw error
    }

    app.router.visit('/a')
    await settled()
    window.history.pushState = pushState

    const deltas: number[] = []

    window.history.go = (delta: number) => void deltas.push(delta)
    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    expect(deltas).toEqual([])
  })
})
