import { describe, expect, it } from 'vitest'
import { addressOf, bootId, compose, decompose, isBlank, planBoot, type LayerEntry } from '../../src/layers/entry'
import type { Page } from '../../src/types'

const page = (component: string, url: string, props: object = {}): Page => ({
  component,
  url,
  props: { errors: {}, ...props },
  version: 'v1',
  flash: {},
  rescuedProps: [],
  clearHistory: false,
  encryptHistory: false,
  rememberedState: {},
})

const layer = (key: string, url: string, overrides: Partial<LayerEntry> = {}): LayerEntry => {
  const { flash: _flash, ...rest } = page(`Layers/${key}`, url)

  return { ...rest, id: `id-${key}`, key, type: 'routed', owner: null, entries: 1, ...overrides }
}

describe('compose', () => {
  it('returns the base page object itself when no layer is composed', () => {
    const base = page('Base', '/base')

    expect(compose(base, [], false).data).toBe(base)
    expect(compose(base, [], false).url).toBe('/base')
  })

  it('stores a blank base with no layers as the placeholder itself', () => {
    const blank = page('', '/base')

    expect(compose(blank, [], true)).toEqual({ data: blank, url: '/base' })
  })

  it('adds the layers to the base and takes the address of the top routed layer that moved it', () => {
    const base = page('Base', '/base')
    const a = layer('a', '/a')
    const b = layer('b', '/b', { preservesUrl: true })

    expect(compose(base, [a, b], false)).toEqual({ data: { ...base, layers: [a, b] }, url: '/a' })
  })

  it('never stores a blank base under layers: the deepest layer is stored as the base page', () => {
    const blank = page('', '/base')
    const deepest = layer('inner', '/inner')
    const top = layer('outer', '/outer')

    expect(compose(blank, [deepest, top], true)).toEqual({
      data: { ...page('Layers/inner', '/inner'), layers: [top] },
      url: '/outer',
    })
    expect(compose(blank, [deepest], true)).toEqual({ data: page('Layers/inner', '/inner'), url: '/inner' })
  })
})

describe('addressOf', () => {
  it('skips local layers and preserveUrl layers', () => {
    const base = page('Base', '/base')

    expect(addressOf(base, [layer('a', '/a'), layer('l', '', { type: 'local' })])).toBe('/a')
    expect(addressOf(base, [layer('l', '', { type: 'local' }), layer('p', '/p', { preservesUrl: true })])).toBe('/base')
  })
})

describe('decompose', () => {
  it('returns a plain entry itself with no layers', () => {
    const base = page('Base', '/base')

    expect(decompose(base).base).toBe(base)
    expect(decompose(base).layers).toEqual([])
  })

  it('splits a composite into the 3.x base view and its layers', () => {
    const base = page('Base', '/base')
    const a = layer('a', '/a')
    const split = decompose({ ...base, layers: [a] })

    expect(split).toEqual({ base, layers: [a] })
    expect('layers' in split.base).toBe(false)
  })
})

describe('isBlank', () => {
  it('is true only for the placeholder component', () => {
    expect(isBlank(page('', '/base'))).toBe(true)
    expect(isBlank(page('Base', '/base'))).toBe(false)
  })
})

describe('planBoot', () => {
  const marked = (layer: object) => ({ ...page('Layers/Panel', '/layers/panel/first', { name: 'first' }), layer })

  it('returns the response object itself as the base when it carries no layer mark', () => {
    const response = page('Base', '/base')
    const plan = planBoot(response, '#top')

    expect(plan.base).toBe(response)
    expect(plan.top).toBe(response)
    expect(plan).toMatchObject({ layers: [], declaredBase: null, info: [] })
  })

  it('renders a mark that declares no base as a plain page, the mark stripped', () => {
    const plan = planBoot(marked({ key: 'promote' }), '')

    expect(plan.base).toEqual(page('Layers/Panel', '/layers/panel/first', { name: 'first' }))
    expect('layer' in plan.base).toBe(false)
    expect(plan.layers).toEqual([])
    expect(plan.declaredBase).toBeNull()
  })

  it.each(['/layers/panel/first', 'https://app.test/layers/panel/first', '/layers/panel/first#notes'])(
    'renders a mark whose base is its own url (%s) as a plain page',
    (base) => {
      const plan = planBoot(marked({ key: 'own', base }), '')

      expect(plan.base).toEqual(page('Layers/Panel', '/layers/panel/first', { name: 'first' }))
      expect(plan).toMatchObject({ layers: [], declaredBase: null, info: [] })
    },
  )

  it('gives a seed the empty flash and rescued props 3.x gives an initial page that names none', () => {
    const { component, props, url, version } = page('Layers/Panel', '/layers/panel/first')
    const plan = planBoot(
      { component, props, url, version, layer: { key: 'panel', base: '/layers/base' } } as never,
      '',
    )

    expect(plan.layers[0].page).toMatchObject({ flash: {}, rescuedProps: [] })
  })

  it('walks for a base that differs from its own url only in the query', () => {
    expect(planBoot(marked({ key: 'own', base: '/layers/panel/first?tab=2' }), '').declaredBase).toBe(
      '/layers/panel/first?tab=2',
    )
  })

  it('puts a declared base under a blank placeholder that carries the layer version, and seeds the layer', () => {
    const plan = planBoot({ ...marked({ key: 'panel:first', base: '/layers/base' }), version: 'v7' }, '#notes')

    expect(plan.base).toEqual({
      component: '',
      props: { errors: {} },
      url: '/layers/base',
      version: 'v7',
      encryptHistory: false,
      flash: {},
      rescuedProps: [],
      rememberedState: {},
    })
    expect(plan.declaredBase).toBe('/layers/base')
    expect(plan.layers).toEqual([
      {
        row: {
          id: 'layer-boot-36rcm2',
          type: 'routed',
          key: 'panel:first',
          owner: 'base',
          standalone: true,
          ownsAddress: true,
          entries: 0,
        },
        page: { ...page('Layers/Panel', '/layers/panel/first#notes', { name: 'first' }), version: 'v7' },
      },
    ])
    expect(plan.top).toBe(plan.layers[0].page)
    expect(plan.info).toEqual([
      {
        id: 'layer-boot-36rcm2',
        key: 'panel:first',
        component: 'Layers/Panel',
        url: '/layers/panel/first#notes',
        type: 'routed',
      },
    ])
  })

  it('keys a layer with no key of its own by its component', () => {
    expect(planBoot(marked({ base: '/layers/base' }), '').layers[0].row.key).toBe('Layers/Panel')
  })

  it('gives the server (no hash) and the client (with its hash) the same layer id for one document', () => {
    const response = marked({ key: 'panel:first', base: '/layers/base' })
    const server = planBoot(response, '')
    const client = planBoot(response, '#section')

    expect(server.layers.map((layer) => layer.row.id)).toEqual(['layer-boot-36rcm2'])
    expect(client.layers.map((layer) => layer.row.id)).toEqual(['layer-boot-36rcm2'])
    expect(server.layers[0].page.url).toBe('/layers/panel/first')
    expect(client.layers[0].page.url).toBe('/layers/panel/first#section')
  })
})

describe('bootId', () => {
  it('is a djb2 hash of the url without its hash, in base 36', () => {
    expect(bootId('/layers/panel/first')).toBe('layer-boot-36rcm2')
    expect(bootId('/layers/panel/first#anything')).toBe('layer-boot-36rcm2')
    expect(bootId('/layers/panel/second')).toBe('layer-boot-16hpofi')
  })
})
