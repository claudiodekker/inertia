// Visits the stack follows: open requests, base fetches, recoveries and refreshes. A followed visit carries a tag
// from its onBefore until its scope captures it at dispatch, which is what tells the reducer it left.

import type { PendingVisit } from '../types'
import type { StackEvent, VisitId, VisitTag } from './state'

interface Followed {
  onBefore?: (visit: PendingVisit) => boolean | void
  onFinish?: (visit: never) => void
}

export class Visits {
  protected tags = new Map<string, VisitTag>()

  constructor(protected dispatch: (event: StackEvent) => void) {}

  /** A scope captured a visit at dispatch: a followed one reports its tag. A 409 re-issue reports again. */
  captured(visit: PendingVisit): void {
    const tag = this.tags.get(visit.id)

    if (tag) {
      this.tags.delete(visit.id)
      this.dispatch({ type: 'visitDispatched', visit: visit.id as VisitId, tag })
    }
  }

  /**
   * Sends a visit with `tag` attached. Returns its id, or null when the caller's onBefore or a before
   * listener refused it, so no scope captured it and no finish will follow.
   */
  follow<Options extends Followed>(tag: VisitTag, options: Options, send: (options: Options) => void): VisitId | null {
    let id: string | null = null

    send({
      ...options,
      onBefore: (visit: PendingVisit) => {
        if (options.onBefore?.(visit) === false) {
          return false
        }

        id = visit.id
        this.tags.set(visit.id, tag)
      },
      onFinish: (visit: PendingVisit) => {
        options.onFinish?.(visit as never)
        this.dispatch({ type: 'visitFinished', visit: visit.id as VisitId })
      },
    })

    return id !== null && !this.tags.delete(id) ? (id as VisitId) : null
  }
}
