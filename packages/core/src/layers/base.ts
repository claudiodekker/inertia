// What the stack asks 3.x to do for the base page beneath a cold layer: the visits that fetch it, the
// url its placeholder carries, and the flash a layer arrived with on the document.

import { fireFlashEvent } from '../events'
import { page as currentPage } from '../page'
import type { Router } from '../router'
import type { VisitOptions } from '../types'
import type { BootPlan } from './entry'
import type { VisitId, VisitTag } from './state'
import type { Visits } from './visits'

/** A walk hop or a recovery: a background base visit replacing the blank. A failed hop shows no overlay. */
export function fetchBase(
  visits: Visits,
  router: Router,
  tag: Extract<VisitTag, { kind: 'walk' | 'recover' }>,
  url: string,
  hopFailed: (visit: VisitId) => void,
): void {
  let id: VisitId | null = null
  const failed =
    tag.kind === 'walk'
      ? () => {
          hopFailed(id!)

          return false
        }
      : undefined
  const options: VisitOptions = {
    async: true,
    replace: true,
    preserveState: true,
    preserveScroll: true,
    onHttpException: failed,
    onNetworkError: failed,
  }

  id = visits.follow(tag, options, (followed) => router.visit(url, followed))
}

/** The blank takes the url the walk fetches next, and 3.x resolves it again: the loading resolver sees that url. */
export function retargetBlank(url: string): void {
  void currentPage.set({ ...currentPage.get(), url }, { replace: true, preserveScroll: true, preserveState: true })
}

/**
 * The flash a layer arrived with on the document is announced as 3.x announces the document's own:
 * after the initial navigate event. A load that restores a history entry announces none.
 */
export function announceFlash(plan: BootPlan, router: Router): void {
  const flashes = plan.seeds.map((seed) => seed.page.flash).filter((flash) => Object.keys(flash).length > 0)

  if (flashes.length > 0) {
    router.once('navigate', (event) => {
      if (event.detail.type === 'initial') {
        queueMicrotask(() => flashes.forEach((flash) => fireFlashEvent(flash)))
      }
    })
  }
}
