import type { LayerEntry } from '../../../src/layers/entry'
import type { Page } from '../../../src/types'
import { page, type Answer } from './browser'

export const base = (extra: Partial<Page> = {}): Answer =>
  page('Users/Index', '/users', { props: { users: [], errors: {} }, ...extra })

export const notes = (extra: Answer = {}): Answer =>
  page('Users/Notes', '/users/5/notes', {
    layer: { key: 'Users/Notes', base: '/users' },
    props: { errors: {} },
    ...extra,
  })

export const layerAt = (component: string, url: string, extra: Answer = {}) =>
  page(component, url, { layer: { key: component, base: '/users' }, props: { errors: {} }, ...extra })

export const users = page('Users/Index', '/users', { props: { errors: {}, users: [] } })
export const dashboard = page('Dashboard', '/dashboard', { props: { errors: {}, stats: 3 } })

export const edit = (extra: Answer = {}) =>
  page('Users/Edit', '/users/5/edit', {
    props: { errors: {}, user: { id: 5 } },
    layer: { key: 'Users/Edit', base: '/users' },
    ...extra,
  })

export const teams = page('Teams/Show', '/teams/1', { layer: { key: 'Teams/Show', base: '/users' } })

export const heldRoute = (answer: Answer) => {
  let release!: () => void

  return {
    route: () => new Promise<Answer>((resolve) => (release = () => resolve(answer))),
    release: () => release(),
  }
}

export const asPage = (answer: Answer) => answer as unknown as Page

export const layerEntry = (key: string, url: string, overrides: Partial<LayerEntry> = {}): LayerEntry => ({
  component: `Layers/${key}`,
  props: { errors: {} },
  url,
  version: 'v1',
  rescuedProps: [],
  rememberedState: {},
  id: `id-${key}`,
  key,
  type: 'routed',
  owner: null,
  entries: 1,
  ...overrides,
})

export function layerAtBase(url: string, component: string, base?: string) {
  return page(component, url, { props: { errors: {} }, layer: { key: component, base } })
}
