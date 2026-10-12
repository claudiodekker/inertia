import { completeUnwind, finishRefreshingOver, forgetInCloses } from './close'
import type { EntryFacts, EntryLayerFacts, LayerId, LayerRow, StackState, Step } from './state'
import { clearPin, clearStack, paint, run, withoutRows, type E, type Fx } from './update'

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

  const plan = { kind: 'restore' as const, base: false, dismiss: null, drop: [], rewind: [], reopen: [] }

  if (target.length === 0 && rows.length === 0 && s.ghosts.length === 0) {
    if (entry.blank) {
      return { kind: 'recover', url: entry.url }
    }

    // A real page restored over a blank base ends the wait for the base: nothing still out may land on it.
    return s.base.blank ? { ...plan, base: true } : { kind: 'pass' }
  }

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

// ---------------------------------------------------------------------------------------------------
// The restore handlers
// ---------------------------------------------------------------------------------------------------

/** Document load onto a composite entry (Back or Forward into the app). Replaces the boot rows. */
export function restoredOnLoad(s: StackState, e: E<'restoredOnLoad'>): Step {
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

export function popstate(s: StackState, e: E<'popstate'>): Step {
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

  t = finishRefreshingOver(t, fx, plan.reopen)

  const reopened = new Set(plan.reopen)
  const lingering = t.ghosts.filter((id) => reopened.has(id))
  const gone = [...plan.drop, ...lingering]

  if (gone.length > 0) {
    fx.push({ type: 'dispose', ids: gone, reason: 'restored-away' })
  }

  t = forgetInCloses(t, fx, [...plan.drop, ...(plan.dismiss ? [plan.dismiss] : [])])

  // A row that stays is at the entry's point in history now: it has pushed what that entry counted.
  const counted = new Map(e.entry.layers.map((layer) => [layer.id, layer.entries]))

  t = {
    ...t,
    rows: withoutRows(t.rows, [...plan.drop, ...(plan.dismiss ? [plan.dismiss] : [])]).map((r) =>
      (counted.get(r.id) ?? r.entries) === r.entries ? r : { ...r, entries: counted.get(r.id)! },
    ),
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

export function fromEntry(below: readonly LayerRow[], layers: readonly EntryLayerFacts[]): LayerRow[] {
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
