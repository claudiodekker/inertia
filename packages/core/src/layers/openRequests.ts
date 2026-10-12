// Opening a layer on request (router.layer()): the handle its caller gets at once, the visit that
// fetches it, the placeholder it may show meanwhile, and the local layer that needs no visit.

import { page as currentPage } from '../page'
import type { CancelToken, VisitOptions } from '../types'
import { uid } from '../uid'
import { TicketHandle, type Bindable } from './handles'
import type { PageScope } from './scope'
import type { Stack } from './stack'
import type { LayerId, Owner } from './state'
import type { LayerHandle, LayerTarget } from './types'

type LocalTarget = Extract<LayerTarget, { component: string }>

export class OpenRequests {
  /** Handles no landing has named yet, by ticket. */
  protected pending = new Map<LayerId, TicketHandle>()

  constructor(protected stack: Stack) {}

  /** `scope` is the router's that was asked: a layer owns what it opens, the base hands it to the top layer. */
  public open(target: LayerTarget, options: VisitOptions, scope: PageScope): LayerHandle {
    const id = uid() as LayerId
    const handle = new TicketHandle(id, {
      close: (bound) => this.stack.close(bound),
      giveUp: (ticket) => void this.stack.dispatch({ type: 'openRefused', ticket }),
    })
    const { rows } = this.stack.state
    const owner = this.stack.instanceOf(scope)?.id ?? rows.filter((row) => row.phase === 'open').at(-1)?.id ?? 'base'

    if (typeof target === 'object' && !(target instanceof URL) && !('url' in target)) {
      this.openLocal(handle, id, target, owner)
    } else {
      this.visit(handle, id, target, options, scope, owner)
    }

    return handle
  }

  /** No request and no ticket: the row is added once the component resolved, and the instance owns its page. */
  protected openLocal(handle: TicketHandle, id: LayerId, { component, props }: LocalTarget, owner: Owner): void {
    handle.abort = () => handle.fireClose()

    const landed = currentPage.resolve(component).then(() => {
      if (handle.state !== 'pending') {
        return
      }

      this.stack.dispatch({ type: 'localOpened', id, owner, key: component })

      const instance = this.stack.create(id, 'local')

      handle.bind(instance)

      return instance.page.set(
        {
          component,
          props: { errors: {}, ...props },
          url: '',
          version: currentPage.get().version,
          flash: {},
          rescuedProps: [],
          rememberedState: {},
        },
        { preserveScroll: true, preserveState: false },
      )
    })

    landed.catch((error) => {
      handle.fireClose()

      throw error
    })
  }

  protected visit(
    handle: TicketHandle,
    id: LayerId,
    target: Exclude<LayerTarget, LocalTarget>,
    options: VisitOptions,
    scope: PageScope,
    owner: Owner,
  ): void {
    // A component to show at once goes up as the layer itself, and its answer lands on that layer.
    const placeholder =
      typeof options.component === 'string' ? this.stack.create(id).standingOn(scope.page.get()) : null

    this.pending.set(id, handle)
    this.stack.dispatch({ type: 'openRequested', ticket: id, owner })

    handle.visit = this.stack.visits.follow(
      { kind: 'open', ticket: id },
      {
        ...options,
        onCancelToken: (token: CancelToken) => {
          handle.abort = token.cancel
          options.onCancelToken?.(token)
        },
      },
      (followed) => (placeholder?.router ?? scope.router).visit(target, followed),
    )

    if (handle.visit === null) {
      this.stack.forget(id)
      this.stack.dispatch({ type: 'openRefused', ticket: id })
    } else if (placeholder) {
      this.pending.delete(id)
      this.stack.dispatch({ type: 'placeholderOpened', ticket: id, ownsAddress: !options.preserveUrl })
      handle.bind(placeholder)
    }
  }

  /** A landing named `layer`: the handle that asked for it by ticket or by this visit is that layer's now. */
  public bind(layer: Bindable, visit: string): void {
    for (const [ticket, handle] of this.pending) {
      if (ticket === layer.id || handle.visit === visit) {
        this.pending.delete(ticket)
        handle.bind(layer)
      }
    }
  }

  /** The ticket never landed: its handle closes. */
  public refuse(ticket: LayerId): void {
    const handle = this.pending.get(ticket)

    this.pending.delete(ticket)
    queueMicrotask(() => handle?.fireClose())
  }
}
