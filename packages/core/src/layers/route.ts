import {
  MAX_LAYER_CHAIN,
  type Landing,
  type LayerId,
  type LayerRow,
  type Owner,
  type StackEvent,
  type StackState,
} from './state'

type ResponseArrived = Extract<StackEvent, { type: 'responseArrived' }>

/** Where a response lands. Pure; first match wins. */
export function classify(s: StackState, e: ResponseArrived): Landing {
  const { origin, marks, facts } = e
  const op = s.ops.get(e.visit)
  const isRefresh = facts.partial || (facts.async && facts.preserveState)
  const row = (id: LayerId) => s.rows.find((candidate) => candidate.id === id)

  if (op?.kind === 'walk') {
    if (s.walk === null || s.walk.visit !== e.visit || !s.base.blank) {
      return { kind: 'drop' }
    }

    return marks.layer?.base && !facts.cycles && s.rows.length + 1 < MAX_LAYER_CHAIN
      ? { kind: 'walk-beneath', id: e.newId }
      : { kind: 'walk-base' }
  }

  if (origin.kind === 'layer' && !row(origin.id)) {
    return marks.layer || facts.partial ? { kind: 'drop' } : { kind: 'base' }
  }

  if (marks.close) {
    const target = origin.kind === 'layer' ? origin.id : origin.top !== null && row(origin.top) ? origin.top : null

    return target ? { kind: 'close', id: target, beneath: beneath(s.rows, target) } : { kind: 'pass' }
  }

  const from = origin.kind === 'layer' ? row(origin.id)! : null
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

      return marks.layer.base ? { kind: 'cold', id: ticket ? ticket.id : e.newId } : { kind: 'promote' }
    }

    if (ticket && !row(ticket.id)) {
      return {
        kind: 'open',
        id: ticket.id,
        owner: ticket.owner === 'base' || row(ticket.owner) ? ticket.owner : 'base',
      }
    }

    if (origin.kind === 'layer') {
      return { kind: 'open', id: e.newId, owner: origin.id }
    }

    const top = origin.top !== null && row(origin.top) ? origin.top : null

    if (facts.aimed || facts.baseMatches || top) {
      return { kind: 'open', id: e.newId, owner: top ?? 'base' }
    }

    return marks.layer.base ? { kind: 'cold', id: ticket ? ticket.id : e.newId } : { kind: 'promote' }
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
