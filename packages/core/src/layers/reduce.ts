// reduce(state, event) -> { state, effects, outcome }. Pure and total: an event naming something gone
// is a no-op with no effects, never a throw. The only writer of StackState.

import { classify } from './route'
import type { LayerId, LayerRow, StackEffect, StackEvent, StackState, Step } from './state'

type E<T extends StackEvent['type']> = Extract<StackEvent, { type: T }>

const none = { kind: 'none' } as const

export function reduce(s: StackState, e: StackEvent): Step {
  switch (e.type) {
    case 'responseArrived':
      return responseArrived(s, e)
    case 'baseCommitting':
      return baseCommitting(s, e)
    case 'baseSwapped':
      return baseSwapped(s)
    case 'layerCommitting':
      return layerCommitting(s, e)
    case 'layerSwapped':
      return layerSwapped(s, e)
    case 'exited':
      return exited(s, e)
    default:
      return assertNever(e)
  }
}

function responseArrived(s: StackState, e: E<'responseArrived'>): Step {
  const landing = classify(s, e)
  const outcome = { kind: 'landing', landing } as const

  switch (landing.kind) {
    case 'open': {
      const row: LayerRow = {
        id: landing.id,
        type: 'routed',
        key: e.marks.layer!.key,
        owner: landing.owner,
        phase: 'opening',
        ownsAddress: !e.facts.preserveUrl,
        entries: 0,
        renderKey: 0,
      }

      return { state: { ...s, rows: [...s.rows, row] }, effects: [], outcome }
    }
    case 'rewrite': {
      const dismissed = s.rows.filter((row) => landing.dismissed.includes(row.id))
      const rows = s.rows
        .filter((row) => !landing.dismissed.includes(row.id))
        .map((row) =>
          row.id === landing.id
            ? {
                ...row,
                key: e.marks.layer!.key,
                entries: row.entries + dismissed.reduce((sum, gone) => sum + gone.entries, 0),
                renderKey: row.renderKey + (landing.remount ? 1 : 0),
              }
            : row,
        )

      if (dismissed.length === 0) {
        return { state: { ...s, rows }, effects: [], outcome }
      }

      const [state, effects] = paint({ ...s, rows, ghosts: [...s.ghosts, ...landing.dismissed] })

      return { state, effects, outcome }
    }
    case 'refresh':
      return {
        state: landing.remount ? { ...s, rows: s.rows.map((row) => bumped(row, landing.id)) } : s,
        effects: [],
        outcome,
      }
    default:
      return { state: s, effects: [], outcome }
  }
}

/**
 * The explicit "base navigated" decision, made before the base history write. A replace of the same
 * page keeps the stack (partial reload, poll, router.replace); anything else drops it. The gate holds
 * the stack's paint until the base swaps, so both change in one frame.
 */
function baseCommitting(s: StackState, e: E<'baseCommitting'>): Step {
  if (e.mode === 'replace' && e.sameAsLive) {
    return { state: { ...s, paint: { ...s.paint, gated: true } }, effects: [], outcome: none }
  }

  const dropped = [...s.rows.map((row) => row.id), ...s.ghosts]

  return {
    state: {
      base: { gen: s.base.gen + 1 },
      rows: [],
      ghosts: [],
      paint: { gated: true, owed: s.paint.owed || dropped.length > 0 },
    },
    effects: dropped.length > 0 ? [{ type: 'dispose', ids: dropped, reason: 'navigated' }] : [],
    outcome: none,
  }
}

function baseSwapped(s: StackState): Step {
  if (!s.paint.gated && !s.paint.owed) {
    return { state: s, effects: [], outcome: none }
  }

  return {
    state: { ...s, paint: { gated: false, owed: false } },
    effects: s.paint.owed ? [{ type: 'paint' }] : [],
    outcome: none,
  }
}

/** Push, replace or skip, charged to the committing row. */
function layerCommitting(s: StackState, e: E<'layerCommitting'>): Step {
  const row = s.rows.find((candidate) => candidate.id === e.id)

  if (!row) {
    return { state: s, effects: [], outcome: { kind: 'commit', decision: { kind: 'skip' } } }
  }

  const mode =
    row.phase === 'opening'
      ? e.requestedReplace
        ? 'replace'
        : 'push'
      : e.urlChanged && !e.requestedReplace
        ? 'push'
        : 'replace'

  const committed: LayerRow = { ...row, phase: 'open', entries: row.entries + (mode === 'push' ? 1 : 0) }

  return {
    state: { ...s, rows: s.rows.map((candidate) => (candidate.id === e.id ? committed : candidate)) },
    effects: [{ type: 'writeEntry', mode }],
    outcome: { kind: 'commit', decision: { kind: 'write', mode } },
  }
}

function layerSwapped(s: StackState, e: E<'layerSwapped'>): Step {
  if (!s.rows.some((row) => row.id === e.id) && !s.ghosts.includes(e.id)) {
    return { state: s, effects: [], outcome: none }
  }

  const [state, effects] = paint(s)

  return { state, effects, outcome: none }
}

function exited(s: StackState, e: E<'exited'>): Step {
  if (!s.ghosts.includes(e.id)) {
    return { state: s, effects: [], outcome: none }
  }

  const [state, effects] = paint({ ...s, ghosts: s.ghosts.filter((id) => id !== e.id) })

  return { state, effects: [{ type: 'dispose', ids: [e.id], reason: 'closed' }, ...effects], outcome: none }
}

function paint(s: StackState): [StackState, StackEffect[]] {
  return s.paint.gated ? [{ ...s, paint: { ...s.paint, owed: true } }, []] : [s, [{ type: 'paint' }]]
}

function bumped(row: LayerRow, id: LayerId): LayerRow {
  return row.id === id ? { ...row, renderKey: row.renderKey + 1 } : row
}

function assertNever(x: never): never {
  throw new Error(`Unhandled stack event: ${JSON.stringify(x)}`)
}
