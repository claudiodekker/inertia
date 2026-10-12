// Where the reducer said a response lands: Response.land(), run against the page or the layer it named.

import type { Response } from '../response'
import type { Page } from '../types'
import { stripMark } from './facts'
import type { LayerInstance } from './instance'
import type { PageScope } from './scope'
import type { Landing, LayerId } from './state'

interface Targets {
  readonly base: PageScope
  /** A new layer for a landing that opens one. */
  create(id: LayerId): LayerInstance
  layer(id: LayerId): LayerInstance
}

/** Undefined for a landing the response runs on its own scope. */
export function land(landing: Landing, response: Response, page: Page, targets: Targets): Promise<void> | undefined {
  switch (landing.kind) {
    case 'pass':
      return undefined
    case 'drop':
      return Promise.resolve()
    case 'base':
      return response.retarget(targets.base).land()
    case 'promote':
    case 'fetched-base':
      return response.retarget(targets.base, stripMark(page)).land()
    case 'open':
    case 'cold':
    case 'return':
    case 'fetched-beneath':
      return response.retarget(targets.create(landing.id).scope).land()
    case 'rewrite':
    case 'refresh':
      return response.retarget(targets.layer(landing.id).scope).land()
    case 'close':
      return response.succeed((landing.beneath === 'base' ? targets.base : targets.layer(landing.beneath)).page.get())
    case 'handback': {
      // The layer keeps its page; only the answer's errors and flash land, on the layer that asked.
      const { scope } = targets.layer(landing.id)
      const own = scope.page.get()

      return response
        .retarget(scope, { ...own, props: { ...own.props, errors: page.props.errors }, flash: page.flash })
        .land()
    }
    default:
      throw new Error(`Unhandled: ${JSON.stringify(landing satisfies never)}`)
  }
}
