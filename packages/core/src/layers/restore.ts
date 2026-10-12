import type { EntryFacts, LayerId, StackState } from './state'

export type RestorePlan =
  | { kind: 'pass' }
  /** A stored blank placeholder with nothing on it: request the base again. */
  | { kind: 'recover'; url: string }
  | {
      kind: 'restore'
      /** The entry's base differs from the live one: 3.x restores it. */
      base: boolean
      /** Leaves the model and plays its exit (plain Back off the top layer). */
      dismiss: LayerId | null
      /** Leave at once, no exit. */
      drop: readonly LayerId[]
      /** Same row, different snapshot: set the entry's page quietly. */
      rewind: readonly LayerId[]
      /** Recreated from the entry with no request. */
      reopen: readonly LayerId[]
    }

/** How a popstate entry maps onto the live rows. Pure. */
export function planRestore(s: StackState, entry: EntryFacts): RestorePlan {
  const { rows } = s
  const target = entry.layers

  if (target.length === 0 && rows.length === 0 && s.ghosts.length === 0) {
    return entry.blank ? { kind: 'recover', url: entry.url } : { kind: 'pass' }
  }

  const plan = { kind: 'restore' as const, base: false, dismiss: null, drop: [], rewind: [], reopen: [] }

  if (!entry.baseSame) {
    return { ...plan, base: true, drop: rows.map((row) => row.id), reopen: target.map((layer) => layer.id) }
  }

  let k = 0

  while (k < rows.length && k < target.length && sameLayer(rows[k], target[k])) {
    k++
  }

  const top = rows.at(-1)

  if (top && k === rows.length - 1 && k === target.length && top.entries === 1 && top.close === null) {
    return { ...plan, dismiss: top.id }
  }

  if (k === rows.length && k === target.length) {
    return { ...plan, rewind: rows.filter((row) => !entry.sameSnapshot.has(row.id)).map((row) => row.id) }
  }

  return {
    ...plan,
    drop: rows.slice(k).map((row) => row.id),
    reopen: target.slice(k).map((layer) => layer.id),
  }
}

function sameLayer(
  a: { id: LayerId; key: string; type: string },
  b: { id: LayerId; key: string; type: string },
): boolean {
  return a.id === b.id && a.key === b.key && a.type === b.type
}
