import { describe, expect, it } from 'vitest'
import { layerSlot, type Page } from '../../src'

const response = {
  component: 'Layers/Panel',
  props: { errors: {}, name: 'first' },
  url: '/layers/panel/first',
  version: 'v1',
  flash: {},
  rescuedProps: [],
  layer: { key: 'panel:first', base: '/layers/base' },
} as Page

const Panel = { name: 'Panel' }

describe('the server render of a boot plan', () => {
  it('renders the layer the document arrived with as an open top view under the id the client boots with', () => {
    const plan = layerSlot.planBoot(response, '')
    const views = layerSlot.ssrViews(plan, [Panel])

    expect(views.map((view) => [view.id, view.component, view.page.url, view.attributes])).toEqual([
      [
        'layer-boot-36rcm2',
        Panel,
        '/layers/panel/first',
        { 'data-layer-id': 'layer-boot-36rcm2', style: { viewTransitionName: 'inertia-layer-layer-boot-36rcm2' } },
      ],
    ])
    expect(views[0].shell).toMatchObject({ open: true, index: 0, isTop: true, type: 'routed' })
    expect([views[0].scope.key, views[0].scope.index]).toEqual(['panel:first', 0])
  })

  it('keeps no layer state of its own between renders', () => {
    layerSlot.ssrViews(layerSlot.planBoot(response, ''), [Panel])

    expect(layerSlot.views()).toEqual([])
    expect(layerSlot.topPage()).toBeNull()
  })
})

describe('wrapResolver', () => {
  const Blank = { name: 'Blank' }
  const Loading = { name: 'Loading' }
  const blankPage = { component: '', url: '/layers/base' } as Page

  it('hands every named component to the user resolver and never the blank base', async () => {
    const asked: string[] = []
    const resolve = layerSlot.wrapResolver(
      (name: string) => {
        asked.push(name)

        return { name }
      },
      undefined,
      Blank,
    )

    expect(await resolve('Users/Index')).toEqual({ name: 'Users/Index' })
    expect(await resolve('', blankPage)).toBe(Blank)
    expect(asked).toEqual(['Users/Index'])
  })

  it('asks the loading resolver for the blank base with its url and the layers, unwrapping a module', async () => {
    const calls: unknown[] = []
    const layers = [{ id: 'a', key: 'panel', component: 'Layers/Panel', url: '/layers/panel', type: 'routed' as const }]
    const resolve = layerSlot.wrapResolver<object>(
      (name) => ({ name }),
      (url, context) => {
        calls.push([url, context.layers])

        return { default: Loading }
      },
      Blank,
    )

    expect(await resolve('', blankPage, layers)).toBe(Loading)
    expect(calls).toEqual([['/layers/base', layers]])
  })

  it('falls back to the blank component when the loading resolver has nothing for the url', async () => {
    const resolve = layerSlot.wrapResolver<object>(
      (name) => ({ name }),
      async () => undefined,
      Blank,
    )

    expect(await resolve('', blankPage, [])).toBe(Blank)
  })
})
