// State-update primitives the pure handlers share. Each helper of the shape (s, fx, ...) => s appends
// the effects it needs to `fx` in the order the runtime runs them.

import type {
  CloseRow,
  LayerId,
  LayerRow,
  Outcome,
  Owner,
  StackEffect,
  StackEvent,
  StackState,
  Step,
  Token,
} from './state'

export type E<T extends StackEvent['type']> = Extract<StackEvent, { type: T }>
export type Fx = StackEffect[]

const none = { kind: 'none' } as const

export function only(s: StackState): Step {
  return { state: s, effects: [], outcome: none }
}

export function run(s: StackState, body: (s: StackState, fx: Fx) => StackState, outcome: Outcome = none): Step {
  const fx: Fx = []
  const state = body(s, fx)

  return { state, effects: fx, outcome }
}

/** Drop every row, ghost, close and the pin: the base page they stood on is gone. */
export function clearStack(s: StackState, fx: Fx, reason: 'navigated' | 'restored-away'): StackState {
  const ids = [...s.rows.map((r) => r.id), ...s.ghosts]

  if (ids.length > 0) {
    fx.push({ type: 'dispose', ids, reason })
  }

  const t = clearPin(settleAll(s, fx, 'closed'), fx, reason)

  return { ...t, rows: [], ghosts: [], closes: new Map(), expect: null, walk: null }
}

export function settleAll(s: StackState, fx: Fx, result: 'closed' | 'abandoned'): StackState {
  const waiters = [...s.closes.values()].flatMap((c) => c.waiters)

  if (waiters.length > 0) {
    fx.push({ type: 'settle', waiters, result })
  }

  return { ...s, closes: new Map() }
}

/** The pin dies on any popstate and any navigation: its rows go, its ticket is refused. */
export function clearPin(s: StackState, fx: Fx, reason: 'navigated' | 'restored-away'): StackState {
  const pin = s.pin

  if (!pin) {
    return s
  }

  if (pin.suspended.length > 0) {
    fx.push({ type: 'dispose', ids: pin.suspended.map((r) => r.id), reason })
  }

  let t: StackState = { ...s, pin: null }

  if (pin.ticket && t.tickets.has(pin.ticket)) {
    fx.push({ type: 'refuse', ticket: pin.ticket })
    t = { ...t, tickets: without(t.tickets, pin.ticket) }
  }

  fx.push({ type: 'releasePin', token: pin.token })

  return t
}

/** Rows without `ids`; a remaining row owned by a removed one is owned by that row's owner instead. */
export function withoutRows(rows: readonly LayerRow[], ids: readonly LayerId[]): LayerRow[] {
  const owners = new Map(rows.map((r) => [r.id, r.owner]))
  const resolve = (owner: Owner): Owner => {
    while (owner !== 'base' && ids.includes(owner)) {
      owner = owners.get(owner) ?? 'base'
    }

    return owner
  }

  return rows
    .filter((r) => !ids.includes(r.id))
    .map((r) => (ids.includes(r.owner as LayerId) ? { ...r, owner: resolve(r.owner) } : r))
}

/** A routed row whose first commit is pending. */
export function openingRow(id: LayerId, key: string, owner: Owner, overrides: Partial<LayerRow> = {}): LayerRow {
  return {
    id,
    type: 'routed',
    key,
    owner,
    phase: 'opening',
    standalone: false,
    ownsAddress: true,
    entries: 0,
    renderKey: 0,
    close: null,
    ...overrides,
  }
}

/** The nearest routed tier below `id`, else the base. */
export function beneath(rows: readonly LayerRow[], id: LayerId): Owner {
  const index = rows.findIndex((row) => row.id === id)

  return (
    rows
      .slice(0, index)
      .filter((row) => row.type === 'routed')
      .at(-1)?.id ?? 'base'
  )
}

export function paint(s: StackState, fx: Fx): StackState {
  if (s.paint.gated) {
    return { ...s, paint: { ...s.paint, owed: true } }
  }

  if (!fx.some((effect) => effect.type === 'paint')) {
    fx.push({ type: 'paint' })
  }

  return s
}

export function mint(s: StackState): [Token, StackState] {
  return [s.nextToken as Token, { ...s, nextToken: s.nextToken + 1 }]
}

export function row(s: StackState, id: LayerId): LayerRow | undefined {
  return s.rows.find((r) => r.id === id)
}

export function setRow(s: StackState, next: LayerRow): StackState {
  return { ...s, rows: s.rows.map((r) => (r.id === next.id ? next : r)) }
}

export function setClose(s: StackState, next: CloseRow): StackState {
  return { ...s, closes: put(s.closes, next.id, next) }
}

export function put<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  return new Map(map).set(key, value)
}

export function without<K, V>(map: ReadonlyMap<K, V>, key: K): Map<K, V> {
  const next = new Map(map)

  next.delete(key)

  return next
}

export function assertNever(x: never): never {
  throw new Error(`Unhandled stack event: ${JSON.stringify(x)}`)
}
