import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  globalThis.window = {
    location: new URL('http://localhost/layers/panel/first#notes'),
    history: { state: null, pushState: () => {}, replaceState: () => {} },
    navigator: { userAgent: 'node' },
    addEventListener: () => {},
    scrollTo: () => {},
  } as unknown as Window & typeof globalThis

  globalThis.document = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    querySelectorAll: () => [],
    visibilityState: 'visible',
  } as unknown as Document
})

const response = {
  component: 'Layers/Panel',
  props: { errors: {}, name: 'first' },
  url: '/layers/panel/first',
  version: 'v1',
  flash: {},
  rescuedProps: [],
  layer: { key: 'panel:first', base: '/layers/base' },
}

const Panel = { name: 'Panel' }

describe('the client boot of a boot plan', () => {
  it('shows the seed before mount under the id the server rendered it with', async () => {
    const { layerSlot } = await import('../../src')

    layerSlot.boot(
      layerSlot.planBoot({ component: 'Base', props: { errors: {} }, url: '/', version: 'v1' } as never, ''),
      [],
    )
    expect(layerSlot.views()).toEqual([])

    layerSlot.boot(layerSlot.planBoot(response as never, '#notes'), [Panel])

    const views = layerSlot.views()

    expect(views.map((view) => [view.id, view.component, view.page.url, view.attributes])).toEqual([
      [
        'layer-boot-36rcm2',
        Panel,
        '/layers/panel/first#notes',
        { 'data-layer-id': 'layer-boot-36rcm2', style: { viewTransitionName: 'inertia-layer-layer-boot-36rcm2' } },
      ],
    ])
    expect(views[0].shell).toMatchObject({ open: true, index: 0, isTop: true, type: 'routed' })
    expect(layerSlot.info()).toEqual([
      {
        id: 'layer-boot-36rcm2',
        key: 'panel:first',
        component: 'Layers/Panel',
        url: '/layers/panel/first#notes',
        type: 'routed',
      },
    ])
    expect(layerSlot.topPage()?.url).toBe('/layers/panel/first#notes')
  })
})
