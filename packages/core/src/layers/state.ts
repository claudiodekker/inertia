// The control plane's one value, its events, effects and outcomes. Pure types.
// StackState holds structure only, never a Page: layer pages live in their LayerInstance and the base
// page in the 3.x `page` singleton. Facts a decision needs from page data arrive as event fields.

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type LayerId = Brand<string, 'LayerId'>

export type Owner = LayerId | 'base'

export interface StackState {
  /** `gen` bumps when the base page is replaced, so a response dispatched over an older base can tell. */
  readonly base: { readonly gen: number }
  /** The live model, bottom to top. */
  readonly rows: readonly LayerRow[]
  /** Out of the model already (rewrite-dismissed), still rendering their exit. Disposed on `exited`. */
  readonly ghosts: readonly LayerId[]
  /** Closed while a base commit is between `baseCommitting` and `baseSwapped`. */
  readonly paint: { readonly gated: boolean; readonly owed: boolean }
}

export interface LayerRow {
  readonly id: LayerId
  readonly type: 'routed' | 'local'
  /** `layer.key || component`. */
  readonly key: string
  readonly owner: Owner
  /** opening: first commit pending (not rendered, not composed). open: committed. */
  readonly phase: 'opening' | 'open'
  /** False for local rows and preserveUrl opens. */
  readonly ownsAddress: boolean
  /** Browser entries this row pushed. */
  readonly entries: number
  /** Bumped by a remounting landing. */
  readonly renderKey: number
}

/** Where a request was made, captured by its scope at dispatch (after the onBefore gate). */
export type Origin =
  | { readonly kind: 'base'; readonly top: LayerId | null; readonly gen: number; readonly instantGen: number | null }
  | { readonly kind: 'layer'; readonly id: LayerId; readonly instant: boolean }

/** Parsed once from the response page. `layer` present (even `{}`) makes it a layer response. */
export interface Marks {
  readonly layer: { readonly key: string; readonly base: string | null } | null
}

/** Booleans the runtime derives from page data and visit params at the boundary. */
export interface RouteFacts {
  /** Request url equals response url, without the hash. */
  readonly aimed: boolean
  /** The declared base equals the live base url, without the hash. */
  readonly baseMatches: boolean
  /** only, except or reset. */
  readonly partial: boolean
  readonly async: boolean
  readonly preserveState: boolean
  readonly preserveUrl: boolean
}

export type StackEvent =
  | { type: 'responseArrived'; origin: Origin; marks: Marks; facts: RouteFacts; newId: LayerId }
  /** Fired by the base CurrentPage.write after the component resolved, before the history write. */
  | { type: 'baseCommitting'; mode: 'push' | 'replace'; sameAsLive: boolean }
  | { type: 'baseSwapped' }
  /** Fired by LayerPage.write after the component resolved, before the history write. */
  | { type: 'layerCommitting'; id: LayerId; requestedReplace: boolean; urlChanged: boolean }
  /** A layer's view changed (swap, optimistic props, flash). */
  | { type: 'layerSwapped'; id: LayerId }
  /** The shell's exit finished. */
  | { type: 'exited'; id: LayerId }

export type StackEffect =
  /** Publish views to the adapters. Emitted only while the gate is open; otherwise `paint.owed`. */
  | { type: 'paint' }
  /** history.writeEntry(the live composite, its address, mode). */
  | { type: 'writeEntry'; mode: 'push' | 'replace' }
  /** instance.dispose(): scope.disposed is true at once, its view leaves at the next paint. */
  | { type: 'dispose'; ids: readonly LayerId[]; reason: 'closed' | 'navigated' }

export type Landing =
  /** 3.x continues on the response's own scope, untouched. */
  | { kind: 'pass' }
  /** Discard: no set, no callbacks but the request's own finish. */
  | { kind: 'drop' }
  /** Re-bind to the base and land (a layer-made request answered by a plain page). */
  | { kind: 'base' }
  /** Land on the base with the `layer` mark stripped. */
  | { kind: 'promote' }
  | { kind: 'open'; id: LayerId; owner: Owner }
  | { kind: 'rewrite'; id: LayerId; dismissed: readonly LayerId[]; remount: boolean }
  | { kind: 'refresh'; id: LayerId; remount: boolean }
  /** A blank base plus a standalone layer, then the walk. */
  | { kind: 'cold' }

export type CommitDecision = { kind: 'skip' } | { kind: 'write'; mode: 'push' | 'replace' }

export type Outcome =
  | { kind: 'none' }
  | { kind: 'landing'; landing: Landing }
  | { kind: 'commit'; decision: CommitDecision }

export interface Step {
  readonly state: StackState
  readonly effects: readonly StackEffect[]
  readonly outcome: Outcome
}

export const initialState: StackState = {
  base: { gen: 0 },
  rows: [],
  ghosts: [],
  paint: { gated: false, owed: false },
}

/** True when nothing layer-related exists: the layerless fast path checks this before building any input. */
export function idle(s: StackState): boolean {
  return s.rows.length === 0 && s.ghosts.length === 0
}
