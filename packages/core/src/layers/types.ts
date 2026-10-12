import type { Router } from '../router'
import type { LayoutProps, NamedLayoutProps, UrlMethodPair } from '../types'

export interface LayerInfo {
  readonly id: string
  readonly key: string
  readonly component: string
  /** The layer's own url. A local layer has none. */
  readonly url: string | null
  readonly type: 'routed' | 'local'
}

export type LayerMessageListener = (payload: unknown, from: LayerInfo) => void

/** A url opens a routed layer through a request; a component opens a local layer with no request. */
export type LayerTarget = string | URL | UrlMethodPair | { component: string; props?: Record<string, unknown> }

/** The opener's grip on a layer it asked for. Exists before the layer does. */
export interface LayerHandle {
  readonly id: string
  readonly state: 'pending' | 'open' | 'closed'
  on(name: string, listener: LayerMessageListener): () => void
  once(name: string, listener: LayerMessageListener): () => void
  onClose(listener: () => void): () => void
  close(): Promise<void>
}

/** What a layer's context hands out (useLayer(), router.layerHandle()). */
export interface LayerScope extends LayerInfo {
  /** A Router bound to this layer's page store. */
  readonly router: Router
  /** 0 = bottom. Live. */
  readonly index: number
  close(): Promise<void>
  /** To the layer or page that opened this layer. */
  emit(name: string, payload?: unknown): void
  on(name: string, listener: LayerMessageListener): () => void
  once(name: string, listener: LayerMessageListener): () => void
  onClose(listener: () => void): () => void
  /** This layer's layouts only. The global setLayoutProps stays base-only. */
  setLayoutProps(props: Partial<LayoutProps>): void
  setLayoutProps<K extends keyof NamedLayoutProps>(name: K, props: Partial<NamedLayoutProps[K]>): void
  resetLayoutProps(): void
}

export interface LayerShellProps {
  open: boolean
  index: number
  isTop: boolean
  type: 'routed' | 'local'
  /** Programmatic close of this layer. Escape calls it on the top layer. */
  close: () => void
  /** The shell's exit finished. */
  done: () => void
}

export interface MountedLayerDialog {
  update(shell: LayerShellProps): void
  unmount(): void
}

/** Called only while a cold layer's base is being fetched, with the declared base url and the open layers. */
export type LoadingResolver<Component> = (
  url: string,
  context: { readonly layers: readonly LayerInfo[] },
) => Component | { default: Component } | undefined | Promise<Component | { default: Component } | undefined>
