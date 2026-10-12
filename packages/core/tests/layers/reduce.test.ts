import { describe, expect, it } from 'vitest'
import { reduce } from '../../src/layers/reduce'
import type { StackState } from '../../src/layers/state'
import {
  arrival,
  arrived,
  baseOrigin,
  cid,
  close,
  closes,
  committing,
  entry,
  entryLayer,
  id,
  layerOrigin,
  row,
  script,
  state,
  tok,
  visit,
  wid,
} from './support/fixtures'

const landing = (kind: string, extra: object = {}) => ({ kind: 'landing', landing: { kind, ...extra } })

const none = { kind: 'none' }

const handled = { kind: 'restore', restore: { kind: 'handled' } }

describe('opening over the page on screen', () => {
  it('L:6 a layer response the base visit was aimed at opens as an opening row owned by the base', () => {
    expect(arrived(state(), { layer: { key: 'panel', base: '/base' }, facts: { aimed: true } })).toEqual({
      state: state({ rows: [row('new', { key: 'panel', phase: 'opening', entries: 0 })] }),
      effects: [],
      outcome: landing('open', { id: 'new', owner: 'base' }),
    })
  })

  it('L:75 a layer answer to a visit made from a layer stacks above it as its child', () => {
    const s = state({ rows: [row('a', { key: 'panel:first' })] })

    expect(arrived(s, { origin: layerOrigin('a'), layer: { key: 'panel:second', base: '/base' } })).toEqual({
      state: state({
        rows: [
          row('a', { key: 'panel:first' }),
          row('new', { key: 'panel:second', owner: id('a'), phase: 'opening', entries: 0 }),
        ],
      }),
      effects: [],
      outcome: landing('open', { id: 'new', owner: 'a' }),
    })
  })

  it('L:491 L:624 a base-made answer opens over the top layer live at dispatch; a preserveUrl open owns no address', () => {
    const s = state({ rows: [row('a')] })
    const step = arrived(s, {
      origin: baseOrigin({ top: 'a' }),
      layer: { key: 'other', base: '/base' },
      facts: { preserveUrl: true },
    })

    expect(step.outcome).toEqual(landing('open', { id: 'new', owner: 'a' }))
    expect(step.state.rows).toEqual([
      row('a'),
      row('new', { key: 'other', owner: id('a'), phase: 'opening', entries: 0, ownsAddress: false }),
    ])
  })

  it('L:201 L:212 a base-made answer that is neither aimed nor over a live layer lands cold', () => {
    expect(arrived(state(), { layer: { key: 'guarded', base: '/base' } }).outcome).toEqual(
      landing('cold', { id: 'new' }),
    )
    expect(arrived(state(), { layer: { key: 'guarded', base: '/base' }, facts: { aimed: true } }).outcome).toEqual(
      landing('open', { id: 'new', owner: 'base' }),
    )
    expect(
      arrived(state(), { layer: { key: 'guarded', base: '/base' }, facts: { baseMatches: true } }).outcome,
    ).toEqual(landing('open', { id: 'new', owner: 'base' }))
  })

  it('L:184 a base push committing while a layer is still opening drops it, and its commit is skipped', () => {
    const {
      state: s,
      effects,
      last,
    } = script(state({ rows: [row('new', { phase: 'opening', entries: 0 })] }), [
      committing({ mode: 'push' }),
      { type: 'layerCommitting', id: id('new'), requestedReplace: false, urlChanged: false },
    ])

    expect(s).toEqual(state({ base: { blank: false, gen: 1 }, paint: { gated: true, owed: true } }))
    expect(effects).toEqual([{ type: 'dispose', ids: ['new'], reason: 'navigated' }])
    expect(last.outcome).toEqual({ kind: 'commit', decision: { kind: 'skip' } })
  })

  it('L:146 a client visit that installs another page drops every row and ghost and owes a paint', () => {
    const s = state({ base: { blank: false, gen: 3 }, rows: [row('a'), row('b')], dismissed: [id('c')] })

    expect(reduce(s, committing({ mode: 'push', change: 'same' }))).toEqual({
      state: state({ base: { blank: false, gen: 4 }, paint: { gated: true, owed: true } }),
      effects: [{ type: 'dispose', ids: ['a', 'b', 'c'], reason: 'navigated' }],
      outcome: none,
    })
    expect(reduce(state({ rows: [row('a')] }), committing({ mode: 'replace', change: 'other' })).state.rows).toEqual([])
  })

  it('L:527 L:1144 L:1216 a replace of the same base page keeps the stack and closes the gate', () => {
    expect(reduce(state({ rows: [row('a')] }), committing({ mode: 'replace', change: 'same' }))).toEqual({
      state: state({ rows: [row('a')], paint: { gated: true, owed: false } }),
      effects: [],
      outcome: none,
    })
  })

  it('the answer to a partial or a reload keeps the stack while the base stays on its component', () => {
    const s = state({ base: { blank: false, gen: 3 }, rows: [row('a')] })
    const kept = (gen: number) =>
      state({ base: { blank: false, gen }, rows: [row('a')], paint: { gated: true, owed: false } })

    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', change: 'same' })).state).toEqual(kept(3))
    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', change: 'moved' })).state).toEqual(kept(4))
    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', change: 'elsewhere' })).state).toEqual(kept(4))
    expect(reduce(s, committing({ answer: 'refresh', mode: 'push', change: 'other' })).state.rows).toEqual([])
  })

  it('charges the entry a refresh pushes beneath a kept stack to the top open row', () => {
    const rows = [row('a', { ownsAddress: false }), row('b', { ownsAddress: false }), row('c', { phase: 'opening' })]
    const s = state({ base: { blank: false, gen: 3 }, rows })

    expect(reduce(s, committing({ answer: 'refresh', mode: 'push', change: 'moved' })).state.rows).toEqual([
      rows[0],
      { ...rows[1], entries: rows[1].entries + 1 },
      rows[2],
    ])
    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', change: 'moved' })).state.rows).toEqual(rows)
  })

  it('the answer to a partial or a reload that fills a blank base keeps the stack and ends the walk', () => {
    const cold = row('a', { standalone: true })
    const s = state({
      base: { blank: true, gen: 3 },
      rows: [cold],
      baseFetch: { url: '/users', visit: visit('w'), startOnSwap: false },
    })

    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', change: 'other' })).state).toEqual(
      state({ base: { blank: false, gen: 4 }, rows: [cold], paint: { gated: true, owed: false } }),
    )
  })

  it('the answer to a navigation drops the stack even when it lands on the very same page', () => {
    const s = state({ base: { blank: false, gen: 3 }, rows: [row('a')] })

    expect(reduce(s, committing({ answer: 'navigation', mode: 'replace', change: 'same' }))).toEqual({
      state: state({ base: { blank: false, gen: 4 }, paint: { gated: true, owed: true } }),
      effects: [{ type: 'dispose', ids: ['a'], reason: 'navigated' }],
      outcome: none,
    })
  })

  it('L:1216 a plain page answering the global router with a layer open passes to 3.x', () => {
    const s = state({ rows: [row('a')] })

    expect(arrived(s, { origin: baseOrigin({ top: 'a' }), facts: { partial: false } })).toEqual({
      state: s,
      effects: [],
      outcome: landing('pass'),
    })
  })

  it('L:1468 a local layer opens with no request and pushes one entry; Back dismisses it; Forward reopens it', () => {
    const opened = script(state(), [
      { type: 'localOpened', id: id('l'), owner: 'base', key: 'Confirm' },
      { type: 'layerCommitting', id: id('l'), requestedReplace: false, urlChanged: false },
    ])
    const local = row('l', { type: 'local', key: 'Confirm', ownsAddress: false })

    expect(opened.state).toEqual(state({ rows: [local] }))
    expect(opened.effects).toEqual([{ type: 'writeEntry', mode: 'push', charged: 'l' }])

    const back = reduce(opened.state, { type: 'popstate', entry: entry([]) })

    expect(back).toEqual({
      state: state({ dismissed: [id('l')] }),
      effects: [{ type: 'cancelAll' }, { type: 'paint' }],
      outcome: handled,
    })

    const forward = reduce(back.state, {
      type: 'popstate',
      entry: entry([entryLayer('l', { type: 'local', key: 'Confirm', ownsAddress: false })]),
    })

    expect(forward).toEqual({
      state: state({ rows: [local] }),
      effects: [
        { type: 'dispose', ids: ['l'], reason: 'restored-away' },
        { type: 'reopen', ids: ['l'] },
        { type: 'cancelAll' },
        { type: 'paint' },
      ],
      outcome: handled,
    })
  })
})

describe('rewrites and refreshes', () => {
  it('L:797 a same-key answer rewrites the row in place with a remount, and its new url pushes', () => {
    const { state: s, effects } = script(state({ rows: [row('a', { key: 'step' })] }), [
      arrival({ origin: baseOrigin({ top: 'a' }), layer: { key: 'step', base: '/base' } }),
      { type: 'layerCommitting', id: id('a'), requestedReplace: false, urlChanged: true },
    ])

    expect(s).toEqual(state({ rows: [row('a', { key: 'step', entries: 2, renderKey: 1 })] }))
    expect(effects).toEqual([{ type: 'writeEntry', mode: 'push', charged: 'a' }])
  })

  it('L:818 L:105 L:476 a same-key answer that preserves state rewrites without a remount', () => {
    const s = state({ rows: [row('a', { key: 'step' })] })

    expect(
      arrived(s, { origin: layerOrigin('a'), layer: { key: 'step', base: '/base' }, facts: { preserveState: true } }),
    ).toEqual({
      state: s,
      effects: [],
      outcome: landing('rewrite', { id: 'a', dismissed: [], remount: false }),
    })
  })

  it('L:832 an answer for an earlier level dismisses the rows above as ghosts and takes over their entries', () => {
    const s = state({ rows: [row('a', { key: 'step' }), row('b', { entries: 2 })] })

    expect(arrived(s, { origin: baseOrigin({ top: 'b' }), layer: { key: 'step', base: '/base' } })).toEqual({
      state: state({ rows: [row('a', { key: 'step', entries: 3, renderKey: 1 })], dismissed: [id('b')] }),
      effects: [{ type: 'paint' }],
      outcome: landing('rewrite', { id: 'a', dismissed: ['b'], remount: true }),
    })
  })

  it('L:857 Back between wizard steps rewinds the row to its entry; closing unwinds every entry it pushed', () => {
    const s = state({ rows: [row('a', { key: 'step', entries: 2 })] })

    expect(
      reduce(s, { type: 'popstate', entry: entry([entryLayer('a', { key: 'step' })], { sameSnapshot: new Set() }) }),
    ).toEqual({
      state: state({ rows: [row('a', { key: 'step', entries: 1 })] }),
      effects: [{ type: 'rewind', ids: ['a'] }, { type: 'cancelAll' }, { type: 'paint' }],
      outcome: handled,
    })

    const closed = script(s, [
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('a') },
    ])

    expect(closed.effects).toEqual([{ type: 'paint' }, { type: 'historyGo', delta: -2, token: 1 }])
  })

  it('L:878 a remounting landing on a row whose close is still exiting abandons that close', () => {
    const s = state({
      rows: [row('a', { key: 'bottom', close: cid('c1') }), row('b', { close: cid('c1') })],
      closes: closes(close('c1', ['a', 'b'], { exited: [id('b')], waiters: [wid('w1')] })),
    })

    expect(
      arrived(s, {
        origin: baseOrigin({ top: 'b' }),
        layer: { key: 'bottom', base: '/base' },
        facts: { partial: true },
      }),
    ).toEqual({
      state: state({ rows: [row('a', { key: 'bottom', renderKey: 1 }), row('b')] }),
      effects: [{ type: 'settle', waiters: ['w1'], result: 'abandoned' }, { type: 'paint' }],
      outcome: landing('refresh', { id: 'a', remount: true }),
    })
  })

  it('L:878 a state-preserving landing (poll, deferred) leaves a close the user started alone', () => {
    const s = state({
      rows: [row('a', { key: 'bottom', close: cid('c1') })],
      closes: closes(close('c1', ['a'])),
    })

    expect(
      arrived(s, {
        origin: layerOrigin('a'),
        layer: { key: 'bottom', base: '/base' },
        facts: { partial: true, preserveState: true },
      }),
    ).toEqual({ state: s, effects: [], outcome: landing('refresh', { id: 'a', remount: false }) })
  })

  it('L:1167 L:1197 L:1298 a partial answer made from a layer refreshes that layer', () => {
    const s = state({ rows: [row('a', { key: 'counted' })] })

    expect(
      arrived(s, {
        origin: layerOrigin('a'),
        layer: { key: 'counted', base: '/base' },
        facts: { partial: true, async: true, preserveState: true },
      }),
    ).toEqual({ state: s, effects: [], outcome: landing('refresh', { id: 'a', remount: false }) })
  })

  it('L:1549 a layer owning no address reloads itself, not the base', () => {
    const s = state({ rows: [row('a', { key: 'other', ownsAddress: false })] })

    expect(
      arrived(s, {
        origin: layerOrigin('a'),
        layer: { key: 'renamed', base: '/base' },
        facts: { partial: true, preserveState: true },
      }).outcome,
    ).toEqual(landing('refresh', { id: 'a', remount: false }))
  })

  it('L:1527 an instant visit inside a layer lands on that layer, which takes its key, and its new url pushes', () => {
    const {
      state: s,
      effects,
      last,
    } = script(state({ rows: [row('a', { key: 'panel:first' })] }), [
      arrival({ origin: layerOrigin('a', true), layer: { key: 'panel:second', base: '/base' } }),
    ])

    expect(last.outcome).toEqual(landing('refresh', { id: 'a', remount: false }))
    expect(reduce(s, { type: 'layerCommitting', id: id('a'), requestedReplace: false, urlChanged: true })).toEqual({
      state: state({ rows: [row('a', { key: 'panel:second', entries: 2 })] }),
      effects: [{ type: 'writeEntry', mode: 'push', charged: 'a' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'push' } },
    })
    expect(effects).toEqual([])
  })

  it('drops a background answer made from the base that matches no layer', () => {
    const s = state({ rows: [row('a')] })

    expect(
      arrived(s, {
        origin: baseOrigin({ top: 'a' }),
        layer: { key: 'other', base: '/base' },
        facts: { async: true, preserveState: true },
      }),
    ).toEqual({ state: s, effects: [], outcome: landing('drop') })
  })
})

describe('layer commits', () => {
  const committingA = (s: StackState, requestedReplace: boolean, urlChanged: boolean) =>
    reduce(s, { type: 'layerCommitting', id: id('a'), requestedReplace, urlChanged })

  it('L:545 L:1491 the first commit of an opening row pushes and is charged one entry', () => {
    expect(committingA(state({ rows: [row('a', { phase: 'opening', entries: 0 })] }), false, false)).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'writeEntry', mode: 'push', charged: 'a' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'push' } },
    })
  })

  it('an opening visit that asked to replace replaces and is charged nothing', () => {
    expect(committingA(state({ rows: [row('a', { phase: 'opening', entries: 0 })] }), true, false)).toEqual({
      state: state({ rows: [row('a', { entries: 0 })] }),
      effects: [{ type: 'writeEntry', mode: 'replace' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'replace' } },
    })
  })

  it('L:925 a standalone row inserted beneath by the walk replaces', () => {
    expect(
      committingA(state({ rows: [row('a', { phase: 'opening', entries: 0, standalone: true })] }), false, false),
    ).toEqual({
      state: state({ rows: [row('a', { entries: 0, standalone: true })] }),
      effects: [{ type: 'writeEntry', mode: 'replace' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'replace' } },
    })
  })

  it('an open row staying on its url replaces', () => {
    expect(committingA(state({ rows: [row('a')] }), true, false)).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'writeEntry', mode: 'replace' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'replace' } },
    })
  })

  it('a row no longer in the model is skipped', () => {
    const s = state({ rows: [row('b')], dismissed: [id('a')] })

    expect(committingA(s, false, false)).toEqual({
      state: s,
      effects: [],
      outcome: { kind: 'commit', decision: { kind: 'skip' } },
    })
  })
})

describe('the paint gate', () => {
  it('holds a layer swap while the base commits and pays it at baseSwapped', () => {
    const gated = state({ rows: [row('a')], paint: { gated: true, owed: false } })
    const swapped = reduce(gated, { type: 'layerSwapped', id: id('a') })

    expect(swapped).toEqual({
      state: state({ rows: [row('a')], paint: { gated: true, owed: true } }),
      effects: [],
      outcome: none,
    })
    expect(reduce(swapped.state, { type: 'baseSwapped' })).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'paint' }],
      outcome: none,
    })
  })

  it('paints a layer swap at once while the gate is open, and ignores a layer that left', () => {
    const s = state({ rows: [row('a')] })

    expect(reduce(s, { type: 'layerSwapped', id: id('a') })).toEqual({
      state: s,
      effects: [{ type: 'paint' }],
      outcome: none,
    })
    expect(reduce(state(), { type: 'layerSwapped', id: id('a') })).toEqual({
      state: state(),
      effects: [],
      outcome: none,
    })
  })

  it('opens without a paint when nothing changed while closed; an idle base commit still moves the gen', () => {
    expect(reduce(state({ paint: { gated: true, owed: false } }), { type: 'baseSwapped' })).toEqual({
      state: state(),
      effects: [],
      outcome: none,
    })
    expect(reduce(state(), committing({ mode: 'push' }))).toEqual({
      state: state({ base: { blank: false, gen: 1 }, paint: { gated: true, owed: false } }),
      effects: [],
      outcome: none,
    })
  })

  it('L:723 a ghost is disposed once its exit finished, and painted away', () => {
    expect(reduce(state({ rows: [row('a')], dismissed: [id('b')] }), { type: 'exited', id: id('b') })).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'dispose', ids: ['b'], reason: 'closed' }, { type: 'paint' }],
      outcome: none,
    })
  })
})

describe('closing', () => {
  it('L:652 L:757 L:1572 L:1613 a close keeps its rows until every exit finished, unwinds, refreshes beneath, then settles', () => {
    const marked = reduce(state({ rows: [row('a')] }), {
      type: 'closeRequested',
      target: 'top',
      close: cid('c1'),
      waiter: wid('w1'),
    })

    expect(marked).toEqual({
      state: state({
        rows: [row('a', { close: cid('c1') })],
        closes: closes(close('c1', ['a'], { waiters: [wid('w1')] })),
      }),
      effects: [{ type: 'paint' }],
      outcome: none,
    })

    const unwinding = reduce(marked.state, { type: 'exited', id: id('a') })

    expect(unwinding).toEqual({
      state: state({
        nextToken: 2,
        rows: [row('a', { close: cid('c1') })],
        closes: closes(
          close('c1', ['a'], { exited: [id('a')], waiters: [wid('w1')], phase: { kind: 'unwinding', token: tok(1) } }),
        ),
        expect: { kind: 'unwind', close: cid('c1'), token: tok(1) },
      }),
      effects: [{ type: 'historyGo', delta: -1, token: 1 }],
      outcome: none,
    })

    const answered = reduce(unwinding.state, { type: 'popstate', entry: entry([]) })

    expect(answered).toEqual({
      state: state({
        nextToken: 2,
        closes: closes(
          close('c1', ['a'], { exited: [id('a')], waiters: [wid('w1')], phase: { kind: 'refreshing', visit: null } }),
        ),
      }),
      effects: [
        { type: 'writeEntry', mode: 'replace' },
        { type: 'paint' },
        { type: 'startVisit', tag: { kind: 'refresh', close: 'c1' }, via: 'base', url: null },
      ],
      outcome: handled,
    })

    const { state: s, effects } = script(answered.state, [
      { type: 'unwindSettled', token: tok(1), how: 'answered' },
      { type: 'visitDispatched', visit: visit('r1'), tag: { kind: 'refresh', close: cid('c1') } },
      { type: 'visitFinished', visit: visit('r1') },
    ])

    expect(effects).toEqual([
      { type: 'dispose', ids: ['a'], reason: 'closed' },
      { type: 'settle', waiters: ['w1'], result: 'closed' },
    ])
    expect(s).toEqual(state({ nextToken: 2 }))
  })

  it('L:673 closing a lower layer marks every layer above and waits for all their exits', () => {
    const { state: s, effects } = script(state({ rows: [row('a'), row('b')] }), [
      { type: 'closeRequested', target: id('a'), close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('b') },
    ])

    expect(effects).toEqual([{ type: 'paint' }])
    expect(s.closes.get(cid('c1'))).toEqual(close('c1', ['a', 'b'], { exited: [id('b')], waiters: [wid('w1')] }))
    expect(reduce(s, { type: 'exited', id: id('a') }).effects).toEqual([{ type: 'historyGo', delta: -2, token: 1 }])
  })

  it('L:694 L:1425 closing a middle layer removes it and everything above, and refreshes the routed row beneath', () => {
    const { state: s, effects } = script(state({ rows: [row('a'), row('b'), row('c')] }), [
      { type: 'closeRequested', target: id('b'), close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('c') },
      { type: 'exited', id: id('b') },
      { type: 'popstate', entry: entry([entryLayer('a')]) },
    ])

    expect(effects).toEqual([
      { type: 'paint' },
      { type: 'historyGo', delta: -2, token: 1 },
      { type: 'writeEntry', mode: 'replace' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'refresh', close: 'c1' }, via: 'a', url: null },
    ])
    expect(s.rows).toEqual([row('a')])
  })

  it('L:773 L:1510 closing a layer that never moved the address unwinds only its own entry and leaves the one beneath', () => {
    const { state: s, effects } = script(state({ rows: [row('a'), row('b', { ownsAddress: false })] }), [
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('b') },
    ])

    expect(effects).toEqual([{ type: 'paint' }, { type: 'historyGo', delta: -1, token: 1 }])
    expect(s.rows).toEqual([row('a'), row('b', { ownsAddress: false, close: cid('c1') })])
  })

  it('L:993 L:1586 closing a cold layer over a real base pushes the base as its own step and refreshes it', () => {
    const { state: s, effects } = script(state({ rows: [row('a', { standalone: true, entries: 0 })] }), [
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('a') },
    ])

    expect(effects).toEqual([
      { type: 'paint' },
      { type: 'writeEntry', mode: 'push' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'refresh', close: 'c1' }, via: 'base', url: null },
    ])
    expect(s.rows).toEqual([])
  })

  it('closing a cold layer with layers stepped over it unwinds those entries, then pushes the base', () => {
    const rows = [row('a', { standalone: true, entries: 0 }), row('b'), row('c')]
    const stepped = script(state({ rows }), [
      { type: 'closeRequested', target: id('a'), close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('c') },
      { type: 'exited', id: id('b') },
      { type: 'exited', id: id('a') },
    ])

    expect(stepped.effects).toEqual([{ type: 'paint' }, { type: 'historyGo', delta: -2, token: 1 }])
    expect(stepped.state.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])

    // The step back lands on the entry that still holds the cold layer: it is not put back.
    const landed = reduce(stepped.state, {
      type: 'popstate',
      entry: entry([entryLayer('a', { standalone: true, entries: 0 })]),
    })

    expect(landed.effects).toEqual([
      { type: 'writeEntry', mode: 'push' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'refresh', close: 'c1' }, via: 'base', url: null },
    ])
    expect(landed.state.rows).toEqual([])
    expect(landed.outcome).toEqual(handled)
  })

  it('L:425 a local layer closes without a refresh beneath', () => {
    const { effects } = script(state({ rows: [row('a'), row('l', { type: 'local', ownsAddress: false })] }), [
      { type: 'closeRequested', target: id('l'), close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('l') },
      { type: 'popstate', entry: entry([entryLayer('a')]) },
    ])

    expect(effects).toEqual([
      { type: 'paint' },
      { type: 'historyGo', delta: -1, token: 1 },
      { type: 'writeEntry', mode: 'replace' },
      { type: 'paint' },
      { type: 'dispose', ids: ['l'], reason: 'closed' },
      { type: 'settle', waiters: ['w1'], result: 'closed' },
    ])
  })

  it('L:1624 a server close answer closes its origin layer, succeeding against the tier beneath', () => {
    expect(
      arrived(state({ rows: [row('a'), row('b')] }), { origin: layerOrigin('b'), close: true, newClose: 'c9' }),
    ).toEqual({
      state: state({ rows: [row('a'), row('b', { close: cid('c9') })], closes: closes(close('c9', ['b'])) }),
      effects: [{ type: 'paint' }],
      outcome: landing('close', { id: 'b', beneath: 'a' }),
    })
  })

  it('L:1624 a base-made close answer closes the top layer live at dispatch, and is ignored with nothing open', () => {
    expect(arrived(state({ rows: [row('a')] }), { origin: baseOrigin({ top: 'a' }), close: true }).outcome).toEqual(
      landing('close', { id: 'a', beneath: 'base' }),
    )
    expect(arrived(state(), { close: true })).toEqual({ state: state(), effects: [], outcome: landing('pass') })
  })

  it('L:1599 a plain answer to a write made from a layer that has since closed lands on the base', () => {
    expect(arrived(state(), { origin: layerOrigin('a') }).outcome).toEqual(landing('base'))
  })

  it('L:1747 L:1759 Escape closes the top open layer only, skipping one still opening', () => {
    const s = state({ rows: [row('a'), row('b'), row('c', { phase: 'opening', entries: 0 })] })

    expect(
      reduce(s, { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') }).state.closes,
    ).toEqual(closes(close('c1', ['b', 'c'], { exited: [id('c')], waiters: [wid('w1')] })))
  })

  it('settles the waiter of a close whose layer is already gone', () => {
    expect(reduce(state(), { type: 'closeRequested', target: id('a'), close: cid('c1'), waiter: wid('w1') })).toEqual({
      state: state(),
      effects: [{ type: 'settle', waiters: ['w1'], result: 'closed' }],
      outcome: none,
    })
  })

  it('L:1599 a close that finishes its exit while another unwinds queues, and starts when that one is answered', () => {
    const s = state({
      nextToken: 2,
      rows: [row('a'), row('b', { close: cid('c1') })],
      closes: closes(close('c1', ['b'], { exited: [id('b')], phase: { kind: 'unwinding', token: tok(1) } })),
      expect: { kind: 'unwind', close: cid('c1'), token: tok(1) },
    })
    const { state: queued } = script(s, [
      { type: 'closeRequested', target: id('a'), close: cid('c2'), waiter: wid('w2') },
      { type: 'exited', id: id('a') },
    ])

    expect(queued.closes.get(cid('c2'))!.phase).toEqual({ kind: 'queued' })

    const answered = reduce(queued, { type: 'popstate', entry: entry([entryLayer('a')]) })

    expect(answered.effects).toEqual([
      { type: 'writeEntry', mode: 'replace' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'refresh', close: 'c1' }, via: 'a', url: null },
      { type: 'historyGo', delta: -1, token: 2 },
    ])
    expect(answered.state.expect).toEqual({ kind: 'unwind', close: cid('c2'), token: tok(2) })
  })
})
