// The control plane's one value, its events, effects and outcomes. Pure types.
// StackState holds structure only, never a Page: layer pages live in their LayerInstance and the base
// page in the 3.x `page` singleton. Facts a decision needs from page data arrive as event fields.
// The one page reference is Interstitial.token, which names a page the runtime sets aside.

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** Made by the runtime and carried in on events. */
export type LayerId = Brand<string, 'LayerId'>
/** The 3.x visit id. It survives getPendingVisit merges and 409 re-issues. */
export type VisitId = Brand<string, 'VisitId'>
export type CloseId = Brand<string, 'CloseId'>
export type WaiterId = Brand<string, 'WaiterId'>
/** Correlates an effect that waits with the event reporting it. A stale token is ignored. */
export type Token = Brand<number, 'Token'>

export type Owner = LayerId | 'base'

/** The deepest stack that fetching declared bases builds. A base declared beneath it is not fetched. */
export const MAX_LAYER_CHAIN = 10

export interface StackState {
  readonly nextToken: number
  /** `gen` bumps when the base page is replaced. `blank`: a placeholder stands in until the base is fetched. */
  readonly base: { readonly blank: boolean; readonly gen: number }
  /** The live model, bottom to top. Rows in a close stay here until removal: the address is still theirs. */
  readonly rows: readonly LayerRow[]
  /** Out of the model already (Back-dismissed, rewrite-dismissed), still rendering their exit. */
  readonly dismissed: readonly LayerId[]
  /** Insertion order is the removal queue order. */
  readonly closes: ReadonlyMap<CloseId, CloseRow>
  /** Programmatic opens, keyed by the id the layer will get. */
  readonly openRequests: ReadonlyMap<LayerId, OpenRequest>
  /** Visits the stack itself follows: open requests, base fetches, refreshes beneath, recoveries. */
  readonly ops: ReadonlyMap<VisitId, Op>
  readonly baseFetch: BaseFetch | null
  readonly interstitial: Interstitial | null
  /** What only the browser or 3.x can complete. At most one at a time. */
  readonly expect: Expectation | null
  /** Closed while a base commit is between `baseCommitting` and `baseSwapped`. */
  readonly paint: { readonly gated: boolean; readonly owed: boolean }
}

export interface LayerRow {
  readonly id: LayerId
  readonly type: 'routed' | 'local'
  /** `layer.key || component`. Local rows never match a response. */
  readonly key: string
  readonly owner: Owner
  /** opening: first commit pending, so not rendered and not composed. */
  readonly phase: 'opening' | 'open'
  /** Opened cold (with the document, beneath a fetched layer, or in session): its close pushes the page beneath. */
  readonly standalone: boolean
  /** False for local rows and preserveUrl opens. */
  readonly ownsAddress: boolean
  /** Browser entries this row pushed. */
  readonly entries: number
  /** Bumped by a remounting landing. */
  readonly renderKey: number
  readonly close: CloseId | null
}

export interface CloseRow {
  readonly id: CloseId
  /** Covered rows, bottom first. Until `refreshing` every one is in `rows` with `close === id`; from then on none is. */
  readonly layers: readonly LayerId[]
  readonly exited: readonly LayerId[]
  readonly waiters: readonly WaiterId[]
  readonly phase:
    | { readonly kind: 'exiting' }
    /** Every shell exited, but another close or a base install holds `expect`. */
    | { readonly kind: 'queued' }
    | { readonly kind: 'unwinding'; readonly token: Token }
    /** Rows removed; the page or layer beneath is reloading. Waiters settle when that visit finishes. */
    | { readonly kind: 'refreshing'; readonly visit: VisitId | null }
}

/** Lives until its visit lands on a row (the landing names the row) or is refused. */
export interface OpenRequest {
  readonly id: LayerId
  readonly owner: Owner
  readonly state: 'pending' | 'dispatched'
}

export type Op =
  | { readonly kind: 'open'; readonly request: LayerId; readonly inFlight: number }
  | { readonly kind: 'fetchBase'; readonly inFlight: number; readonly landed: boolean }
  | { readonly kind: 'refresh'; readonly close: CloseId; readonly inFlight: number }
  | { readonly kind: 'recover'; readonly inFlight: number }

export interface BaseFetch {
  /** The declared base being fetched. */
  readonly url: string
  readonly visit: VisitId | null
  /** The first request starts at the first baseSwapped after the blank base is on screen. */
  readonly startOnSwap: boolean
}

export interface Interstitial {
  /** Names the outgoing base page the runtime set aside. */
  readonly token: Token
  /** Gen of the prompt on screen. A layer response landing while `base.gen === interstitial.gen` is a return. */
  readonly gen: number
  /** Base pushes made while the prompt is up, charged to the returning row so Back skips the prompt. */
  readonly pushes: number
  readonly request: LayerId | null
  /** Rows live when the prompt replaced the screen: not rendered, not composed, not disposed. */
  readonly suspended: readonly LayerRow[]
}

export type InstallSource =
  | { readonly kind: 'blank'; readonly url: string }
  | { readonly kind: 'held'; readonly token: Token }
  /** The layer's page becomes the base page. */
  | { readonly kind: 'promote'; readonly layer: LayerId }

export type Expectation =
  /** history.go(-n) issued for `close`; the next popstate, or the timeout answer, completes it. */
  | { readonly kind: 'unwind'; readonly close: CloseId; readonly token: Token }
  /**
   * The stack asked 3.x to install a base page; the commit whose visit id is `token` is it.
   * `layer` is the row the install waits on (cold, return) or promotes.
   */
  | {
      readonly kind: 'base'
      readonly token: Token
      readonly mode: 'push' | 'replace'
      readonly layer: LayerId
      readonly source: InstallSource
    }

/** Where a request was made, captured by its scope at dispatch (after the onBefore gate). */
export type Origin =
  | { readonly kind: 'base'; readonly top: LayerId | null; readonly gen: number; readonly instantGen: number | null }
  | { readonly kind: 'layer'; readonly id: LayerId; readonly instant: boolean }

/** Parsed once from the response page. `layer` present (even `{}`) makes it a layer response. */
export interface Marks {
  readonly layer: { readonly key: string; readonly base: string | null } | null
  readonly close: boolean
}

/** Booleans the runtime derives from page data and visit params at the boundary. */
export interface RouteFacts {
  /** Request url equals response url, without the hash. */
  readonly aimed: boolean
  /** The declared base equals the live base url, without the hash. */
  readonly baseMatches: boolean
  /** The declared base equals the url of a live row or the answer's own, so fetching it would go in a circle. */
  readonly cycles: boolean
  /** Response component and url equal the page that owns the address (top address-owning row, else base). */
  readonly matchesAddressOwner: boolean
  readonly hasErrors: boolean
  /** only, except or reset. */
  readonly partial: boolean
  readonly async: boolean
  readonly preserveState: boolean
  readonly preserveUrl: boolean
  readonly replace: boolean
}

/**
 * A committing base page against the one on screen: the `same` component and url, `moved` to another
 * query of the same path, the same component `elsewhere`, or `other`. A blank over a blank is the same.
 */
export type BaseChange = 'same' | 'moved' | 'elsewhere' | 'other'

/**
 * The response a base commit lands, if any: a `refresh` answers a partial or a reload, which reads the
 * page again in place; a `navigation` answers any other visit. null for a client visit, a placeholder
 * or an install.
 */
export type Answer = 'refresh' | 'navigation' | null

/** One layer of a decrypted composite entry, structure only. */
export interface EntryLayerFacts {
  readonly id: LayerId
  readonly key: string
  readonly type: 'routed' | 'local'
  readonly owner: Owner
  readonly standalone: boolean
  readonly ownsAddress: boolean
  readonly entries: number
}

export interface EntryFacts {
  readonly layers: readonly EntryLayerFacts[]
  /** The entry's base url. */
  readonly url: string
  /** Entry base component and url equal the live base page. */
  readonly baseSame: boolean
  /** The entry base is a blank placeholder. */
  readonly blank: boolean
  /** Live rows whose component and url equal the entry layer's. */
  readonly sameSnapshot: ReadonlySet<LayerId>
}

export type InitialRow = Omit<LayerRow, 'phase' | 'close' | 'renderKey'>

export type StackEvent =
  | { type: 'booted'; layers: readonly InitialRow[]; blank: boolean; declaredBase: string | null }
  | { type: 'restoredOnLoad'; entry: EntryFacts }
  | { type: 'openRequested'; request: LayerId; owner: Owner }
  /**
   * The request is given up with no visit out: its gate refused the visit, or its handle was closed while
   * it waited on a prompt. A request whose visit is out ends at that visit's finish instead.
   */
  | { type: 'openRefused'; request: LayerId }
  /**
   * The open named a component to show at once, so its layer goes up before the answer: the request's row
   * exists from here, keyed by its own id until the answer names the key.
   */
  | { type: 'placeholderOpened'; request: LayerId; ownsAddress: boolean }
  /**
   * The placeholder of an instant visit made in layer `id` could not be shown, so the visit is never
   * sent. A layer that was opening on that placeholder opens nothing.
   */
  | { type: 'placeholderFailed'; id: LayerId; visit: VisitId }
  /** After the local layer's component resolved. */
  | { type: 'localOpened'; id: LayerId; owner: Owner; key: string }
  /** From scope.capture() for a visit the runtime tagged. Counted per id: a 409 re-issue dispatches the same id. */
  | { type: 'visitDispatched'; visit: VisitId; tag: VisitTag }
  | { type: 'visitFinished'; visit: VisitId }
  | { type: 'baseFetchFailed'; visit: VisitId }
  | {
      type: 'responseArrived'
      visit: VisitId
      origin: Origin
      marks: Marks
      facts: RouteFacts
      newId: LayerId
      newClose: CloseId
    }
  /** Fired by the base CurrentPage.write after the component resolved, before the history write. */
  | {
      type: 'baseCommitting'
      visit: VisitId | null
      mode: 'push' | 'replace'
      change: BaseChange
      answer: Answer
      interstitial: boolean
      initial: boolean
    }
  | { type: 'baseSwapped' }
  /** Fired by LayerPage.write after the component resolved, before the history write. */
  | { type: 'layerCommitting'; id: LayerId; requestedReplace: boolean; urlChanged: boolean }
  /** A layer's view changed (swap, optimistic props, flash). */
  | { type: 'layerSwapped'; id: LayerId }
  /** Every popstate after decrypt and the 3.x version check. `entry.layers` is empty for a plain entry. */
  | { type: 'popstate'; entry: EntryFacts }
  /** The browser refused the push `id` was charged for. */
  | { type: 'writeRefused'; id: LayerId }
  /** A popstate with no state: the browser pushed an entry itself (an in-page anchor). */
  | { type: 'anchored' }
  | { type: 'unwindSettled'; token: Token; how: 'answered' | 'timeout' }
  | { type: 'closeRequested'; target: LayerId | 'top'; close: CloseId; waiter: WaiterId }
  /** The shell's exit finished. */
  | { type: 'exited'; id: LayerId }

export type VisitTag =
  | { readonly kind: 'open'; readonly request: LayerId }
  | { readonly kind: 'fetchBase' }
  | { readonly kind: 'refresh'; readonly close: CloseId }
  | { readonly kind: 'recover' }

export type StackEffect =
  /** Publish views to the adapters. Emitted only while the gate is open; otherwise `paint.owed`. */
  | { type: 'paint' }
  /**
   * history.writeEntry(the live composite, its address, mode). `charged` is the row that counted this
   * push; a push the browser refuses comes back as `writeRefused` for it.
   */
  | { type: 'writeEntry'; mode: 'push' | 'replace'; charged?: LayerId }
  /** 3.x is about to push the base page. `charged` counted that push, and gets it back if the browser refuses it. */
  | { type: 'watchBasePush'; charged: LayerId }
  | { type: 'historyGo'; delta: number; token: Token }
  /** A visit the stack starts itself: through the base router (fetchBase, recover) or a reload on the router of the page or layer beneath (refresh). */
  | { type: 'startVisit'; tag: VisitTag; via: Owner; url: string | null }
  /** currentPage.set(page from source, { replace: mode === 'replace', visitId: String(token) }). */
  | { type: 'installBase'; token: Token; source: InstallSource; mode: 'push' | 'replace' }
  /** The blank base takes the url fetched next, so the loading resolver is asked about that page. */
  | { type: 'setBlankUrl'; url: string }
  /** Keep the outgoing base page under `token`. Runs inside baseCommitting, before the write. */
  | { type: 'holdBase'; token: Token }
  | { type: 'releaseBase'; token: Token }
  /** instance.dispose(): scope.disposed is true at once, its view leaves at the next paint. */
  | { type: 'dispose'; ids: readonly LayerId[]; reason: 'closed' | 'navigated' | 'restored-away' }
  /** Recreate rows from the entry the runtime is holding, with no request. */
  | { type: 'reopen'; ids: readonly LayerId[] }
  /** instance.page.setQuietly(the entry's layer page). */
  | { type: 'rewind'; ids: readonly LayerId[] }
  | { type: 'settle'; waiters: readonly WaiterId[]; result: 'closed' | 'abandoned' }
  /** The handle of a request that never landed fires onClose. */
  | { type: 'refuse'; request: LayerId }
  | { type: 'cancelAll' }
  | { type: 'warn'; message: string }

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
  /** Re-bind to the origin layer with its own page plus the response's errors and flash. */
  | { kind: 'handback'; id: LayerId }
  /** Server close: no set, the response succeeds against the page beneath. */
  | { kind: 'close'; id: LayerId; beneath: Owner }
  /** A blank base plus a standalone layer, then the fetch of its declared base. */
  | { kind: 'cold'; id: LayerId }
  /** The base set aside for the prompt comes back with the layer on it. */
  | { kind: 'return'; id: LayerId }
  /** The fetched page becomes the base, `layer` mark stripped. */
  | { kind: 'fetched-base' }
  /** The fetched page is itself a layer with a base: it goes beneath, and its base is fetched next. */
  | { kind: 'fetched-beneath'; id: LayerId }

export type CommitDecision = { kind: 'skip' } | { kind: 'write'; mode: 'push' | 'replace' } | { kind: 'none' }

export type RestoreOutcome =
  /** 3.x runs untouched. */
  | { kind: 'pass' }
  /** 3.x restores the base view (the entry minus `layers`); the stack applied its rows beside it. */
  | { kind: 'base' }
  /** The stack handled the entry; 3.x does nothing more. */
  | { kind: 'handled' }

export type Outcome =
  | { kind: 'none' }
  | { kind: 'landing'; landing: Landing }
  | { kind: 'commit'; decision: CommitDecision }
  | { kind: 'restore'; restore: RestoreOutcome }
  /** The layer whose url takes the browser's hash, or null when it is the base's. */
  | { kind: 'anchor'; owner: LayerId | null }

export interface Step {
  readonly state: StackState
  readonly effects: readonly StackEffect[]
  readonly outcome: Outcome
}

export const initialState: StackState = {
  nextToken: 1,
  base: { blank: false, gen: 0 },
  rows: [],
  dismissed: [],
  closes: new Map(),
  openRequests: new Map(),
  ops: new Map(),
  baseFetch: null,
  interstitial: null,
  expect: null,
  paint: { gated: false, owed: false },
}

/** True when nothing layer-related exists: the layerless fast path checks this before building any input. */
export function idle(s: StackState): boolean {
  return (
    s.rows.length === 0 &&
    s.dismissed.length === 0 &&
    s.closes.size === 0 &&
    s.openRequests.size === 0 &&
    s.ops.size === 0 &&
    s.baseFetch === null &&
    s.interstitial === null &&
    s.expect === null &&
    !s.base.blank
  )
}
