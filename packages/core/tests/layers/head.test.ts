import { afterEach, describe, expect, it, vi } from 'vitest'
import createHeadManager, { resolveServerHead } from '../../src/head'
import { planBoot } from '../../src/layers/entry'
import type { Page } from '../../src/types'
import { page, settled, start } from './support/f-support'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createHeadManager', () => {
  describe('server head', () => {
    const response = (props: Page['props'] = {}) => ({
      component: 'Users/Edit',
      props: { errors: {}, ...props },
      url: '/users/5/edit',
      version: null,
      rescuedProps: [],
      flash: {},
      rememberedState: {},
      layer: { key: 'Users/Edit', base: '/users' },
    })

    const cold = (props: Page['props'] = {}) => planBoot(response(props) as Page, '')

    it('resolves a cold layer server head from the top layer when the base is blank', () => {
      const plan = cold({ head: ['<title>Layer</title>'] })

      expect(plan.base.component).toBe('')
      expect(resolveServerHead(plan.top, (p) => p.props.head as string[])).toEqual([
        '<title data-inertia="server-head-0">Layer</title>',
      ])
    })

    it('resolves a cold layer server head from a named prop on the top layer', () => {
      expect(
        resolveServerHead(cold({ metaTags: ['<meta name="description" content="Layer">'] }).top, 'metaTags'),
      ).toEqual(['<meta data-inertia="server-head-0" name="description" content="Layer">'])
    })

    it('resolves a warm layer server head from the top layer, not the base beneath it', async () => {
      const base = page('Users/Index', '/users', {
        props: { errors: {}, head: ['<title>Base</title>'] },
      })
      const layer = page('Users/Edit', '/users/5/edit', {
        layer: { key: 'Users/Edit', base: '/users' },
        props: { errors: {}, head: ['<title>Layer</title>'] },
      })
      const app = await start(base, { '/users/5/edit': layer })

      app.router.layer('/users/5/edit')
      await settled()

      expect(resolveServerHead(app.topPage()!, true)).toEqual(['<title data-inertia="server-head-0">Layer</title>'])
      expect(resolveServerHead(app.basePage(), true)).toEqual(['<title data-inertia="server-head-0">Base</title>'])
    })

    it('returns no head for a cold layer that carries none', () => {
      expect(resolveServerHead(cold().top, true)).toEqual([])
      expect(resolveServerHead(cold().top, (p) => p.props.head as string[])).toEqual([])
    })
  })

  describe('stack order', () => {
    const managed = (initialServerHead: string[] = []) => {
      const collected: string[][] = []
      const manager = createHeadManager(
        true,
        (title) => title,
        (elements) => collected.push(elements),
        initialServerHead,
      )

      return { manager, last: () => collected[collected.length - 1] }
    }

    const rankIn = (stack: () => string[], id: string) => () => stack().indexOf(id) + 1

    it('orders the page beneath the layers, the layers by their index, and keeps only the top title', () => {
      const { manager, last } = managed()
      const stack = () => ['layer-1', 'layer-2']

      const firstBase = manager.createProvider()
      const layerOne = manager.createProvider(rankIn(stack, 'layer-1'))
      const layerTwo = manager.createProvider(rankIn(stack, 'layer-2'))
      const secondBase = manager.createProvider()

      firstBase.update(['<meta data-inertia="first-base" content="first">'])
      secondBase.update(['<meta data-inertia="second-base" content="second">'])
      layerOne.update(['<title data-inertia="">Layer One</title>', '<meta data-inertia="one" content="1">'])
      layerTwo.update(['<title data-inertia="">Layer Two</title>'])

      expect(last()).toEqual([
        '<meta data-inertia="first-base" content="first">',
        '<meta data-inertia="second-base" content="second">',
        '<title data-inertia="">Layer Two</title>',
        '<meta data-inertia="one" content="1">',
      ])
    })

    it("keeps the top layer's title when another layer is inserted beneath it", () => {
      const { manager, last } = managed()
      let stack = ['outer']

      const outer = manager.createProvider(rankIn(() => stack, 'outer'))
      outer.update(['<title data-inertia="">Outer</title>'])

      stack = ['inner', 'outer']
      const inner = manager.createProvider(rankIn(() => stack, 'inner'))
      inner.update(['<title data-inertia="">Inner</title>'])

      expect(last()).toEqual(['<title data-inertia="">Outer</title>'])
    })

    it("keeps a layer's title winning over the page's when its provider disconnects and reconnects", () => {
      const { manager, last } = managed()
      const stack = () => ['layer-1']

      const layerOne = manager.createProvider(rankIn(stack, 'layer-1'))
      const base = manager.createProvider()

      layerOne.update(['<title data-inertia="">Layer</title>'])
      base.update(['<title data-inertia="">Base</title>'])

      layerOne.disconnect()
      layerOne.reconnect()
      layerOne.update(['<title data-inertia="">Layer</title>'])

      expect(last()).toEqual(['<title data-inertia="">Layer</title>'])
    })

    it('keeps the server head first', () => {
      const { manager, last } = managed(['<title data-inertia="server-head-0">Server Head</title>'])
      const layerOne = manager.createProvider(rankIn(() => ['layer-1'], 'layer-1'))

      layerOne.update(['<meta data-inertia="one" content="1">'])

      expect(last()).toEqual([
        '<title data-inertia="server-head-0">Server Head</title>',
        '<meta data-inertia="one" content="1">',
      ])
    })
  })
})
