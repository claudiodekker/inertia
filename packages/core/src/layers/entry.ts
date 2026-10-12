// The single history entry. Pure, SSR-safe. One entry holds the whole composite: the 3.x base page
// shape plus `layers`. With no layer composed, `compose` returns the base page itself, so a layerless
// entry is byte-identical to 3.x. A blank base is never stored under layers: the deepest layer is
// stored as the base page, and a blank base with no layers is stored as the placeholder itself.

import type { Page } from '../types'
import type { LayerId, InitialRow } from './state'
import type { LayerInfo } from './types'

export type LayerEntry = Omit<Page, 'flash'> & {
  id: string
  key: string
  type: 'routed' | 'local'
  /** null = the base. */
  owner: string | null
  entries: number
  preservesUrl?: true
  /** Opened cold: its close pushes the page beneath. */
  standalone?: true
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
    standalone: _standalone,
    ...page
  } = layer

  return page
}

/** The page a layer entry stores, as its instance holds it. */
export function layerPage(layer: LayerEntry): Page {
  return { ...pageOf(layer), flash: {} }
}

// ---------------------------------------------------------------------------------------------------
// Boot: the document load. Runs on the server per request and on the client before mount, so both
// derive the same plan, ids included, from the same response.
// ---------------------------------------------------------------------------------------------------

export interface InitialLayer {
  readonly row: InitialRow
  /** The layer's page: the response without its `layer` mark, plus the client's hash. */
  readonly page: Page
}

export interface BootPlan {
  /** What the app and router.init receive as the initial page. The response itself when it is no layer. */
  readonly base: Page
  readonly layers: readonly InitialLayer[]
  /** The declared base fetched first, once the blank base is on screen. */
  readonly declaredBase: string | null
  /** The page head and title come from: the top layer's, else the base. */
  readonly top: Page
  /** The layers as the loading resolver sees them. */
  readonly info: readonly LayerInfo[]
}

type Marked = Page & { layer?: { key?: string; base?: string | null } }

export function planBoot(response: Page, hash: string): BootPlan {
  const { layer: mark, ...page } = response as Marked

  if (!mark) {
    return { base: response, layers: [], declaredBase: null, top: response, info: [] }
  }

  // A layer with no base, or one that names itself as its base, has nothing beneath it to fetch.
  if (!mark.base || samePathAndQuery(mark.base, response.url)) {
    return { base: page, layers: [], declaredBase: null, top: page, info: [] }
  }

  const base = blankPage(mark.base, response)
  const layer: InitialLayer = {
    row: {
      id: bootId(response.url),
      type: 'routed',
      key: mark.key || response.component,
      owner: 'base',
      standalone: true,
      ownsAddress: true,
      entries: 0,
    },
    // A document may name no flash or rescued props: the layer gets what 3.x gives its initial page.
    page: {
      ...page,
      flash: page.flash ?? {},
      rescuedProps: page.rescuedProps ?? [],
      url: hash && !page.url.includes('#') ? page.url + hash : page.url,
    },
  }
  const info: LayerInfo = {
    id: layer.row.id,
    key: layer.row.key,
    component: layer.page.component,
    url: layer.page.url,
    type: 'routed',
  }

  return { base, layers: [layer], declaredBase: mark.base, top: layer.page, info: [info] }
}

/** The origin is left out: the server knows none, and it must plan what the client plans. */
function samePathAndQuery(a: string, b: string): boolean {
  const at = (url: string) => {
    const { pathname, search } = new URL(url, 'http://localhost')

    return pathname + search
  }

  return at(a) === at(b)
}

/** The placeholder a cold layer stands on until its base is fetched. It carries the layer's version. */
export function blankPage(url: string, from: Pick<Page, 'version' | 'encryptHistory'>): Page {
  return {
    component: '',
    props: { errors: {} },
    url,
    version: from.version,
    encryptHistory: from.encryptHistory,
    flash: {},
    rescuedProps: [],
    rememberedState: {},
  }
}

/** Deterministic per document load, so the server markup and the hydrating client share layer ids. */
export function bootId(url: string): LayerId {
  const path = url.split('#')[0]
  let hash = 5381

  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) >>> 0
  }

  return `layer-boot-${hash.toString(36)}` as LayerId
}
