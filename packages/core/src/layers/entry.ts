// The single history entry. Pure, SSR-safe. One entry holds the whole composite: the 3.x base page
// shape plus `layers`. With no layer composed, `compose` returns the base page itself, so a layerless
// entry is byte-identical to 3.x.

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

export function compose(base: Page, layers: readonly LayerEntry[]): { data: CompositeEntry; url: string } {
  if (layers.length === 0) {
    return { data: base, url: base.url }
  }

  return { data: { ...base, layers: [...layers] }, url: addressOf(base, layers) }
}

/** The topmost routed layer that moved the address, else the base. */
export function addressOf(base: Page, layers: readonly LayerEntry[]): string {
  const owner = [...layers].reverse().find((layer) => layer.type === 'routed' && !layer.preservesUrl)

  return owner ? owner.url : base.url
}
