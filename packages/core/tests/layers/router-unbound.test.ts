import { beforeAll, describe, expect, it, vi } from 'vitest'

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
