// Which <Deferred> a partial reload lights: those of the page or the layer the reload was made in.

import { partialReloadRequestsSomeProps } from '../partialReload'
import type { PendingVisit } from '../types'
import { hrefToUrl, isSameUrlWithoutQueryOrHash } from '../url'
import { stack } from './stack'
import type { LayerInfo } from './types'

type Reload = Pick<PendingVisit, 'url' | 'preserveState' | 'only' | 'except'>

/**
 * The layer each visit was made in, by the URL object every copy of the visit shares. The Visit itself
 * carries no layer, so a listener sees the visit unchanged. A visit the page made is not in here.
 */
const madeIn = new WeakMap<URL, string>()

export function madeInLayer(visit: Pick<PendingVisit, 'url'>, id: string): void {
  madeIn.set(visit.url, id)
}

/**
 * True when `visit` reloads some of `keys` for the <Deferred> inside `layer` (null: on the page). The
 * page's reload goes to its own url, which is not the address while a layer owns it, and a layer and
 * the page can sit on one path, so the visit has to be made there as well.
 */
export function fillsDeferred(visit: Reload, layer: LayerInfo | null, keys: string[]): boolean {
  if (visit.preserveState !== true || (madeIn.get(visit.url) ?? null) !== (layer?.id ?? null)) {
    return false
  }

  const own = layer ? layer.url : stack.base.reloadUrl()

  return (
    (layer === null || own !== null) &&
    isSameUrlWithoutQueryOrHash(visit.url, own === null ? window.location : hrefToUrl(own)) &&
    partialReloadRequestsSomeProps(visit, keys)
  )
}
