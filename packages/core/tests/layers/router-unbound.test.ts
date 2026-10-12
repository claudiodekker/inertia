import { afterEach, describe, expect, it, vi, beforeAll } from 'vitest'
import { page, settled, start } from './support/f-support'

const usersIndex = page('Users/Index', '/users', {
  props: { errors: {}, users: [] },
})

afterEach(() => {
  vi.restoreAllMocks()
})

vi.hoisted(() => {
  const state: { current: unknown } = { current: {} }

  globalThis.window = {
    location: new URL('http://localhost/users'),
    history: {
      get state() {
        return state.current
      },
      pushState: (next: unknown) => void (state.current = next),
      replaceState: (next: unknown) => void (state.current = next),
    },
    navigator: { userAgent: 'node' },
    addEventListener: () => {},
    scrollTo: () => {},
  } as unknown as Window & typeof globalThis
})

describe('methods that never read `this` before layers', () => {
  it('still work unbound, and address the base', async () => {
    const edit = page('Users/Edit', '/users/5/edit', {
      layer: { key: 'Users/Edit', base: '/users' },
    })
    const app = await start(usersIndex, { '/users/5/edit': edit })
    const handle = app.router.layer('/users/5/edit')

    await settled()

    const { remember, restore, flash } = app.router.layerHandle(handle.id)!.router

    expect(() => remember({ note: 'x' }, 'note')).not.toThrow()
    expect(restore('note')).toEqual({ note: 'x' })
    expect(() => flash('message', 'Saved.')).not.toThrow()
    expect(app.basePage().flash).toEqual({ message: 'Saved.' })
    expect(app.basePage().rememberedState).toEqual({ note: { note: 'x' } })
    expect(app.views()[0].page.flash).toEqual({})
    expect(app.views()[0].page.rememberedState).toEqual({})
  })
})

describe('router members that never used `this` in 3.x', () => {
  let router: typeof import('../../src').router

  beforeAll(async () => {
    const core = await import('../../src')
    const { page } = await import('../../src/page')

    router = core.router

    await page.init({
      initialPage: {
        component: 'Users/Index',
        props: { errors: {} },
        url: '/users',
        version: null,
        rescuedProps: [],
        flash: {},
        rememberedState: {},
      },
      resolveComponent: async () => ({}),
      swapComponent: async () => {},
    })
  })

  it('restores what remember stored when both are destructured off the router', () => {
    const { restore, remember } = router

    remember({ draft: 'hello' }, 'form')

    expect(restore('form')).toEqual({ draft: 'hello' })
  })

  it('resolves a component when destructured off the router', async () => {
    const { resolveComponent } = router

    await expect(resolveComponent('Users/Index')).resolves.toEqual({})
  })
})
