// reduce(state, event) -> { state, effects, outcome }. Pure and total: an event naming something gone
// (row, op, token, close) is a no-op with no effects, never a throw. Ids come in on events and tokens
// from state.nextToken. The only writer of StackState. The closing handlers live in close.ts, the
// history restore handlers in restore.ts, and the helpers they all share in update.ts.

import {
  abandonIfExiting,
  closeRequested,
  completeUnwind,
  exited,
  finishClose,
  forgetInCloses,
  startClose,
  startQueued,
} from './close'
import { popstate, restoredOnLoad } from './restore'
import { classify } from './route'
import type { LayerId, LayerRow, Op, Owner, StackEvent, StackState, Step } from './state'
import { MAX_WALK } from './state'
import {
  assertNever,
  clearStack,
  mint,
  only,
  paint,
  put,
  row,
  run,
  setRow,
  settleAll,
  without,
  withoutRows,
  type E,
  type Fx,
} from './update'

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
