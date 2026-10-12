import { describe, expect, it } from 'vitest'
import { bootId, planBoot } from '../../src/layers/entry'
import type { Page } from '../../src/types'
import { asPage, edit, held, layerAtBase, users } from './support/layers-fixtures'
import { page, ported, settled } from './support/support'

const usersPage = () => page('Users/Index', '/users', { props: { errors: {}, users: [] } })

const layer = (name: string, url: string) => page(name, url, { layer: { key: name, base: '/users' } })

describe('resolveInitialPage', () => {
  it('renders a layer whose base is its own url as an ordinary page', async () => {
    const own = page('Users/Edit', '/users/5/edit', {
      props: { errors: {} },
      layer: { key: 'Users/Edit', base: '/users/5/edit' },
    })
    const app = await ported(own, { '/users/5/edit': own }, { boot: true })

    await settled()

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(app.layers()).toEqual([])
    expect(app.sent).toEqual([])
  })
})

describe('loadingBase', () => {
  it('is undefined for a blank with no url at all', async () => {
    const seen: unknown[] = []
    const app = await ported(
      usersPage(),
      {},
      {
        loading: (url) => {
          seen.push(url)

          return { name: 'Loading' }
        },
      },
    )

    expect(await app.resolve('', { ...page('', ''), url: '' })).toEqual({
      name: 'Blank',
    })
    expect(seen).toEqual([])
  })
})

describe('resolveInitialPage', () => {
  const layerAt = (url: string, component: string, base?: string) =>
    page(component, url, { props: { errors: {} }, layer: { key: component, base } })

  it('leaves a response that is not a layer exactly as it arrived', async () => {
    const response = asPage(users)

    expect(planBoot(response, '').base).toBe(response)
    expect(planBoot(response, '').layers).toEqual([])

    const app = await ported(users, {}, { boot: true })

    expect(await app.basePage()).toMatchObject({ component: 'Users/Index', url: '/users' })
    expect(app.swaps.map((swap) => swap.component)).toEqual([{ name: 'Users/Index' }])
    expect(app.layers()).toEqual([])
  })

  it('opens a layer loaded cold over a base that has not arrived yet', async () => {
    const hop = held(users)
    const app = await ported(layerAt('/users/5/edit', 'Users/Edit', '/users'), { '/users': hop.route }, { boot: true })

    expect((await app.basePage()).component).toBe('')
    expect((await app.basePage()).url).toBe('/users')
    expect(app.swaps.map((swap) => swap.component)).toEqual([{ name: 'Blank' }])
    expect(app.layers()).toEqual([
      { id: bootId('/users/5/edit'), key: 'Users/Edit', component: 'Users/Edit', url: '/users/5/edit', type: 'routed' },
    ])
    expect(app.views()[0].component).toEqual({ name: 'Users/Edit' })
  })

  it('renders a layer that declares no base as an ordinary page', async () => {
    const app = await ported(layerAt('/users/5/edit', 'Users/Edit'), {}, { boot: true })

    expect((await app.basePage()).component).toBe('Users/Edit')
    expect(await app.basePage()).not.toHaveProperty('layer')
    expect(app.swaps.map((swap) => swap.component)).toEqual([{ name: 'Users/Edit' }])
    expect(app.layers()).toEqual([])
  })

  it('does not touch the response it was given', () => {
    const response = asPage(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    const copy = structuredClone(response)

    planBoot(response, '#profile')

    expect(response).toEqual(copy)
  })

  it("puts the browser's hash on the layer that owns the address", async () => {
    const app = await ported(
      layerAt('/users/5/edit', 'Users/Edit', '/users'),
      { '/users': held(users).route },
      {
        boot: true,
        href: 'http://localhost/users/5/edit#profile',
      },
    )

    expect(app.layers()[0].url).toBe('/users/5/edit#profile')
    expect((await app.basePage()).url).toBe('/users')
  })

  it('does not append the hash to a url that already carries it', async () => {
    const app = await ported(
      layerAt('/users/5/edit#profile', 'Users/Edit', '/users'),
      { '/users': held(users).route },
      {
        boot: true,
        href: 'http://localhost/users/5/edit#profile',
      },
    )

    expect(app.layers()[0].url).toBe('/users/5/edit#profile')
  })

  it('resolves the base a cold open is missing through the loading resolver', async () => {
    const seen: unknown[] = []
    const app = await ported(
      layerAt('/users/5/edit', 'Users/Edit', '/users'),
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url, context) => {
          seen.push([url, context])

          return { name: 'Loading' }
        },
      },
    )

    expect(app.swaps[0].component).toEqual({ name: 'Loading' })
    expect(seen).toEqual([
      [
        '/users',
        {
          layers: [
            {
              id: bootId('/users/5/edit'),
              key: 'Users/Edit',
              component: 'Users/Edit',
              url: '/users/5/edit',
              type: 'routed',
            },
          ],
        },
      ],
    ])
    expect(app.layers().map((layer) => layer.key)).toEqual(['Users/Edit'])
  })

  it('never calls the loading resolver for an ordinary page', async () => {
    const app = await ported(
      users,
      {},
      {
        boot: true,
        loading: () => {
          throw new Error('consulted')
        },
      },
    )

    expect(app.swaps[0].component).toEqual({ name: 'Users/Index' })
  })
})

describe('loadingBase', () => {
  const cold = layerAtBase('/users/5/edit', 'Users/Edit', '/users')

  it('is the base the blank page is waiting on', async () => {
    const seen: unknown[] = []
    await ported(
      cold,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url) => void seen.push(url),
      },
    )

    expect(seen).toEqual(['/users'])
  })

  it("is the blank page's own url once the layer above it has gone", async () => {
    const seen: unknown[] = []
    const app = await ported(
      cold,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url, context) => void seen.push([url, context.layers.length]),
      },
    )

    seen.length = 0
    void app.router.close()
    await settled()
    app.exitShells()
    await settled()
    await app.resolve('', asPage(page('', '/users')))

    expect(app.layers()).toEqual([])
    expect(seen).toEqual([['/users', 0]])
  })

  it('is undefined for a page that has a component', async () => {
    const seen: unknown[] = []
    const app = await ported(users, {}, { boot: true, loading: (url) => void seen.push(url) })

    await app.resolve('Users/Index', asPage(users))

    expect(seen).toEqual([])
  })
})

describe('normalizeLoading', () => {
  const blank = { render: () => null }
  const resolver = async (
    loading: ((url: string, context: { layers: readonly unknown[] }) => unknown) | undefined,
    resolve: (name: string) => unknown = (name) => ({ name }),
  ) => {
    const { layerSlot } = await import('../../../src')

    return layerSlot.wrapResolver(resolve as never, loading as never, blank as never) as (
      name: string,
      page?: Page,
    ) => Promise<unknown>
  }
  const blankPage = asPage(page('', '/users'))

  it('resolves the blank when no option was given', async () => {
    await expect((await resolver(undefined))('', blankPage)).resolves.toBe(blank)
  })

  it('resolves a component as itself', async () => {
    const component = { render: () => null }

    await expect((await resolver(() => component))('', blankPage)).resolves.toBe(component)
  })

  it('resolves a module to the component it carries', async () => {
    const component = { render: () => null }

    await expect((await resolver(() => ({ default: component })))('', blankPage)).resolves.toBe(component)
  })

  it('hands a resolver the url and the page, and resolves what it returns', async () => {
    const component = { render: () => null }
    const seen: unknown[] = []
    const resolve = await resolver((url, context) => {
      seen.push(url, context)

      return component
    })

    await expect(resolve('', blankPage)).resolves.toBe(component)
    expect(seen).toEqual(['/users', { layers: [] }])
  })

  it('unwraps the module a resolver imports', async () => {
    const component = { render: () => null }

    await expect((await resolver(() => Promise.resolve({ default: component })))('', blankPage)).resolves.toBe(
      component,
    )
  })

  it('resolves the blank when the resolver declines', async () => {
    await expect((await resolver(() => undefined))('', blankPage)).resolves.toBe(blank)
  })

  it('resolves a component that throws when called as itself', async () => {
    const component = () => {
      throw new Error('not a resolver')
    }

    await expect((await resolver(() => component))('', blankPage)).resolves.toBe(component)
  })

  it('resolves a component whose call the rendered check recognises as itself', async () => {
    const component = () => ({ vnode: true })

    await expect((await resolver(() => component))('', blankPage)).resolves.toBe(component)
  })
})

describe('resolving a blank base through the page', () => {
  const coldEdit = layerAtBase('/users/5/edit', 'Users/Edit', '/users')

  it('resolves the placeholder for the base the blank is missing', async () => {
    const app = await ported(
      coldEdit,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url, { layers }) => ({ name: `loading:${url}:${layers.length}` }),
      },
    )

    await expect(app.resolve('', asPage(page('', '/users')))).resolves.toEqual({ name: 'loading:/users:1' })
  })

  it('resolves the placeholder for a blank page whose layer was dismissed', async () => {
    const app = await ported(
      coldEdit,
      { '/users': held(users).route },
      {
        boot: true,
        loading: (url) => ({ name: `loading:${url}` }),
      },
    )

    void app.router.close()
    await settled()
    app.exitShells()
    await settled()

    await expect(app.resolve('', asPage(page('', '/users')))).resolves.toEqual({ name: 'loading:/users' })
  })

  it('resolves nothing without a loading resolver', async () => {
    const app = await ported(coldEdit, { '/users': held(users).route }, { boot: true })

    await expect(app.resolve('', asPage(page('', '/users')))).resolves.toEqual({ name: 'Blank' })
  })

  it('never sends a blank page to the ordinary resolver', async () => {
    const named: string[] = []
    const app = await ported(
      coldEdit,
      { '/users': held(users).route },
      {
        boot: true,
        resolveComponent: (name) => {
          named.push(name)

          return { name }
        },
      },
    )

    named.length = 0
    await app.resolve('', asPage(page('', '/users')))

    expect(named).toEqual([])
  })
})
