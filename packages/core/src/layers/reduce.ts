// reduce(state, event) -> { state, effects, outcome }. Pure and total: an event naming something gone
// (row, op, token, close) is a no-op with no effects, never a throw. Ids come in on events and tokens
// from state.nextToken. The only writer of StackState.
//
// Handlers thread one state through helpers of the shape (s, fx, ...) => s, which append the effects
// they need to `fx` in the order the runtime runs them.

import { planRestore } from './restore'
import { beneath, classify } from './route'
import type {
  CloseId,
  CloseRow,
  EntryLayerFacts,
  LayerId,
  LayerRow,
  Op,
  Outcome,
  Owner,
  StackEffect,
  StackEvent,
  StackState,
  Step,
  Token,
  WaiterId,
} from './state'
import { MAX_WALK } from './state'

type E<T extends StackEvent['type']> = Extract<StackEvent, { type: T }>
type Fx = StackEffect[]

const none = { kind: 'none' } as const

export function reduce(s: StackState, e: StackEvent): Step {
  switch (e.type) {
    case 'booted':
      return booted(s, e)
    case 'restoredOnLoad':
      return restoredOnLoad(s, e)
    case 'openRequested':
      return openRequested(s, e)
    case 'openRefused':
      return openRefused(s, e)
    case 'localOpened':
      return localOpened(s, e)
    case 'visitDispatched':
      return visitDispatched(s, e)
    case 'visitFinished':
      return visitFinished(s, e)
    case 'walkHopFailed':
      return run(s, (t, fx) => (t.walk?.visit === e.visit ? walkFailed(t, fx) : t))
    case 'responseArrived':
      return responseArrived(s, e)
    case 'baseCommitting':
      return baseCommitting(s, e)
    case 'baseSwapped':
      return baseSwapped(s)
    case 'layerCommitting':
      return layerCommitting(s, e)
    case 'layerSwapped':
      return run(s, (t, fx) => (row(t, e.id) || t.ghosts.includes(e.id) ? paint(t, fx) : t))
    case 'popstate':
      return popstate(s, e)
    case 'unwindSettled':
      return run(s, (t, fx) =>
        t.expect?.kind === 'unwind' && t.expect.token === e.token ? completeUnwind(t, fx, t.expect.close) : t,
      )
    case 'closeRequested':
      return closeRequested(s, e)
    case 'exited':
      return exited(s, e)
    default:
      return assertNever(e)
  }
}

function only(s: StackState): Step {
  return { state: s, effects: [], outcome: none }
}

function run(s: StackState, body: (s: StackState, fx: Fx) => StackState, outcome: Outcome = none): Step {
  const fx: Fx = []
  const state = body(s, fx)

  return { state, effects: fx, outcome }
}

// ---------------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------------

function booted(s: StackState, e: E<'booted'>): Step {
  const rows = e.seeds.map((seed): LayerRow => ({ ...seed, phase: 'open', close: null, renderKey: 0 }))

  return only({
    ...s,
    rows,
    base: { ...s.base, blank: e.blank },
    walk: e.blank && e.walkTo !== null ? { target: e.walkTo, hops: 1, visit: null, startOnSwap: true } : null,
    paint: { gated: true, owed: rows.length > 0 },
  })
}

/** Document load onto a composite entry (Back or Forward into the app). Replaces the boot rows. */
function restoredOnLoad(s: StackState, e: E<'restoredOnLoad'>): Step {
  return run(s, (t, fx) => {
    t = clearStack(t, fx, 'restored-away')

    const rows = fromEntry([], e.entry.layers)

    if (rows.length > 0) {
      fx.push({ type: 'reopen', ids: rows.map((r) => r.id) })
    }

    if (e.entry.blank) {
      fx.push({ type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: e.entry.url })
    }

    return { ...t, rows, base: { ...t.base, blank: e.entry.blank }, paint: { gated: true, owed: true } }
  })
}

// ---------------------------------------------------------------------------------------------------
// Tickets and tagged visits
// ---------------------------------------------------------------------------------------------------

function openRequested(s: StackState, e: E<'openRequested'>): Step {
  if (s.tickets.has(e.ticket) || row(s, e.ticket)) {
    return only(s)
  }

  return only({ ...s, tickets: put(s.tickets, e.ticket, { id: e.ticket, owner: e.owner, state: 'pending' }) })
}

function openRefused(s: StackState, e: E<'openRefused'>): Step {
  return run(s, (t, fx) => {
    if (t.tickets.get(e.ticket)?.state !== 'pending') {
      return t
    }

    fx.push({ type: 'refuse', ticket: e.ticket })

    return { ...t, tickets: without(t.tickets, e.ticket) }
  })
}

function localOpened(s: StackState, e: E<'localOpened'>): Step {
  return run(s, (t) => {
    if (row(t, e.id) || t.ghosts.includes(e.id)) {
      return t
    }

    const local: LayerRow = {
      id: e.id,
      type: 'local',
      key: e.key,
      owner: e.owner === 'base' || row(t, e.owner) ? e.owner : 'base',
      phase: 'opening',
      standalone: false,
      ownsAddress: false,
      entries: 0,
      renderKey: 0,
      close: null,
    }

    return { ...t, rows: [...t.rows, local] }
  })
}

function visitDispatched(s: StackState, e: E<'visitDispatched'>): Step {
  const { tag } = e
  const known = s.ops.get(e.visit)
  let t = s

  if (!known) {
    if (tag.kind === 'open' && !s.tickets.has(tag.ticket)) {
      return only(s)
    }

    if (tag.kind === 'walk' && !s.walk) {
      return only(s)
    }

    if (tag.kind === 'refresh' && s.closes.get(tag.close)?.phase.kind !== 'refreshing') {
      return only(s)
    }
  }

  const op: Op = known
    ? { ...known, inFlight: known.inFlight + 1 }
    : tag.kind === 'open'
      ? { kind: 'open', ticket: tag.ticket, inFlight: 1 }
      : tag.kind === 'walk'
        ? { kind: 'walk', inFlight: 1, landed: false }
        : tag.kind === 'refresh'
          ? { kind: 'refresh', close: tag.close, inFlight: 1 }
          : { kind: 'recover', inFlight: 1 }

  t = { ...t, ops: put(t.ops, e.visit, op) }

  if (op.kind === 'open') {
    const ticket = t.tickets.get(op.ticket)

    if (ticket?.state === 'pending') {
      t = { ...t, tickets: put(t.tickets, ticket.id, { ...ticket, state: 'dispatched' }) }
    }
  }

  if (op.kind === 'walk' && t.walk) {
    t = { ...t, walk: { ...t.walk, visit: e.visit } }
  }

  if (op.kind === 'refresh') {
    const close = t.closes.get(op.close)

    if (close?.phase.kind === 'refreshing') {
      t = { ...t, closes: put(t.closes, close.id, { ...close, phase: { kind: 'refreshing', visit: e.visit } }) }
    }
  }

  return only(t)
}

function visitFinished(s: StackState, e: E<'visitFinished'>): Step {
  const op = s.ops.get(e.visit)

  if (!op) {
    return only(s)
  }

  if (op.inFlight > 1) {
    return only({ ...s, ops: put(s.ops, e.visit, { ...op, inFlight: op.inFlight - 1 }) })
  }

  return run({ ...s, ops: without(s.ops, e.visit) }, (t, fx) => {
    switch (op.kind) {
      case 'open': {
        const ticket = t.tickets.get(op.ticket)

        if (!ticket || t.pin?.ticket === ticket.id) {
          return t
        }

        fx.push({ type: 'refuse', ticket: ticket.id })

        return { ...t, tickets: without(t.tickets, ticket.id) }
      }
      case 'walk':
        return t.walk?.visit === e.visit && !op.landed ? walkFailed(t, fx) : t
      case 'refresh':
        return t.closes.get(op.close)?.phase.kind === 'refreshing' ? finishClose(t, fx, op.close) : t
      case 'recover':
        return t
      default:
        return assertNever(op)
    }
  })
}

/** A walk hop failed (no error overlay): promote the deepest layer to the page, or fetch the base again. */
function walkFailed(s: StackState, fx: Fx): StackState {
  const target = s.walk!.target
  const bottom = s.rows[0]
  const t: StackState = { ...s, walk: null }

  if (bottom && bottom.phase === 'open' && bottom.close === null && t.expect === null) {
    const [token, minted] = mint(t)

    fx.push({ type: 'installBase', token, source: { kind: 'promote', layer: bottom.id }, mode: 'replace' })

    return {
      ...minted,
      rows: withoutRows(minted.rows, [bottom.id]),
      expect: { kind: 'base', token, mode: 'replace', layer: bottom.id, source: { kind: 'promote', layer: bottom.id } },
      paint: { ...minted.paint, gated: true },
    }
  }

  fx.push({ type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: target })

  return t
}

// ---------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------

function responseArrived(s: StackState, e: E<'responseArrived'>): Step {
  const landing = classify(s, e)
  const outcome = { kind: 'landing', landing } as const
  const key = e.marks.layer?.key ?? ''
  const op = s.ops.get(e.visit)

  const capped = landing.kind === 'walk-base' && !!e.marks.layer?.base && !e.facts.cycles

  return run(
    s,
    (t, fx) => {
      if (capped) {
        fx.push({ type: 'warn', message: `A layer walk stopped after ${MAX_WALK} declared bases.` })
      }

      switch (landing.kind) {
        case 'pass':
        case 'drop':
        case 'base':
        case 'promote':
        case 'handback':
          return t
        case 'open':
          return bind(
            {
              ...t,
              rows: [...t.rows, opening(landing.id, key, landing.owner, { ownsAddress: !e.facts.preserveUrl })],
            },
            op,
          )
        case 'rewrite':
          return bind(rewrite(t, fx, landing, key), op)
        case 'refresh': {
          const target = row(t, landing.id)!

          if (!landing.remount) {
            return bind(t, op)
          }

          t = setRow(t, { ...target, renderKey: target.renderKey + 1 })

          return bind(abandonIfExiting(t, fx, target.close), op)
        }
        case 'close':
          return startClose(t, fx, landing.id, e.newClose, null)
        case 'cold': {
          t = clearStack(t, fx, 'navigated')

          const [token, minted] = mint(t)
          const url = e.marks.layer!.base!

          return bind(
            {
              ...minted,
              rows: [opening(landing.id, key, 'base', { standalone: true })],
              base: { blank: true, gen: minted.base.gen + 1 },
              walk: { target: url, hops: 1, visit: null, startOnSwap: true },
              expect: {
                kind: 'base',
                token,
                mode: e.facts.replace ? 'replace' : 'push',
                layer: landing.id,
                source: { kind: 'blank', url },
              },
              paint: { ...minted.paint, gated: true },
            },
            op,
          )
        }
        case 'return': {
          const pin = t.pin!
          const leftover = [...t.rows.map((r) => r.id), ...t.ghosts]

          if (leftover.length > 0) {
            fx.push({ type: 'dispose', ids: leftover, reason: 'navigated' })
          }

          t = settleAll(t, fx, 'closed')

          const [token, minted] = mint(t)
          const returning = opening(landing.id, key, pin.suspended.at(-1)?.id ?? 'base', {
            entries: pin.pushes,
            ownsAddress: !e.facts.preserveUrl,
          })
          const bound = { ...minted, tickets: without(minted.tickets, landing.id) }

          return {
            ...bound,
            rows: [...pin.suspended, returning],
            ghosts: [],
            pin: null,
            base: { ...bound.base, gen: bound.base.gen + 1 },
            expect: {
              kind: 'base',
              token,
              mode: 'replace',
              layer: landing.id,
              source: { kind: 'pinned', pin: pin.token },
            },
            paint: { ...bound.paint, gated: true },
          }
        }
        case 'walk-base':
          return landed(t, e)
        case 'walk-beneath': {
          const walk = t.walk!
          const target = e.marks.layer!.base!

          fx.push({ type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: target })

          return landed(
            {
              ...t,
              rows: [opening(landing.id, key, 'base', { standalone: true }), ...t.rows],
              walk: { target, hops: walk.hops + 1, visit: null, startOnSwap: false },
            },
            e,
          )
        }
        default:
          return assertNever(landing)
      }
    },
    outcome,
  )
}

function rewrite(
  s: StackState,
  fx: Fx,
  landing: Extract<ReturnType<typeof classify>, { kind: 'rewrite' }>,
  key: string,
): StackState {
  const target = row(s, landing.id)!
  const dismissed = s.rows.filter((r) => landing.dismissed.includes(r.id))
  const unseen = dismissed.filter((r) => r.phase === 'opening').map((r) => r.id)

  if (unseen.length > 0) {
    fx.push({ type: 'dispose', ids: unseen, reason: 'closed' })
  }

  let t: StackState = {
    ...s,
    rows: withoutRows(s.rows, landing.dismissed).map((r) =>
      r.id === target.id
        ? {
            ...r,
            key,
            entries: r.entries + dismissed.reduce((sum, gone) => sum + gone.entries, 0),
            renderKey: r.renderKey + (landing.remount ? 1 : 0),
          }
        : r,
    ),
    ghosts: [...s.ghosts, ...landing.dismissed.filter((id) => !unseen.includes(id))],
  }

  t = forgetInCloses(t, fx, landing.dismissed)

  if (landing.remount) {
    t = abandonIfExiting(t, fx, target.close)
  }

  return dismissed.length > 0 ? paint(t, fx) : t
}

function landed(s: StackState, e: E<'responseArrived'>): StackState {
  const op = s.ops.get(e.visit)

  return op?.kind === 'walk' ? { ...s, ops: put(s.ops, e.visit, { ...op, landed: true }) } : s
}

/** A ticket visit that landed on a row is done with its ticket: the landing names the row. */
function bind(s: StackState, op: Op | undefined): StackState {
  return op?.kind === 'open' && s.tickets.has(op.ticket) ? { ...s, tickets: without(s.tickets, op.ticket) } : s
}

function opening(id: LayerId, key: string, owner: Owner, overrides: Partial<LayerRow> = {}): LayerRow {
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

// ---------------------------------------------------------------------------------------------------
// The base: the explicit "base navigated" decision
// ---------------------------------------------------------------------------------------------------

/**
 * Made before the base history write: an install the stack asked for, a visit the stack follows, the
 * initial commit and a replace of the same page keep the stack; a prompt pins it; anything else drops
 * it. The gate holds the stack's paint until the base swaps, so both change in one frame.
 */
function baseCommitting(s: StackState, e: E<'baseCommitting'>): Step {
  return run(s, (t, fx) => {
    t = { ...t, paint: { ...t.paint, gated: true } }

    const expect = t.expect

    if (expect?.kind === 'base' && e.visit !== null && String(expect.token) === e.visit) {
      t = { ...t, expect: null }

      if (expect.source.kind === 'pinned') {
        fx.push({ type: 'releasePin', token: expect.source.pin })
        t = { ...t, base: { ...t.base, blank: false } }
      }

      if (expect.source.kind === 'promote') {
        fx.push({ type: 'dispose', ids: [expect.source.layer], reason: 'closed' })
        t = { ...t, base: { ...t.base, blank: false } }
      }

      return startQueued(t, fx)
    }

    const op = e.visit === null ? undefined : t.ops.get(e.visit)

    if (op?.kind === 'walk' && op.landed) {
      return { ...t, base: { ...t.base, blank: false }, walk: null }
    }

    if (op?.kind === 'recover') {
      return { ...t, base: { ...t.base, blank: false }, walk: null }
    }

    if (op?.kind === 'refresh' || e.initial) {
      return t
    }

    if (e.interstitial && !t.base.blank) {
      return pinned(t, fx, e, op)
    }

    if (e.mode === 'replace' && e.sameAsLive) {
      return t
    }

    const dropped = t.rows.length > 0 || t.ghosts.length > 0

    t = clearStack(t, fx, 'navigated')

    return { ...t, base: { blank: false, gen: t.base.gen + 1 }, paint: { gated: true, owed: t.paint.owed || dropped } }
  })
}

/** An interstitial prompt replaces the screen: the live rows wait in the pin for the layer it leads to. */
function pinned(s: StackState, fx: Fx, e: E<'baseCommitting'>, op: Op | undefined): StackState {
  const push = e.mode === 'push' ? 1 : 0
  const gen = s.base.gen + 1

  if (s.pin) {
    return { ...s, pin: { ...s.pin, gen, pushes: s.pin.pushes + push }, base: { ...s.base, gen } }
  }

  const [token, minted] = mint(s)

  fx.push({ type: 'capturePin', token })

  const closing = minted.rows.filter((r) => r.close !== null || r.phase === 'opening').map((r) => r.id)
  const gone = [...closing, ...minted.ghosts]

  if (gone.length > 0) {
    fx.push({ type: 'dispose', ids: gone, reason: 'navigated' })
  }

  const t = settleAll(minted, fx, 'closed')
  const owed = t.rows.length > 0 || t.ghosts.length > 0

  return {
    ...t,
    rows: [],
    ghosts: [],
    closes: new Map(),
    expect: t.expect?.kind === 'unwind' ? null : t.expect,
    pin: {
      token,
      gen,
      pushes: push,
      ticket: op?.kind === 'open' ? op.ticket : null,
      suspended: withoutRows(t.rows, closing),
    },
    base: { ...t.base, gen },
    paint: { gated: true, owed: t.paint.owed || owed },
  }
}

function baseSwapped(s: StackState): Step {
  return run(s, (t, fx) => {
    if (t.paint.gated || t.paint.owed) {
      if (t.paint.owed) {
        fx.push({ type: 'paint' })
      }

      t = { ...t, paint: { gated: false, owed: false } }
    }

    const installing = t.expect?.kind === 'base' && t.expect.source.kind === 'blank'

    if (t.walk?.startOnSwap && !installing) {
      fx.push({ type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: t.walk.target })
      t = { ...t, walk: { ...t.walk, startOnSwap: false } }
    }

    return t
  })
}

// ---------------------------------------------------------------------------------------------------
// Layer commits: push, replace or none, charged to the committing row
// ---------------------------------------------------------------------------------------------------

function layerCommitting(s: StackState, e: E<'layerCommitting'>): Step {
  const target = row(s, e.id)

  if (!target) {
    return { state: s, effects: [], outcome: { kind: 'commit', decision: { kind: 'skip' } } }
  }

  const expect = s.expect

  if (expect?.kind === 'base' && expect.layer === e.id && expect.source.kind !== 'promote') {
    const decision = { kind: 'commit', decision: { kind: 'none' } } as const

    if (target.phase === 'open') {
      return { state: s, effects: [], outcome: decision }
    }

    return run(
      setRow(s, { ...target, phase: 'open' }),
      (t, fx) => {
        fx.push({ type: 'installBase', token: expect.token, source: expect.source, mode: expect.mode })

        return t
      },
      decision,
    )
  }

  const mode =
    target.phase === 'opening'
      ? target.standalone || e.requestedReplace
        ? 'replace'
        : 'push'
      : e.urlChanged && !e.requestedReplace
        ? 'push'
        : 'replace'

  return run(
    setRow(s, { ...target, phase: 'open', entries: target.entries + (mode === 'push' ? 1 : 0) }),
    (t, fx) => {
      fx.push({ type: 'writeEntry', mode })

      return t
    },
    { kind: 'commit', decision: { kind: 'write', mode } },
  )
}

// ---------------------------------------------------------------------------------------------------
// History restore
// ---------------------------------------------------------------------------------------------------

function popstate(s: StackState, e: E<'popstate'>): Step {
  const fx: Fx = []
  let t = clearPin(s, fx, 'restored-away')

  if (t.expect?.kind === 'unwind') {
    t = completeUnwind(t, fx, t.expect.close)

    return { state: t, effects: fx, outcome: { kind: 'restore', restore: { kind: 'handled' } } }
  }

  const plan = planRestore(t, e.entry)

  if (plan.kind === 'pass') {
    return { state: t, effects: fx, outcome: { kind: 'restore', restore: { kind: 'pass' } } }
  }

  if (plan.kind === 'recover') {
    fx.push({ type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: plan.url })

    return {
      state: { ...t, base: { blank: true, gen: t.base.gen + 1 }, paint: { ...t.paint, gated: true } },
      effects: fx,
      outcome: { kind: 'restore', restore: { kind: 'base' } },
    }
  }

  const reopened = new Set(plan.reopen)
  const lingering = t.ghosts.filter((id) => reopened.has(id))
  const gone = [...plan.drop, ...lingering]

  if (gone.length > 0) {
    fx.push({ type: 'dispose', ids: gone, reason: 'restored-away' })
  }

  t = forgetInCloses(t, fx, [...plan.drop, ...(plan.dismiss ? [plan.dismiss] : [])])
  t = {
    ...t,
    rows: withoutRows(t.rows, [...plan.drop, ...(plan.dismiss ? [plan.dismiss] : [])]),
    ghosts: [...t.ghosts.filter((id) => !reopened.has(id)), ...(plan.dismiss ? [plan.dismiss] : [])],
  }

  const entering = fromEntry(
    t.rows,
    e.entry.layers.filter((layer) => reopened.has(layer.id)),
  )

  t = { ...t, rows: [...t.rows, ...entering] }

  if (plan.rewind.length > 0) {
    fx.push({ type: 'rewind', ids: plan.rewind })
  }

  if (entering.length > 0) {
    fx.push({ type: 'reopen', ids: entering.map((r) => r.id) })
  }

  if (plan.base) {
    if (e.entry.blank) {
      fx.push({ type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: e.entry.url })
    }

    return {
      state: {
        ...t,
        base: { blank: e.entry.blank, gen: t.base.gen + 1 },
        walk: e.entry.blank ? t.walk : null,
        paint: { gated: true, owed: true },
      },
      effects: fx,
      outcome: { kind: 'restore', restore: { kind: 'base' } },
    }
  }

  fx.push({ type: 'cancelAll' })

  return { state: paint(t, fx), effects: fx, outcome: { kind: 'restore', restore: { kind: 'handled' } } }
}

function fromEntry(below: readonly LayerRow[], layers: readonly EntryLayerFacts[]): LayerRow[] {
  const rows: LayerRow[] = []

  for (const layer of layers) {
    const known = [...below, ...rows].some((r) => r.id === layer.owner)

    rows.push({
      id: layer.id,
      type: layer.type,
      key: layer.key,
      owner: layer.owner === 'base' || known ? layer.owner : 'base',
      phase: 'open',
      standalone: layer.standalone,
      ownsAddress: layer.ownsAddress,
      entries: layer.entries,
      renderKey: 0,
      close: null,
    })
  }

  return rows
}

// ---------------------------------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------------------------------

function closeRequested(s: StackState, e: E<'closeRequested'>): Step {
  return run(s, (t, fx) => {
    const id = e.target === 'top' ? t.rows.filter((r) => r.phase === 'open').at(-1)?.id : e.target

    if (!id || !row(t, id)) {
      fx.push({ type: 'settle', waiters: [e.waiter], result: 'closed' })

      return t
    }

    return startClose(t, fx, id, e.close, e.waiter)
  })
}

/**
 * Start or join a close of `id` and every row above it. Each close is its own record: a wider close
 * adopts the exiting ones it covers (their waiters and exits), and closes already past their exit
 * keep their place in the queue.
 */
function startClose(s: StackState, fx: Fx, id: LayerId, closeId: CloseId, waiter: WaiterId | null): StackState {
  const covered = s.rows.slice(s.rows.findIndex((r) => r.id === id))
  const touched = [...new Set(covered.map((r) => r.close).filter((c): c is CloseId => c !== null))].map((c) =>
    s.closes.get(c)!,
  )
  const adopted = touched.filter((c) => c.phase.kind === 'exiting')
  const settled = touched.filter((c) => c.phase.kind !== 'exiting')
  const free = covered.filter((r) => r.close === null)
  const waiters = waiter ? [waiter] : []

  if (free.length === 0 && adopted.length + settled.length === 1) {
    const joined = touched[0]

    return { ...s, closes: put(s.closes, joined.id, { ...joined, waiters: [...joined.waiters, ...waiters] }) }
  }

  if (free.length === 0 && adopted.length === 0) {
    const last = [...s.closes.values()].filter((c) => settled.includes(c)).at(-1)!

    return { ...s, closes: put(s.closes, last.id, { ...last, waiters: [...last.waiters, ...waiters] }) }
  }

  const ids = new Set([...free.map((r) => r.id), ...adopted.flatMap((c) => c.layers)])
  const close: CloseRow = {
    id: closeId,
    layers: s.rows.filter((r) => ids.has(r.id)).map((r) => r.id),
    exited: [...adopted.flatMap((c) => c.exited), ...free.filter((r) => r.phase === 'opening').map((r) => r.id)],
    waiters: [...adopted.flatMap((c) => c.waiters), ...waiters],
    phase: { kind: 'exiting' },
  }

  let closes = new Map(s.closes)

  adopted.forEach((c) => closes.delete(c.id))
  closes = put(closes, close.id, close)

  const t = paint(
    {
      ...s,
      closes,
      rows: s.rows.map((r) => (ids.has(r.id) ? { ...r, close: close.id } : r)),
    },
    fx,
  )

  return progress(t, fx, close.id)
}

function exited(s: StackState, e: E<'exited'>): Step {
  return run(s, (t, fx) => {
    if (t.ghosts.includes(e.id)) {
      fx.push({ type: 'dispose', ids: [e.id], reason: 'closed' })

      return paint({ ...t, ghosts: t.ghosts.filter((id) => id !== e.id) }, fx)
    }

    const close = t.closes.get(row(t, e.id)?.close as CloseId)

    if (!close || close.phase.kind !== 'exiting' || close.exited.includes(e.id)) {
      return t
    }

    return progress(
      { ...t, closes: put(t.closes, close.id, { ...close, exited: [...close.exited, e.id] }) },
      fx,
      close.id,
    )
  })
}

/** An exiting close whose every shell has exited moves on, or queues behind the expectation in flight. */
function progress(s: StackState, fx: Fx, closeId: CloseId): StackState {
  const close = s.closes.get(closeId)

  if (!close || close.phase.kind !== 'exiting' || !close.layers.every((id) => close.exited.includes(id))) {
    return s
  }

  return s.expect === null ? removeOrUnwind(s, fx, close) : setClose(s, { ...close, phase: { kind: 'queued' } })
}

function removeOrUnwind(s: StackState, fx: Fx, close: CloseRow): StackState {
  const covered = s.rows.filter((r) => close.layers.includes(r.id))
  const entries = covered.reduce((sum, r) => sum + r.entries, 0)

  if (covered.length === 0) {
    return finishClose(s, fx, close.id)
  }

  if (covered[0].standalone || entries === 0) {
    const t = { ...s, rows: withoutRows(s.rows, close.layers) }

    fx.push({ type: 'writeEntry', mode: covered[0].standalone ? 'push' : 'replace' })

    return continueAfterRemoval(paint(t, fx), fx, close, covered[0], s.rows)
  }

  const [token, minted] = mint(s)

  fx.push({ type: 'historyGo', delta: -entries, token })

  return {
    ...setClose(minted, { ...close, phase: { kind: 'unwinding', token } }),
    expect: { kind: 'unwind', close: close.id, token },
  }
}

/** The browser answered our history.go (or timed out): the covered rows leave the model. */
function completeUnwind(s: StackState, fx: Fx, closeId: CloseId): StackState {
  const close = s.closes.get(closeId)!
  const covered = s.rows.filter((r) => close.layers.includes(r.id))
  const t = { ...s, expect: null, rows: withoutRows(s.rows, close.layers) }

  fx.push({ type: 'writeEntry', mode: 'replace' })

  return startQueued(continueAfterRemoval(paint(t, fx), fx, close, covered[0], s.rows), fx)
}

/** Refresh the routed tier beneath when the closed bottom row was routed and that tier is real. */
function continueAfterRemoval(
  s: StackState,
  fx: Fx,
  close: CloseRow,
  bottom: LayerRow | undefined,
  before: readonly LayerRow[],
): StackState {
  const via = bottom ? beneath(before, bottom.id) : 'base'
  const refreshes = bottom?.type === 'routed' && !(via === 'base' && s.base.blank)

  if (!refreshes) {
    return finishClose(s, fx, close.id)
  }

  fx.push({ type: 'startVisit', tag: { kind: 'refresh', close: close.id }, via, url: null })

  return setClose(s, { ...close, phase: { kind: 'refreshing', visit: null } })
}

function finishClose(s: StackState, fx: Fx, closeId: CloseId): StackState {
  const close = s.closes.get(closeId)!

  fx.push({ type: 'dispose', ids: [...close.layers].reverse(), reason: 'closed' })

  if (close.waiters.length > 0) {
    fx.push({ type: 'settle', waiters: close.waiters, result: 'closed' })
  }

  return startQueued({ ...s, closes: without(s.closes, closeId) }, fx)
}

function startQueued(s: StackState, fx: Fx): StackState {
  let t = s
  let next: CloseRow | undefined

  while (t.expect === null && (next = [...t.closes.values()].find((c) => c.phase.kind === 'queued'))) {
    t = removeOrUnwind(t, fx, next)
  }

  return t
}

/** A remounting landing on a row whose close is still exiting puts the covered rows back. */
function abandonIfExiting(s: StackState, fx: Fx, closeId: CloseId | null): StackState {
  const close = closeId ? s.closes.get(closeId) : undefined

  if (!close || close.phase.kind !== 'exiting') {
    return s
  }

  if (close.waiters.length > 0) {
    fx.push({ type: 'settle', waiters: close.waiters, result: 'abandoned' })
  }

  return paint(
    {
      ...s,
      closes: without(s.closes, close.id),
      rows: s.rows.map((r) => (r.close === close.id ? { ...r, close: null } : r)),
    },
    fx,
  )
}

/** Rows that left the model outside their close (dismissed, dropped) leave it; an emptied close settles. */
function forgetInCloses(s: StackState, fx: Fx, ids: readonly LayerId[]): StackState {
  let t = s

  for (const close of s.closes.values()) {
    if (!close.layers.some((id) => ids.includes(id)) || close.phase.kind === 'refreshing') {
      continue
    }

    const layers = close.layers.filter((id) => !ids.includes(id))

    if (layers.length === 0) {
      if (close.waiters.length > 0) {
        fx.push({ type: 'settle', waiters: close.waiters, result: 'closed' })
      }

      t = {
        ...t,
        closes: without(t.closes, close.id),
        expect: t.expect?.kind === 'unwind' && t.expect.close === close.id ? null : t.expect,
      }
      continue
    }

    t = progress(
      setClose(t, { ...close, layers, exited: close.exited.filter((id) => !ids.includes(id)) }),
      fx,
      close.id,
    )
  }

  return t
}

// ---------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------

/** Drop every row, ghost, close and the pin: the base page they stood on is gone. */
function clearStack(s: StackState, fx: Fx, reason: 'navigated' | 'restored-away'): StackState {
  const ids = [...s.rows.map((r) => r.id), ...s.ghosts]

  if (ids.length > 0) {
    fx.push({ type: 'dispose', ids, reason })
  }

  const t = clearPin(settleAll(s, fx, 'closed'), fx, reason)

  return { ...t, rows: [], ghosts: [], closes: new Map(), expect: null, walk: null }
}

function settleAll(s: StackState, fx: Fx, result: 'closed' | 'abandoned'): StackState {
  const waiters = [...s.closes.values()].flatMap((c) => c.waiters)

  if (waiters.length > 0) {
    fx.push({ type: 'settle', waiters, result })
  }

  return { ...s, closes: new Map() }
}

/** The pin dies on any popstate and any navigation: its rows go, its ticket is refused. */
function clearPin(s: StackState, fx: Fx, reason: 'navigated' | 'restored-away'): StackState {
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
function withoutRows(rows: readonly LayerRow[], ids: readonly LayerId[]): LayerRow[] {
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

function paint(s: StackState, fx: Fx): StackState {
  if (s.paint.gated) {
    return { ...s, paint: { ...s.paint, owed: true } }
  }

  if (!fx.some((effect) => effect.type === 'paint')) {
    fx.push({ type: 'paint' })
  }

  return s
}

function mint(s: StackState): [Token, StackState] {
  return [s.nextToken as Token, { ...s, nextToken: s.nextToken + 1 }]
}

function row(s: StackState, id: LayerId): LayerRow | undefined {
  return s.rows.find((r) => r.id === id)
}

function setRow(s: StackState, next: LayerRow): StackState {
  return { ...s, rows: s.rows.map((r) => (r.id === next.id ? next : r)) }
}

function setClose(s: StackState, next: CloseRow): StackState {
  return { ...s, closes: put(s.closes, next.id, next) }
}

function put<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  return new Map(map).set(key, value)
}

function without<K, V>(map: ReadonlyMap<K, V>, key: K): Map<K, V> {
  const next = new Map(map)

  next.delete(key)

  return next
}

function assertNever(x: never): never {
  throw new Error(`Unhandled stack event: ${JSON.stringify(x)}`)
}
