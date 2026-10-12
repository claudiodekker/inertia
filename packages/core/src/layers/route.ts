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
  issueToken,
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

  if (op?.kind === 'fetchBase') {
    if (s.baseFetch === null || s.baseFetch.visit !== e.visit || !s.base.blank) {
      return { kind: 'drop' }
    }

    return marks.layer?.base && !facts.cycles && s.rows.length + 1 < MAX_LAYER_CHAIN
      ? { kind: 'fetched-beneath', id: e.newId }
      : { kind: 'fetched-base' }
  }

  if (origin.kind === 'layer' && !row(s, origin.id)) {
    return marks.layer || facts.partial ? { kind: 'drop' } : { kind: 'base' }
  }

  if (marks.close) {
    const target = origin.kind === 'layer' ? origin.id : origin.top !== null && row(s, origin.top) ? origin.top : null

    return target ? { kind: 'close', id: target, beneath: beneath(s.rows, target) } : { kind: 'pass' }
  }

  const from = origin.kind === 'layer' ? row(s, origin.id)! : null
  // A layer that owns no address was submitted from the page or layer beneath it, whose page comes back.
  const handsBack = from !== null && !from.ownsAddress && facts.matchesAddressOwner && facts.hasErrors

  if (marks.layer) {
    if (s.interstitial && s.interstitial.gen === s.base.gen) {
      const asked = s.interstitial.request ? s.openRequests.get(s.interstitial.request) : undefined

      return { kind: 'return', id: asked ? asked.id : e.newId }
    }

    if (handsBack) {
      return { kind: 'handback', id: from.id }
    }

    const request = op?.kind === 'open' ? s.openRequests.get(op.request) : undefined
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
        ? { kind: 'cold', id: request ? request.id : e.newId }
        : { kind: 'promote' }
    }

    if (request && !row(s, request.id)) {
      return {
        kind: 'open',
        id: request.id,
        owner: request.owner === 'base' || row(s, request.owner) ? request.owner : 'base',
      }
    }

    if (origin.kind === 'layer') {
      return { kind: 'open', id: e.newId, owner: origin.id }
    }

    const top = origin.top !== null && row(s, origin.top) ? origin.top : null

    if (facts.aimed || facts.baseMatches || top) {
      return { kind: 'open', id: e.newId, owner: top ?? 'base' }
    }

    return marks.layer.base && !facts.cycles
      ? { kind: 'cold', id: request ? request.id : e.newId }
      : { kind: 'promote' }
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

  const capped = landing.kind === 'fetched-base' && !!e.marks.layer?.base && !e.facts.cycles

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

          const [token, issued] = issueToken(t)
          const url = e.marks.layer!.base!

          return bind(
            {
              ...issued,
              rows: [openingRow(landing.id, key, 'base', { standalone: true })],
              base: { blank: true, gen: issued.base.gen + 1 },
              baseFetch: { url, visit: null, startOnSwap: true },
              expect: {
                kind: 'base',
                token,
                mode: e.facts.replace ? 'replace' : 'push',
                layer: landing.id,
                source: { kind: 'blank', url },
              },
              paint: { ...issued.paint, gated: true },
            },
            op,
          )
        }
        case 'return': {
          const interstitial = t.interstitial!
          const leftover = [...t.rows.map((r) => r.id), ...t.dismissed]

          if (leftover.length > 0) {
            fx.push({ type: 'dispose', ids: leftover, reason: 'navigated' })
          }

          t = settleAll(t, fx, 'closed')

          const [token, issued] = issueToken(t)
          const returning = openingRow(landing.id, key, interstitial.suspended.at(-1)?.id ?? 'base', {
            entries: interstitial.pushes,
            ownsAddress: !e.facts.preserveUrl,
          })
          const bound = { ...issued, openRequests: without(issued.openRequests, landing.id) }

          return {
            ...bound,
            rows: [...interstitial.suspended, returning],
            dismissed: [],
            interstitial: null,
            base: { ...bound.base, gen: bound.base.gen + 1 },
            expect: {
              kind: 'base',
              token,
              mode: 'replace',
              layer: landing.id,
              source: { kind: 'held', token: interstitial.token },
            },
            paint: { ...bound.paint, gated: true },
          }
        }
        case 'fetched-base':
          return landed(t, e)
        case 'fetched-beneath': {
          const url = e.marks.layer!.base!

          fx.push({ type: 'setBlankUrl', url })
          fx.push({ type: 'startVisit', tag: { kind: 'fetchBase' }, via: 'base', url })

          return landed(
            {
              ...t,
              rows: [openingRow(landing.id, key, 'base', { standalone: true }), ...t.rows],
              baseFetch: { url, visit: null, startOnSwap: false },
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
    dismissed: [...s.dismissed, ...landing.dismissed.filter((id) => !unseen.includes(id))],
  }

  t = forgetInCloses(t, fx, landing.dismissed)

  if (landing.remount) {
    t = abandonIfExiting(t, fx, target.close)
  }

  return dismissed.length > 0 ? paint(t, fx) : t
}

function landed(s: StackState, e: E<'responseArrived'>): StackState {
  const op = s.ops.get(e.visit)

  return op?.kind === 'fetchBase' ? { ...s, ops: put(s.ops, e.visit, { ...op, landed: true }) } : s
}

/** An open request whose visit landed on a row is over: the landing names the row. */
function bind(s: StackState, op: Op | undefined): StackState {
  return op?.kind === 'open' && s.openRequests.has(op.request)
    ? { ...s, openRequests: without(s.openRequests, op.request) }
    : s
}
