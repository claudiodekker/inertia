// Messaging and the opener's handle. A LayerMessages holds what a layer's children emit up to it. A
// OpenRequestHandle exists before its layer does: it collects listeners while pending and joins the
// layer's instance once a landing names it.

import type { LayerId } from './state'
import type { LayerHandle, LayerInfo, LayerMessageListener } from './types'

export class LayerMessages {
  protected listeners = new Map<string, Set<LayerMessageListener>>()
  protected forwards = new Set<LayerMessages>()

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

  /** Everything delivered here is delivered to `messages` too. */
  forwardTo(messages: LayerMessages): void {
    this.forwards.add(messages)
  }

  deliver(name: string, payload: unknown, from: LayerInfo): void {
    ;[...(this.listeners.get(name) ?? [])].forEach((listener) => listener(payload, from))
    this.forwards.forEach((messages) => messages.deliver(name, payload, from))
  }
}

/** What a handle joins once its layer exists. A LayerInstance is one. */
export interface Bindable {
  readonly id: LayerId
  readonly messages: LayerMessages
  readonly closeListeners: Set<() => void>
}

export class OpenRequestHandle implements LayerHandle {
  public state: 'pending' | 'open' | 'closed' = 'pending'
  /** The visit carrying this open, once its scope captured it. */
  public visit: string | null = null
  /** Cancels that visit while it is out. */
  public abort: (() => void) | null = null
  protected bound: LayerId | null = null
  protected messages = new LayerMessages()
  protected closeListeners = new Set<() => void>()

  constructor(
    protected request: LayerId,
    protected port: { close(id: LayerId): Promise<void>; giveUp(request: LayerId): void },
  ) {}

  /** The layer's id: the one asked for, or an existing layer's when the answer rewrote that one. */
  get id(): string {
    return this.bound ?? this.request
  }

  on(name: string, listener: LayerMessageListener): () => void {
    return this.messages.on(name, listener)
  }

  once(name: string, listener: LayerMessageListener): () => void {
    return this.messages.once(name, listener)
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
      this.port.giveUp(this.request)
    })
  }

  bind(layer: Bindable): void {
    if (this.state !== 'pending') {
      return
    }

    this.state = 'open'
    this.bound = layer.id
    layer.messages.forwardTo(this.messages)
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
