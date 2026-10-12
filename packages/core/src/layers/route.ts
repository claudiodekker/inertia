import type { Landing, LayerId, LayerRow, StackEvent, StackState } from './state'

type ResponseArrived = Extract<StackEvent, { type: 'responseArrived' }>

/** Where a response lands. Pure; first match wins. */
export function classify(s: StackState, e: ResponseArrived): Landing {
  const { origin, marks, facts } = e
  const isRefresh = facts.partial || (facts.async && facts.preserveState)
  const inModel = (id: LayerId) => s.rows.some((row) => row.id === id)

  if (origin.kind === 'layer' && !inModel(origin.id)) {
    return marks.layer || facts.partial ? { kind: 'drop' } : { kind: 'base' }
  }

  if (!marks.layer) {
    return origin.kind === 'layer' ? { kind: 'base' } : { kind: 'pass' }
  }

  if (origin.kind === 'layer' && origin.instant) {
    return { kind: 'refresh', id: origin.id, remount: false }
  }

  const same = sameKey(s.rows, marks.layer.key, origin.kind === 'layer' ? origin.id : null)

  if (same && isRefresh) {
    return { kind: 'refresh', id: same.id, remount: !facts.preserveState }
  }

  if (isRefresh) {
    return origin.kind === 'layer' ? { kind: 'refresh', id: origin.id, remount: !facts.preserveState } : { kind: 'drop' }
  }

  if (same) {
    const above = s.rows.slice(s.rows.indexOf(same) + 1).map((row) => row.id)

    return { kind: 'rewrite', id: same.id, dismissed: above, remount: !facts.preserveState }
  }

  if (origin.kind === 'base' && origin.gen !== s.base.gen) {
    if (origin.instantGen !== s.base.gen) {
      return { kind: 'drop' }
    }

    return marks.layer.base ? { kind: 'cold' } : { kind: 'promote' }
  }

  if (origin.kind === 'layer') {
    return { kind: 'open', id: e.newId, owner: origin.id }
  }

  const top = origin.top !== null && inModel(origin.top) ? origin.top : null

  if (facts.aimed || facts.baseMatches || top) {
    return { kind: 'open', id: e.newId, owner: top ?? 'base' }
  }

  return marks.layer.base ? { kind: 'cold' } : { kind: 'promote' }
}

/** The routed row with this key: the origin layer first, else the topmost. */
function sameKey(rows: readonly LayerRow[], key: string, prefer: LayerId | null): LayerRow | undefined {
  const matches = rows.filter((row) => row.type === 'routed' && row.key === key)

  return matches.find((row) => row.id === prefer) ?? matches.at(-1)
}
