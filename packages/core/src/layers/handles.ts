// Messaging and the opener's handle. An Inbox holds what a layer's children emit up to it. A
// TicketHandle exists before its layer does: it collects listeners while pending and joins the
// layer's instance once a landing names it. A local layer opens here too: it has a handle and no ticket.

import { page as currentPage, type CurrentPage } from '../page'
import type { LayerId } from './state'
import type { LayerHandle, LayerInfo, LayerMessageListener } from './types'

export class Inbox {
  protected listeners = new Map<string, Set<LayerMessageListener>>()
  protected taps = new Set<Inbox>()

  on(name: string, listener: LayerMessageListener): () => void {
    const listeners = this.listeners.get(name) ?? new Set()

    listeners.add(listener)
    this.listeners.set(name, listeners)

    return () => listeners.delete(listener)
  }

  once(name: string, listener: LayerMessageListener): () => void {
    const off = this.on(name, (payload, from) => {
      off()
      listener(payload, from)
    })

    return off
  }

  /** Everything delivered here is delivered to `inbox` too. */
  tap(inbox: Inbox): void {
    this.taps.add(inbox)
  }

  deliver(name: string, payload: unknown, from: LayerInfo): void {
    ;[...(this.listeners.get(name) ?? [])].forEach((listener) => listener(payload, from))
    this.taps.forEach((tap) => tap.deliver(name, payload, from))
  }
}

/** What a handle joins once its layer exists. A LayerInstance is one. */
export interface Bindable {
  readonly id: LayerId
  readonly inbox: Inbox
  readonly closeListeners: Set<() => void>
}

/** No request and no ticket: `opened` adds the row once the component resolved, and the instance owns its page. */
export function openLocal(
  handle: TicketHandle,
  { component, props }: { component: string; props?: Record<string, unknown> },
  opened: () => { id: LayerId; inbox: Inbox; closeListeners: Set<() => void>; page: CurrentPage },
): void {
  handle.abort = () => handle.fireClose()

  const landed = currentPage.resolve(component).then(() => {
    if (handle.state !== 'pending') {
      return
    }

    const instance = opened()

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

export class TicketHandle implements LayerHandle {
  public state: 'pending' | 'open' | 'closed' = 'pending'
  /** The visit carrying this open, once its scope captured it. */
  public visit: string | null = null
  /** Cancels that visit while it is out. */
  public abort: (() => void) | null = null
  protected bound: LayerId | null = null
  protected inbox = new Inbox()
  protected closeListeners = new Set<() => void>()

  constructor(
    protected ticket: LayerId,
    protected port: { close(id: LayerId): Promise<void>; giveUp(ticket: LayerId): void },
  ) {}

  /** The layer's id: the one asked for, or an existing layer's when the answer rewrote that one. */
  get id(): string {
    return this.bound ?? this.ticket
  }

  on(name: string, listener: LayerMessageListener): () => void {
    return this.inbox.on(name, listener)
  }

  once(name: string, listener: LayerMessageListener): () => void {
    return this.inbox.once(name, listener)
  }

  onClose(listener: () => void): () => void {
    if (this.state === 'closed') {
      queueMicrotask(listener)

      return () => {}
    }

    this.closeListeners.add(listener)

    return () => this.closeListeners.delete(listener)
  }

  close(): Promise<void> {
    if (this.state === 'closed') {
      return Promise.resolve()
    }

    if (this.bound) {
      return this.port.close(this.bound)
    }

    return new Promise((resolve) => {
      this.onClose(resolve)
      this.abort?.()
      this.port.giveUp(this.ticket)
    })
  }

  bind(layer: Bindable): void {
    if (this.state !== 'pending') {
      return
    }

    this.state = 'open'
    this.bound = layer.id
    layer.inbox.tap(this.inbox)
    layer.closeListeners.add(() => this.fireClose())
  }

  fireClose(): void {
    if (this.state === 'closed') {
      return
    }

    this.state = 'closed'

    const listeners = [...this.closeListeners]

    this.closeListeners.clear()
    listeners.forEach((listener) => listener())
  }
}
