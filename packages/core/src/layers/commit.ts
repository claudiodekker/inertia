// What a commit does to the stack: a base page's, which keeps, drops or suspends it, and a layer's, which
// writes its history entry.

import { startQueued } from './close'
import type { Op, StackState, Step } from './state'
import { clearStack, issueToken, row, run, setRow, settleAll, withoutRows, type E, type Fx } from './update'

/**
 * Made before the base history write. The stack is kept by an install it asked for, a visit it follows,
 * the initial commit, the answer to a partial or a reload that stays on the component (or fills a blank),
 * and a client replace of the same page. An interstitial prompt suspends it. Anything else drops it: the answer to a
 * navigation does so even when it lands on the very same page. The gate holds the stack's paint until
 * the base swaps, so both change in one frame.
 */
export function baseCommitting(s: StackState, e: E<'baseCommitting'>): Step {
  return run(s, (t, fx) => {
    t = { ...t, paint: { ...t.paint, gated: true } }

    const expect = t.expect

    if (expect?.kind === 'base' && e.visit !== null && String(expect.token) === e.visit) {
      t = { ...t, expect: null }

      if (expect.source.kind === 'held') {
        fx.push({ type: 'releaseBase', token: expect.source.token })
        t = { ...t, base: { ...t.base, blank: false } }
      }

      if (expect.source.kind === 'promote') {
        fx.push({ type: 'dispose', ids: [expect.source.layer], reason: 'closed' })
        t = { ...t, base: { ...t.base, blank: false } }
      }

      return startQueued(t, fx)
    }

    const op = e.visit === null ? undefined : t.ops.get(e.visit)

    if (op?.kind === 'fetchBase' && op.landed) {
      return { ...t, base: { ...t.base, blank: false }, baseFetch: null }
    }

    if (op?.kind === 'recover') {
      return { ...t, base: { ...t.base, blank: false }, baseFetch: null }
    }

    if (op?.kind === 'refresh' || e.initial) {
      return t
    }

    if (e.interstitial && !t.base.blank) {
      return interstitialCommitting(t, fx, e, op)
    }

    if (e.answer === 'refresh' && (e.change !== 'other' || t.base.blank)) {
      const top = t.rows.filter((r) => r.phase === 'open').at(-1)

      // An entry pushed beneath a stack that owns no address is one more for the top layer's close to step over.
      t = e.mode === 'push' && top ? setRow(t, { ...top, entries: top.entries + 1 }) : t

      return { ...t, base: { blank: false, gen: t.base.gen + (e.change === 'same' ? 0 : 1) }, baseFetch: null }
    }

    if (e.answer === null && e.mode === 'replace' && (e.change === 'same' || e.change === 'moved')) {
      return t
    }

    const dropped = t.rows.length > 0 || t.dismissed.length > 0

    t = clearStack(t, fx, 'navigated')

    return { ...t, base: { blank: false, gen: t.base.gen + 1 }, paint: { gated: true, owed: t.paint.owed || dropped } }
  })
}

/** An interstitial prompt replaces the screen: the live rows are suspended until the layer it leads to arrives. */
function interstitialCommitting(s: StackState, fx: Fx, e: E<'baseCommitting'>, op: Op | undefined): StackState {
  const push = e.mode === 'push' ? 1 : 0
  const gen = s.base.gen + 1

  if (s.interstitial) {
    return {
      ...s,
      interstitial: { ...s.interstitial, gen, pushes: s.interstitial.pushes + push },
      base: { ...s.base, gen },
    }
  }

  const [token, issued] = issueToken(s)

  fx.push({ type: 'holdBase', token })

  const closing = issued.rows.filter((r) => r.close !== null || r.phase === 'opening').map((r) => r.id)
  const gone = [...closing, ...issued.dismissed]

  if (gone.length > 0) {
    fx.push({ type: 'dispose', ids: gone, reason: 'navigated' })
  }

  const t = settleAll(issued, fx, 'closed')
  const owed = t.rows.length > 0 || t.dismissed.length > 0

  return {
    ...t,
    rows: [],
    dismissed: [],
    closes: new Map(),
    expect: t.expect?.kind === 'unwind' ? null : t.expect,
    interstitial: {
      token,
      gen,
      pushes: push,
      request: op?.kind === 'open' ? op.request : null,
      suspended: withoutRows(t.rows, closing),
    },
    base: { ...t.base, gen },
    paint: { gated: true, owed: t.paint.owed || owed },
  }
}

export function baseSwapped(s: StackState): Step {
  return run(s, (t, fx) => {
    if (t.paint.gated || t.paint.owed) {
      if (t.paint.owed) {
        fx.push({ type: 'paint' })
      }

      t = { ...t, paint: { gated: false, owed: false } }
    }

    const installing = t.expect?.kind === 'base' && t.expect.source.kind === 'blank'

    if (t.baseFetch?.startOnSwap && !installing) {
      fx.push({ type: 'startVisit', tag: { kind: 'fetchBase' }, via: 'base', url: t.baseFetch.url })
      t = { ...t, baseFetch: { ...t.baseFetch, startOnSwap: false } }
    }

    return t
  })
}

export function layerCommitting(s: StackState, e: E<'layerCommitting'>): Step {
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
      fx.push(mode === 'push' ? { type: 'writeEntry', mode, charged: e.id } : { type: 'writeEntry', mode })

      return t
    },
    { kind: 'commit', decision: { kind: 'write', mode } },
  )
}

/**
 * The browser pushed an entry of its own, so a close has one more step to take back. It is charged to the
 * layer that owns the address, whose url takes the hash, else to the top layer.
 */
export function anchored(s: StackState): Step {
  const open = s.rows.filter((r) => r.phase === 'open')
  const owner = open.filter((r) => r.type === 'routed' && r.ownsAddress).at(-1)
  const charged = owner ?? open.at(-1)

  return {
    state: charged ? setRow(s, { ...charged, entries: charged.entries + 1 }) : s,
    effects: [],
    outcome: { kind: 'anchor', owner: owner?.id ?? null },
  }
}
