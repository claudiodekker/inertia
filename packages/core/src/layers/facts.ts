// The boundary: what the reducer knows of pages and visits, computed here from page data and visit
// params, so state.ts carries booleans and ids instead of pages.

import { RequestParams } from '../requestParams'
import type { Page, PendingVisit } from '../types'
import { hrefToUrl, isSameUrlWithoutHash } from '../url'
import { isBlank, type LayerEntry } from './entry'
import type { BaseChange, EntryFacts, LayerId, LayerRow, Marks, Owner, RouteFacts } from './state'

type Marked = Page & { layer?: { key?: string; base?: string }; close?: unknown }

export function marksOf(page: Page | string): Marks {
  const mark = typeof page === 'object' ? (page as Marked).layer : undefined

  return {
    layer: mark ? { key: mark.key || (page as Page).component, base: mark.base ?? null } : null,
    close: typeof page === 'object' && (page as Marked).close === true,
  }
}

export function stripMark(page: Page): Page {
  const { layer: _mark, ...plain } = page as Marked

  return plain
}

/** A prompt on the way to something else: read off the raw page, since Page has no such key. */
export function isInterstitial(page: Page): boolean {
  return (page as Page & { interstitial?: unknown }).interstitial === true
}

/** What is on screen: the base page, the live rows' pages bottom first, and the page owning the address. */
interface Screen {
  readonly base: Page
  readonly live: readonly Page[]
  readonly addressOwner: Page
}

export function routeFacts(
  visit: PendingVisit,
  page: Page | string,
  marks: Marks,
  { base: basePage, live: livePages, addressOwner }: Screen,
): RouteFacts {
  const pageUrl = typeof page === 'object' ? hrefToUrl(page.url) : null
  const declared = marks.layer?.base ? hrefToUrl(marks.layer.base) : null

  return {
    aimed: pageUrl !== null && isSameUrlWithoutHash(visit.url, pageUrl),
    baseMatches: declared !== null && isSameUrlWithoutHash(declared, hrefToUrl(basePage.url)),
    cycles:
      declared !== null &&
      [...livePages.map((live) => live.url), pageUrl?.href].some(
        (url) => !!url && isSameUrlWithoutHash(hrefToUrl(url), declared),
      ),
    partial: visit.only.length > 0 || visit.except.length > 0 || visit.reset.length > 0,
    async: visit.async,
    preserveState: typeof page === 'object' && RequestParams.resolvePreserveOption(visit.preserveState, page),
    preserveUrl: visit.preserveUrl,
    replace: visit.replace,
    matchesAddressOwner:
      pageUrl !== null &&
      (page as Page).component === addressOwner.component &&
      isSameUrlWithoutHash(pageUrl, hrefToUrl(addressOwner.url)),
    hasErrors: typeof page === 'object' && Object.keys(page.props?.errors ?? {}).length > 0,
  }
}

/** `pageOf` reads a live instance's page by id. */
export function entryFacts(
  base: Page,
  layers: readonly LayerEntry[],
  live: Page,
  pageOf: (id: LayerId) => Page | undefined,
): EntryFacts {
  return {
    layers: layers.map((layer) => ({
      id: layer.id as LayerId,
      key: layer.key,
      type: layer.type,
      owner: (layer.owner ?? 'base') as Owner,
      standalone: !!layer.standalone,
      ownsAddress: !layer.preservesUrl,
      entries: layer.entries,
    })),
    url: base.url,
    baseSame: base.component === live.component && base.url === live.url,
    blank: isBlank(base),
    sameSnapshot: new Set(
      layers
        .filter((layer) => {
          const page = pageOf(layer.id as LayerId)

          return page?.component === layer.component && page.url === layer.url
        })
        .map((layer) => layer.id as LayerId),
    ),
  }
}

/** A row as the composite entry stores it, from the page last handed to history for it. */
export function snapshot(row: LayerRow, historyPage: Page): LayerEntry {
  const { flash: _flash, ...page } = historyPage

  return {
    ...page,
    id: row.id,
    key: row.key,
    type: row.type,
    owner: row.owner === 'base' ? null : row.owner,
    entries: row.entries,
    ...(!row.ownsAddress && { preservesUrl: true as const }),
    ...(row.standalone && { standalone: true as const }),
  }
}

/**
 * A partial or a reload reads a page again in place, where any other visit navigates. A reload is a
 * background visit that keeps state and asks for the path its own page is at.
 */
export function isRefresh(visit: PendingVisit, own: Page): boolean {
  const partial = visit.only.length > 0 || visit.except.length > 0 || visit.reset.length > 0
  const from = hrefToUrl(own.url)

  return (
    partial ||
    (visit.async &&
      visit.preserveState === true &&
      from.origin === visit.url.origin &&
      from.pathname === visit.url.pathname)
  )
}

export function baseChange(live: Page | undefined, page: Page): BaseChange {
  if (!live || live.component !== page.component) {
    return 'other'
  }

  const from = hrefToUrl(live.url)
  const to = hrefToUrl(page.url)

  if (isBlank(page) || isSameUrlWithoutHash(from, to)) {
    return 'same'
  }

  return from.origin === to.origin && from.pathname === to.pathname ? 'moved' : 'elsewhere'
}
