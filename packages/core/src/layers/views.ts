import { interceptors } from '../interceptors'
import type { Page } from '../types'
import type { LayerInstance } from './instance'
import type { LayerId, LayerRow } from './state'
import type { LayerInfo, LayerScope, LayerShellProps } from './types'

/** Immutable per change. Adapters key the frame on the scope and the page component on `renderKey`. */
export interface LayerView {
  readonly id: string
  readonly scope: LayerScope
  readonly component: unknown
  /** What usePage() returns inside the layer. A layer with no url of its own reads the address beneath it. */
  readonly page: Page
  /** What the layer's layouts are resolved with: its own page, whose url is '' when it has none. */
  readonly layoutPage: Page
  readonly renderKey: number
  readonly layout: LayerInstance['layout']
  readonly shell: LayerShellProps
  /** On the wrapper inside the shell. */
  readonly attributes: { 'data-layer-id': string; style: { viewTransitionName: string } }
}

/** `address` is the address beneath the layer, which a layer with no url of its own reads as its url. */
export function viewOf(instance: LayerInstance, shell: LayerShellProps, address?: string): LayerView {
  const { component, page, renderKey } = instance.view!

  return {
    id: instance.id,
    scope: instance.public,
    component,
    page: instance.type === 'local' && address !== undefined ? { ...page, url: address } : page,
    layoutPage: page,
    renderKey,
    layout: instance.layout,
    shell,
    attributes: { 'data-layer-id': instance.id, style: { viewTransitionName: `inertia-layer-${instance.id}` } },
  }
}

const noViews: readonly LayerView[] = []
const noInfo: readonly LayerInfo[] = []

type ShellActions = Pick<LayerShellProps, 'close' | 'done'>

/** Holds the views the adapters last saw, and tells them when a new set is ready. */
export class Painter {
  protected listeners = new Set<() => void | Promise<void>>()
  protected painted: { views: readonly LayerView[]; info: readonly LayerInfo[] } = { views: noViews, info: noInfo }
  protected cache = new Map<LayerId, LayerView>()
  protected shells = new Map<LayerId, ShellActions>()
  /** Disposed instances whose close listeners fire once the paint removing them has landed. */
  protected leaving: LayerInstance[] = []

  constructor(protected actions: (id: LayerId) => ShellActions) {}

  paint(
    rows: readonly LayerRow[],
    ghostIds: readonly LayerId[],
    instances: ReadonlyMap<LayerId, LayerInstance>,
    baseUrl: string,
  ): Promise<void> {
    const rendered = rows.filter((row) => instances.get(row.id)?.view)
    const ghosts = ghostIds.filter((id) => instances.get(id)?.view)
    let address = baseUrl
    const views = [
      ...rendered.map((row, index) => {
        const view = this.view(
          instances.get(row.id)!,
          index,
          index === rendered.length - 1,
          row.close === null,
          address,
        )

        address = row.type === 'routed' && row.ownsAddress ? view.page.url : address

        return view
      }),
      ...ghosts.map((id, index) => this.view(instances.get(id)!, rendered.length + index, false, false, address)),
    ]
    const leaving = this.leaving
    const before = this.painted.info

    this.leaving = []
    this.painted = {
      views: views.length > 0 ? views : noViews,
      info: rendered.length > 0 ? rendered.map((row) => instances.get(row.id)!.info()) : noInfo,
    }
    this.announce(before, this.painted.info)

    for (const id of this.cache.keys()) {
      if (!instances.has(id)) {
        this.cache.delete(id)
        this.shells.delete(id)
      }
    }

    return Promise.all([...this.listeners].map((listener) => listener())).then(() =>
      leaving.forEach((instance) => instance.fireClose()),
    )
  }

  /** Development tooling hears each layer that joined the stack and each that left it, bottom first. */
  protected announce(before: readonly LayerInfo[], now: readonly LayerInfo[]): void {
    const absentFrom = (stack: readonly LayerInfo[]) => (layer: LayerInfo) => !stack.some(({ id }) => id === layer.id)

    now.filter(absentFrom(before)).forEach((layer) => interceptors.fireLayerEvent({ type: 'opened', layer }))
    before.filter(absentFrom(now)).forEach((layer) => interceptors.fireLayerEvent({ type: 'closed', layer }))
  }

  /** A disposed instance: its close listeners fire once the paint removing its view has landed, or at once when none shows it. */
  left(instance: LayerInstance): void {
    if (this.painted.views.some((view) => view.id === instance.id)) {
      this.leaving.push(instance)
    } else {
      queueMicrotask(() => instance.fireClose())
    }
  }

  protected view(instance: LayerInstance, index: number, isTop: boolean, open: boolean, address: string): LayerView {
    const { component, page, renderKey } = instance.view!
    const cached = this.cache.get(instance.id)

    if (
      cached &&
      cached.component === component &&
      cached.layoutPage === page &&
      cached.page.url === (instance.type === 'local' ? address : page.url) &&
      cached.renderKey === renderKey &&
      cached.shell.index === index &&
      cached.shell.isTop === isTop &&
      cached.shell.open === open
    ) {
      return cached
    }

    const shell = this.shells.get(instance.id) ?? this.actions(instance.id)

    this.shells.set(instance.id, shell)

    const view = viewOf(instance, { open, index, isTop, type: instance.type, ...shell }, address)

    this.cache.set(instance.id, view)

    return view
  }

  views(): readonly LayerView[] {
    return this.painted.views
  }

  info(): readonly LayerInfo[] {
    return this.painted.info
  }

  topPage(): Page | null {
    return this.painted.views.filter((view) => view.shell.open).at(-1)?.page ?? null
  }

  /** A listener may return a promise that settles once its DOM shows the views. */
  subscribe(listener: () => void | Promise<void>): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
}
