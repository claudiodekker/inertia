import { describe, expect, it } from 'vitest'
import createHeadManager, { resolveServerHead } from '../src/head'
import { Page } from '../src/types'

const page = (props: Page['props'] = {}): Page => ({
  component: 'Users/Index',
  props: {
    errors: {},
    ...props,
  },
  url: '/users',
  version: null,
  rescuedProps: [],
  flash: {},
  rememberedState: {},
})

describe('createHeadManager', () => {
  describe('server head', () => {
    it('normalizes server head elements into Inertia managed elements', () => {
      expect(resolveServerHead(page(), () => ['<meta name="description" content="Users">'])).toEqual([
        '<meta data-inertia="server-head-0" name="description" content="Users">',
      ])
    })

    it('trims surrounding whitespace and drops empty entries', () => {
      expect(resolveServerHead(page(), () => ['  <meta name="description" content="Users">  ', '   ', ''])).toEqual([
        '<meta data-inertia="server-head-0" name="description" content="Users">',
      ])
    })

    it('can resolve server head elements from a page prop', () => {
      expect(resolveServerHead(page({ head: ['<title>Users</title>'] }), true)).toEqual([
        '<title data-inertia="server-head-0">Users</title>',
      ])
    })

    it('updates server head elements using a reserved provider', () => {
      const collected: string[][] = []

      const manager = createHeadManager(
        true,
        (title) => title,
        (elements) => collected.push(elements),
        ['<meta data-inertia="description" name="description" content="Users">'],
      )

      manager.updateServerHead(['<meta data-inertia="description" name="description" content="Organizations">'])

      expect(collected[collected.length - 1]).toEqual([
        '<meta data-inertia="description" name="description" content="Organizations">',
      ])

      manager.updateServerHead()

      expect(collected[collected.length - 1]).toEqual([])
    })

    it('allows page head elements to override server head elements with the same key', () => {
      const collected: string[][] = []

      const manager = createHeadManager(
        true,
        (title) => title,
        (elements) => collected.push(elements),
        ['<meta data-inertia="description" name="description" content="Default">'],
      )

      const provider = manager.createProvider()
      provider.update(['<meta data-inertia="description" name="description" content="Page-specific">'])

      expect(collected[collected.length - 1]).toEqual([
        '<meta data-inertia="description" name="description" content="Page-specific">',
      ])
    })

    it('deduplicates single-quoted data-inertia keys', () => {
      const collected: string[][] = []

      const manager = createHeadManager(
        true,
        (title) => title,
        (elements) => collected.push(elements),
        ["<meta data-inertia='description' name='description' content='Default'>"],
      )

      const provider = manager.createProvider()
      provider.update(["<meta data-inertia='description' name='description' content='Page-specific'>"])

      expect(collected[collected.length - 1]).toEqual([
        "<meta data-inertia='description' name='description' content='Page-specific'>",
      ])
    })
  })

  describe('SSR title escaping', () => {
    it('escapes HTML in the title element to prevent XSS injection via newline bypass', () => {
      const collected: string[][] = []

      const manager = createHeadManager(
        true,
        (title) => title,
        (elements) => collected.push(elements),
      )

      const provider = manager.createProvider()
      provider.update([`<title data-inertia="">Safe Title\n</title><script>alert('xss')</script></title>`])

      const head = collected[collected.length - 1].join('')

      expect(head).not.toContain('<script>alert(')
    })
  })
})

describe('createHeadManager provider order', () => {
  const setup = () => {
    const collected: string[][] = []
    const manager = createHeadManager(
      true,
      (title) => title,
      (elements) => collected.push(elements),
    )

    return { manager, last: () => collected[collected.length - 1] }
  }

  it('keeps provider creation order when no provider has a rank', () => {
    const { manager, last } = setup()
    const first = manager.createProvider()
    const second = manager.createProvider()
    const third = manager.createProvider()

    third.update(['<meta name="c">'])
    first.update(['<meta name="a">'])
    second.update(['<meta name="b">'])

    expect(last()).toEqual(['<meta name="a">', '<meta name="b">', '<meta name="c">'])
  })

  it('orders ranked providers by rank and leaves unranked ones at rank zero', () => {
    const { manager, last } = setup()
    const unranked = manager.createProvider()
    const high = manager.createProvider(() => 2)
    const low = manager.createProvider(() => 1)

    unranked.update(['<meta name="unranked">'])
    high.update(['<meta name="high">'])
    low.update(['<meta name="low">'])

    expect(last()).toEqual(['<meta name="unranked">', '<meta name="low">', '<meta name="high">'])
  })

  it('stops ranking a provider once it disconnects', () => {
    const { manager, last } = setup()
    const ranked = manager.createProvider(() => 5)
    const other = manager.createProvider()

    ranked.update(['<meta name="ranked">'])
    other.update(['<meta name="other">'])
    ranked.disconnect()

    expect(last()).toEqual(['<meta name="other">'])
  })

  it('keeps a provider ranked when it disconnects and reconnects', () => {
    const { manager, last } = setup()
    const ranked = manager.createProvider(() => 1)
    const base = manager.createProvider()

    ranked.update(['<meta name="ranked">'])
    ranked.disconnect()
    ranked.reconnect()
    ranked.update(['<meta name="ranked">'])
    base.update(['<meta name="base">'])

    expect(last()).toEqual(['<meta name="base">', '<meta name="ranked">'])
  })
})
