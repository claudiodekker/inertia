// Where a response lands, and what that landing does to the stack.

import { abandonIfExiting, forgetInCloses, startClose } from './close'
import {
  MAX_LAYER_CHAIN,
  type Landing,
  type LayerId,
  type LayerRow,
  type Op,
  type StackState,
  type Step,
} from './state'
import {
  assertNever,
  beneath,
  clearStack,
  mint,
  openingRow,
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

/** Where a response lands. First match wins. */
export function classify(s: StackState, e: E<'responseArrived'>): Landing {
  const { origin, marks, facts } = e
  const op = s.ops.get(e.visit)
  const isRefresh = facts.partial || (facts.async && facts.preserveState)

  if (op?.kind === 'walk') {
    if (s.walk === null || s.walk.visit !== e.visit || !s.base.blank) {
      return { kind: 'drop' }
    }

    return marks.layer?.base && !facts.cycles && s.rows.length + 1 < MAX_LAYER_CHAIN
      ? { kind: 'walk-beneath', id: e.newId }
      : { kind: 'walk-base' }
  }

  if (origin.kind === 'layer' && !row(s, origin.id)) {
    return marks.layer || facts.partial ? { kind: 'drop' } : { kind: 'base' }
  }

  if (marks.close) {
    const target = origin.kind === 'layer' ? origin.id : origin.top !== null && row(s, origin.top) ? origin.top : null

    return target ? { kind: 'close', id: target, beneath: beneath(s.rows, target) } : { kind: 'pass' }
  }

  const from = origin.kind === 'layer' ? row(s, origin.id)! : null
  // A layer that owns no address was submitted from the tier beneath it, so that tier's page comes back.
  const handsBack = from !== null && !from.ownsAddress && facts.matchesAddressTier && facts.hasErrors

  if (marks.layer) {
    if (s.pin && s.pin.gen === s.base.gen) {
      const pinned = s.pin.ticket ? s.tickets.get(s.pin.ticket) : undefined

      return { kind: 'return', id: pinned ? pinned.id : e.newId }
    }

    if (handsBack) {
      return { kind: 'handback', id: from.id }
    }

    const ticket = op?.kind === 'open' ? s.tickets.get(op.ticket) : undefined
    const same = sameKey(s.rows, marks.layer.key, origin.kind === 'layer' ? origin.id : null)

    // The answer to a layer's own placeholder lands on it, unless another layer already holds its key.
    if (origin.kind === 'layer' && origin.instant && (!same || same.id === origin.id)) {
      return { kind: 'refresh', id: origin.id, remount: false }
    }

    if (same && isRefresh) {
      return { kind: 'refresh', id: same.id, remount: !facts.preserveState }
    }

    if (isRefresh) {
      return origin.kind === 'layer'
        ? { kind: 'refresh', id: origin.id, remount: !facts.preserveState }
        : { kind: 'drop' }
    }

    if (same) {
      const above = s.rows.slice(s.rows.indexOf(same) + 1).map((candidate) => candidate.id)

      return { kind: 'rewrite', id: same.id, dismissed: above, remount: !facts.preserveState }
    }

    if (origin.kind === 'base' && origin.gen !== s.base.gen) {
      if (origin.instantGen !== s.base.gen) {
        return { kind: 'drop' }
      }

      return marks.layer.base && !facts.cycles
        ? { kind: 'cold', id: ticket ? ticket.id : e.newId }
        : { kind: 'promote' }
    }

    if (ticket && !row(s, ticket.id)) {
      return {
        kind: 'open',
        id: ticket.id,
        owner: ticket.owner === 'base' || row(s, ticket.owner) ? ticket.owner : 'base',
      }
    }

    if (origin.kind === 'layer') {
      return { kind: 'open', id: e.newId, owner: origin.id }
    }

    const top = origin.top !== null && row(s, origin.top) ? origin.top : null

    if (facts.aimed || facts.baseMatches || top) {
      return { kind: 'open', id: e.newId, owner: top ?? 'base' }
    }

    return marks.layer.base && !facts.cycles ? { kind: 'cold', id: ticket ? ticket.id : e.newId } : { kind: 'promote' }
  }

  if (from) {
    return handsBack ? { kind: 'handback', id: from.id } : { kind: 'base' }
  }

  return { kind: 'pass' }
}

/** The routed row with this key: the preferred row first, else the lowest. */
function sameKey(rows: readonly LayerRow[], key: string, prefer: LayerId | null): LayerRow | undefined {
  const matches = rows.filter((row) => row.type === 'routed' && row.key === key)

  return matches.find((row) => row.id === prefer) ?? matches[0]
}

export function responseArrived(s: StackState, e: E<'responseArrived'>): Step {
  const landing = classify(s, e)
  const outcome = { kind: 'landing', landing } as const
  const key = e.marks.layer?.key ?? ''
  const op = s.ops.get(e.visit)

  const capped = landing.kind === 'walk-base' && !!e.marks.layer?.base && !e.facts.cycles

  return run(
    s,
    (t, fx) => {
      if (capped) {
        fx.push({
          type: 'warn',
          message: `A layer chain more than ${MAX_LAYER_CHAIN} layers deep was declared, so "${e.marks.layer!.base}" was not fetched. The deepest layer that loaded is being used as the page.`,
        })
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
              rows: [...t.rows, openingRow(landing.id, key, landing.owner, { ownsAddress: !e.facts.preserveUrl })],
            },
            op,
          )
        case 'rewrite':
          return bind(rewrite(t, fx, landing, key), op)
        case 'refresh': {
          // The answer to a layer's own placeholder names the key that layer has from now on.
          const claimed = e.origin.kind === 'layer' && e.origin.instant && e.marks.layer !== null
          const target = { ...row(t, landing.id)!, ...(claimed && { key }) }

          t = setRow(t, target)

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
              rows: [openingRow(landing.id, key, 'base', { standalone: true })],
              base: { blank: true, gen: minted.base.gen + 1 },
              walk: { target: url, visit: null, startOnSwap: true },
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
          const returning = openingRow(landing.id, key, pin.suspended.at(-1)?.id ?? 'base', {
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
          const target = e.marks.layer!.base!

          fx.push({ type: 'retargetBlank', url: target })
          fx.push({ type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: target })

          return landed(
            {
              ...t,
              rows: [openingRow(landing.id, key, 'base', { standalone: true }), ...t.rows],
              walk: { target, visit: null, startOnSwap: false },
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

function rewrite(s: StackState, fx: Fx, landing: Extract<Landing, { kind: 'rewrite' }>, key: string): StackState {
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
