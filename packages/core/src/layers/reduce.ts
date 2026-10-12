// reduce(state, event) -> { state, effects, outcome }. Pure and total: an event naming something gone
// (row, op, token, close) is a no-op with no effects, never a throw. Ids come in on events and tokens
// from state.nextToken. The only writer of StackState. Responses are handled in route.ts, commits in
// commit.ts, closing in close.ts, history restores in restore.ts, and update.ts holds what they share.

import { closeRequested, completeUnwind, exited, finishClose } from './close'
import { anchored, baseCommitting, baseSwapped, layerCommitting } from './commit'
import { popstate, restoredOnLoad } from './restore'
import { responseArrived } from './route'
import type { LayerRow, Op, StackEvent, StackState, Step } from './state'
import {
  assertNever,
  mint,
  only,
  openingRow,
  paint,
  put,
  row,
  run,
  setRow,
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
    case 'placeholderOpened':
      return placeholderOpened(s, e)
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
    case 'anchored':
      return anchored(s)
    case 'writeRefused':
      return run(s, (t) => {
        const charged = row(t, e.id)

        // An entry the browser refused to write is not one a close should step back over.
        return charged ? setRow(t, { ...charged, entries: Math.max(0, charged.entries - 1) }) : t
      })
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
    walk: e.blank && e.walkTo !== null ? { target: e.walkTo, visit: null, startOnSwap: true } : null,
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
    const out = [...t.ops.values()].some((op) => op.kind === 'open' && op.ticket === e.ticket)

    if (!t.tickets.has(e.ticket) || out) {
      return t
    }

    fx.push({ type: 'refuse', ticket: e.ticket })

    return { ...t, tickets: without(t.tickets, e.ticket) }
  })
}

function placeholderOpened(s: StackState, e: E<'placeholderOpened'>): Step {
  const ticket = s.tickets.get(e.ticket)

  if (!ticket || row(s, ticket.id)) {
    return only(s)
  }

  const owner = ticket.owner === 'base' || row(s, ticket.owner) ? ticket.owner : 'base'

  return only({
    ...s,
    tickets: without(s.tickets, ticket.id),
    rows: [...s.rows, openingRow(ticket.id, ticket.id, owner, { ownsAddress: e.ownsAddress })],
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
      paint: { gated: true, owed: true },
    }
  }

  fx.push({ type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: target })

  return t
}
