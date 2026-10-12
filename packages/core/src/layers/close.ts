// Closing: a close's exit, its history unwind, the removal queue and the refresh beneath. Pure, like
// reduce.ts, which routes the close events here.

import type { CloseId, CloseRow, LayerId, LayerRow, StackState, Step, WaiterId } from './state'
import { beneath, mint, paint, put, row, run, setClose, without, withoutRows, type E, type Fx } from './update'

export function closeRequested(s: StackState, e: E<'closeRequested'>): Step {
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
export function startClose(s: StackState, fx: Fx, id: LayerId, closeId: CloseId, waiter: WaiterId | null): StackState {
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

export function exited(s: StackState, e: E<'exited'>): Step {
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
export function progress(s: StackState, fx: Fx, closeId: CloseId): StackState {
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

  if (entries === 0) {
    const t = { ...s, rows: withoutRows(s.rows, close.layers) }

    fx.push({ type: 'writeEntry', mode: beneathWrite(covered[0]) })

    return continueAfterRemoval(paint(t, fx), fx, close, covered[0], s.rows)
  }

  const [token, minted] = mint(s)

  fx.push({ type: 'historyGo', delta: -entries, token })

  return {
    ...setClose(minted, { ...close, phase: { kind: 'unwinding', token } }),
    expect: { kind: 'unwind', close: close.id, token },
  }
}

/**
 * How the page beneath is written once the covered rows are gone. A row opened cold has no entry of
 * the page beneath to return to, so that page is pushed over the row's own entry.
 */
function beneathWrite(bottom: LayerRow | undefined): 'push' | 'replace' {
  return bottom?.standalone ? 'push' : 'replace'
}

/** The browser answered our history.go (or timed out): the covered rows leave the model. */
export function completeUnwind(s: StackState, fx: Fx, closeId: CloseId): StackState {
  const close = s.closes.get(closeId)!
  const covered = s.rows.filter((r) => close.layers.includes(r.id))
  const t = { ...s, expect: null, rows: withoutRows(s.rows, close.layers) }

  fx.push({ type: 'writeEntry', mode: beneathWrite(covered[0]) })

  return startQueued(continueAfterRemoval(paint(t, fx), fx, close, covered[0], s.rows), fx)
}

/**
 * Refresh the routed tier beneath when the closed bottom row was routed and that tier is real. Over a
 * blank base whose page has been answered and is still resolving its component, the walk is sent again.
 */
function continueAfterRemoval(
  removed: StackState,
  fx: Fx,
  close: CloseRow,
  bottom: LayerRow | undefined,
  before: readonly LayerRow[],
): StackState {
  const s = walkAgain(removed, fx)
  const via = bottom ? beneath(before, bottom.id) : 'base'
  const refreshes = bottom?.type === 'routed' && !(via === 'base' && s.base.blank)

  if (!refreshes) {
    return finishClose(s, fx, close.id)
  }

  fx.push({ type: 'startVisit', tag: { kind: 'refresh', close: close.id }, via, url: null })

  return setClose(s, { ...close, phase: { kind: 'refreshing', visit: null } })
}

/** A removal supersedes the walk landing in flight, as it did in the original. The first commit to arrive lands. */
function walkAgain(s: StackState, fx: Fx): StackState {
  const hop = s.walk?.visit ? s.ops.get(s.walk.visit) : undefined

  if (!s.walk || !s.base.blank || hop?.kind !== 'walk' || !hop.landed) {
    return s
  }

  fx.push({ type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: s.walk.target })

  return { ...s, walk: { ...s.walk, visit: null } }
}

export function finishClose(s: StackState, fx: Fx, closeId: CloseId): StackState {
  const close = s.closes.get(closeId)!

  fx.push({ type: 'dispose', ids: [...close.layers].reverse(), reason: 'closed' })

  if (close.waiters.length > 0) {
    fx.push({ type: 'settle', waiters: close.waiters, result: 'closed' })
  }

  return startQueued({ ...s, closes: without(s.closes, closeId) }, fx)
}

export function startQueued(s: StackState, fx: Fx): StackState {
  let t = s
  let next: CloseRow | undefined

  while (t.expect === null && (next = [...t.closes.values()].find((c) => c.phase.kind === 'queued'))) {
    t = removeOrUnwind(t, fx, next)
  }

  return t
}

/**
 * What a history write made now holds. A row being closed is never stored, so no entry left behind
 * reopens it. Its url stays the address until its close steps back, because the write lands on the
 * entry that row is on; a write queued behind the step back lands on the entry beneath.
 */
export function entryRows(s: StackState): { stored: LayerRow[]; addressed: LayerRow[] } {
  const open = s.rows.filter((r) => r.phase === 'open')

  return {
    stored: open.filter((r) => r.close === null),
    addressed: open.filter((r) => r.close === null || s.closes.get(r.close)?.phase.kind !== 'unwinding'),
  }
}

/** A remounting landing on a row whose close is still exiting puts the covered rows back. */
export function abandonIfExiting(s: StackState, fx: Fx, closeId: CloseId | null): StackState {
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

/**
 * A refreshing close still names the rows it removed, to dispose them when its refresh finishes. An
 * entry that reopens one of them reuses its id, so that close ends first.
 */
export function finishRefreshingOver(s: StackState, fx: Fx, ids: readonly LayerId[]): StackState {
  return [...s.closes.values()]
    .filter((close) => close.phase.kind === 'refreshing' && close.layers.some((id) => ids.includes(id)))
    .reduce((t, close) => finishClose(t, fx, close.id), s)
}

/** Rows that left the model outside their close (dismissed, dropped) leave it; an emptied close settles. */
export function forgetInCloses(s: StackState, fx: Fx, ids: readonly LayerId[]): StackState {
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
