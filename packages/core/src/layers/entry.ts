// The single history entry. Pure, SSR-safe. One entry holds the whole composite: the 3.x base page
// shape plus `layers`. With no layer composed, `compose` returns the base page itself, so a layerless
// entry is byte-identical to 3.x. A blank base is never stored under layers: the deepest layer is
// stored as the base page, and a blank base with no layers is stored as the placeholder itself.

import type { Page } from '../types'

export type LayerEntry = Omit<Page, 'flash'> & {
  id: string
  key: string
  type: 'routed' | 'local'
  /** null = the base. */
  owner: string | null
  entries: number
  preservesUrl?: true
}

export type CompositeEntry = Page & { layers?: LayerEntry[] }

export function compose(
  base: Page,
  layers: readonly LayerEntry[],
  baseBlank: boolean,
): { data: CompositeEntry; url: string } {
  if (layers.length === 0) {
    return { data: base, url: base.url }
  }

  if (!baseBlank) {
    return { data: { ...base, layers: [...layers] }, url: addressOf(base, layers) }
  }

  const [deepest, ...rest] = layers
  const promoted: Page = { ...pageOf(deepest), flash: {} }
  const data: CompositeEntry = rest.length > 0 ? { ...promoted, layers: rest } : promoted

  return { data, url: addressOf(promoted, rest) }
}

/** The topmost routed layer that moved the address, else the base. */
export function addressOf(base: Page, layers: readonly LayerEntry[]): string {
  const owner = [...layers].reverse().find((layer) => layer.type === 'routed' && !layer.preservesUrl)

  return owner ? owner.url : base.url
}

/** The base view (the 3.x shape, no `layers` key) and the layer entries of a decrypted entry. */
export function decompose(entry: CompositeEntry): { base: Page; layers: readonly LayerEntry[] } {
  if (!entry.layers) {
    return { base: entry, layers: [] }
  }

  const { layers, ...base } = entry

  return { base, layers }
}

export function isBlank(page: Page): boolean {
  return page.component === ''
}

function pageOf(layer: LayerEntry): Omit<Page, 'flash'> {
  const {
    id: _id,
    key: _key,
    type: _type,
    owner: _owner,
    entries: _entries,
    preservesUrl: _preservesUrl,
    ...page
  } = layer

  return page
}
