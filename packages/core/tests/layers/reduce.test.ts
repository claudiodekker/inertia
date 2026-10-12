import { describe, expect, it } from 'vitest'
import { entryRows } from '../../src/layers/close'
import { reduce } from '../../src/layers/reduce'
import { MAX_LAYER_CHAIN, type StackEvent, type StackState } from '../../src/layers/state'
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
} from './fixtures'

const landing = (kind: string, extra: object = {}) => ({ kind: 'landing', landing: { kind, ...extra } })
const none = { kind: 'none' }
const handled = { kind: 'restore', restore: { kind: 'handled' } }

const walking = (overrides: Partial<StackState> = {}) =>
  state({
    rows: [row('a', { standalone: true, entries: 0 })],
    base: { blank: true, gen: 0 },
    walk: { target: '/base', visit: visit('v1'), startOnSwap: false },
    ops: new Map([[visit('v1'), { kind: 'walk', inFlight: 1, landed: false }]]),
    ...overrides,
  })

const pinnedOver = (overrides: Partial<StackState> = {}) =>
  state({
    base: { blank: false, gen: 1 },
    nextToken: 2,
    pin: { token: tok(1), gen: 1, pushes: 1, ticket: id('t1'), suspended: [row('a')] },
    tickets: new Map([[id('t1'), { id: id('t1'), owner: 'base', state: 'dispatched' }]]),
    ...overrides,
  })

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
    const s = state({ base: { blank: false, gen: 3 }, rows: [row('a'), row('b')], ghosts: [id('c')] })

    expect(reduce(s, committing({ mode: 'push', against: 'same' }))).toEqual({
      state: state({ base: { blank: false, gen: 4 }, paint: { gated: true, owed: true } }),
      effects: [{ type: 'dispose', ids: ['a', 'b', 'c'], reason: 'navigated' }],
      outcome: none,
    })
    expect(reduce(state({ rows: [row('a')] }), committing({ mode: 'replace', against: 'other' })).state.rows).toEqual(
      [],
    )
  })

  it('L:527 L:1144 L:1216 a replace of the same base page keeps the stack and closes the gate', () => {
    expect(reduce(state({ rows: [row('a')] }), committing({ mode: 'replace', against: 'same' }))).toEqual({
      state: state({ rows: [row('a')], paint: { gated: true, owed: false } }),
      effects: [],
      outcome: none,
    })
  })

  it('the answer to a partial or a reload keeps the stack while the base stays on its component', () => {
    const s = state({ base: { blank: false, gen: 3 }, rows: [row('a')] })
    const kept = (gen: number) =>
      state({ base: { blank: false, gen }, rows: [row('a')], paint: { gated: true, owed: false } })

    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', against: 'same' })).state).toEqual(kept(3))
    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', against: 'moved' })).state).toEqual(kept(4))
    expect(reduce(s, committing({ answer: 'refresh', mode: 'push', against: 'elsewhere' })).state).toEqual(kept(4))
    expect(reduce(s, committing({ answer: 'refresh', mode: 'push', against: 'other' })).state.rows).toEqual([])
  })

  it('the answer to a partial or a reload that fills a blank base keeps the stack and ends the walk', () => {
    const cold = row('a', { standalone: true })
    const s = state({
      base: { blank: true, gen: 3 },
      rows: [cold],
      walk: { target: '/users', visit: visit('w'), startOnSwap: false },
    })

    expect(reduce(s, committing({ answer: 'refresh', mode: 'replace', against: 'other' })).state).toEqual(
      state({ base: { blank: false, gen: 4 }, rows: [cold], paint: { gated: true, owed: false } }),
    )
  })

  it('the answer to a navigation drops the stack even when it lands on the very same page', () => {
    const s = state({ base: { blank: false, gen: 3 }, rows: [row('a')] })

    expect(reduce(s, committing({ answer: 'navigation', mode: 'replace', against: 'same' }))).toEqual({
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
      state: state({ ghosts: [id('l')] }),
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
      state: state({ rows: [row('a', { key: 'step', entries: 3, renderKey: 1 })], ghosts: [id('b')] }),
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
    const s = state({ rows: [row('b')], ghosts: [id('a')] })

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
    expect(reduce(state({ rows: [row('a')], ghosts: [id('b')] }), { type: 'exited', id: id('b') })).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'dispose', ids: ['b'], reason: 'closed' }, { type: 'paint' }],
      outcome: none,
    })
  })
})

describe('cold boot and the walk', () => {
  it('S:394 L:914 a cold boot seeds the layer on a blank base, walks after the first swap, and the hop lands the base', () => {
    const seed = {
      id: id('a'),
      type: 'routed' as const,
      key: 'panel',
      owner: 'base' as const,
      standalone: true,
      ownsAddress: true,
      entries: 0,
    }
    const booted = reduce(state(), { type: 'booted', seeds: [seed], blank: true, walkTo: '/base' })

    expect(booted.state).toEqual(
      state({
        rows: [row('a', { key: 'panel', standalone: true, entries: 0 })],
        base: { blank: true, gen: 0 },
        walk: { target: '/base', visit: null, startOnSwap: true },
        paint: { gated: true, owed: true },
      }),
    )

    const { state: s, effects } = script(booted.state, [
      committing({ initial: true, mode: 'replace' }),
      { type: 'baseSwapped' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'walk' } },
      arrival({ visit: 'v1' }),
      committing({ visit: visit('v1'), mode: 'replace' }),
      { type: 'baseSwapped' },
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects).toEqual([
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: '/base' },
    ])
    expect(s).toEqual(state({ rows: [row('a', { key: 'panel', standalone: true, entries: 0 })] }))
  })

  it('L:925 a hop answered by a layer with its own base goes beneath, and the walk goes on', () => {
    const step = arrived(walking(), { visit: 'v1', layer: { key: 'inner', base: '/deeper' }, newId: 'inner' })

    expect(step).toEqual({
      state: walking({
        rows: [
          row('inner', { key: 'inner', standalone: true, phase: 'opening', entries: 0 }),
          row('a', { standalone: true, entries: 0 }),
        ],
        walk: { target: '/deeper', visit: null, startOnSwap: false },
        ops: new Map([[visit('v1'), { kind: 'walk', inFlight: 1, landed: true }]]),
      }),
      effects: [
        { type: 'retargetBlank', url: '/deeper' },
        { type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: '/deeper' },
      ],
      outcome: landing('walk-beneath', { id: 'inner' }),
    })
  })

  it(`stops a walk whose next layer would make the stack ${MAX_LAYER_CHAIN} deep, landing the answer as the base with a warning`, () => {
    const s = walking({
      rows: Array.from({ length: MAX_LAYER_CHAIN - 1 }, (_, depth) =>
        row(`r${depth}`, { standalone: true, entries: 0 }),
      ),
    })

    expect(arrived(s, { visit: 'v1', layer: { key: 'deep', base: '/deeper' } })).toEqual({
      state: { ...s, ops: new Map([[visit('v1'), { kind: 'walk', inFlight: 1, landed: true }]]) },
      effects: [
        {
          type: 'warn',
          message:
            'A layer chain more than 10 layers deep was declared, so "/deeper" was not fetched. The deepest layer that loaded is being used as the page.',
        },
      ],
      outcome: landing('walk-base'),
    })
  })

  it('lands a hop whose declared base cycles back to a live row as the base, without a warning', () => {
    expect(
      arrived(walking(), { visit: 'v1', layer: { key: 'loop', base: '/panel' }, facts: { cycles: true } }).effects,
    ).toEqual([])
  })

  it('L:1037 a failed hop promotes the deepest layer to the page, and the base swap paints its dialog away', () => {
    const { state: s, effects } = script(walking(), [
      { type: 'walkHopFailed', visit: visit('v1') },
      committing({ visit: visit('1'), mode: 'replace' }),
      { type: 'visitFinished', visit: visit('v1') },
      { type: 'baseSwapped' },
    ])

    expect(effects).toEqual([
      { type: 'installBase', token: 1, source: { kind: 'promote', layer: 'a' }, mode: 'replace' },
      { type: 'dispose', ids: ['a'], reason: 'closed' },
      { type: 'paint' },
    ])
    expect(s).toEqual(state({ nextToken: 2, paint: { gated: false, owed: false } }))
  })

  it('L:1047 a hop that fails after its layer closed requests the base again, and that commit keeps the stack', () => {
    const { state: s, effects } = script(walking({ rows: [] }), [
      { type: 'walkHopFailed', visit: visit('v1') },
      { type: 'visitFinished', visit: visit('v1') },
      { type: 'visitDispatched', visit: visit('v2'), tag: { kind: 'recover' } },
      committing({ visit: visit('v2'), mode: 'replace' }),
      { type: 'visitFinished', visit: visit('v2') },
    ])

    expect(effects).toEqual([{ type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: '/base' }])
    expect(s).toEqual(state({ paint: { gated: true, owed: false } }))
  })

  it('L:1047 a hop cancelled or answered by a 409 location fails the walk at its finish', () => {
    expect(reduce(walking({ rows: [] }), { type: 'visitFinished', visit: visit('v1') }).effects).toEqual([
      { type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: '/base' },
    ])
  })

  it('L:1090 L:2140 closing a cold layer over the blank base pushes the placeholder and skips the refresh', () => {
    const { state: s, effects } = script(walking(), [
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('a') },
    ])

    expect(effects).toEqual([
      { type: 'paint' },
      { type: 'writeEntry', mode: 'push' },
      { type: 'paint' },
      { type: 'dispose', ids: ['a'], reason: 'closed' },
      { type: 'settle', waiters: ['w1'], result: 'closed' },
    ])
    expect(s).toEqual(walking({ rows: [] }))
  })

  it('L:1090 Back onto a plain entry while the base is still out ends the walk, so no hop or recovery lands on it', () => {
    const {
      state: s,
      effects,
      last,
    } = script(walking({ rows: [] }), [
      { type: 'popstate', entry: entry([], { url: '/layers/slow-base-panel', baseSame: false }) },
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects).toEqual([])
    expect(last.outcome).toEqual(none)
    expect(s).toEqual(state({ base: { blank: false, gen: 1 }, paint: { gated: true, owed: true } }))
    expect(reduce(walking({ rows: [] }), { type: 'popstate', entry: entry([], { baseSame: false }) }).outcome).toEqual({
      kind: 'restore',
      restore: { kind: 'base' },
    })
  })

  it.each([
    ['with nothing on it', walking({ rows: [] }), entry([], { url: '/base', blank: true })],
    ['of another base', walking(), entry([], { url: '/other', blank: true, baseSame: false })],
  ])('Back onto a blank placeholder %s fetches its page once: the recovery ends the walk', (_, from, blank) => {
    const { state: s, effects } = script(from, [
      { type: 'popstate', entry: blank },
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects.filter((effect) => effect.type === 'startVisit')).toEqual([
      { type: 'startVisit', tag: { kind: 'recover' }, via: 'base', url: blank.url },
    ])
    expect(s.walk).toBeNull()
    expect(s.base.blank).toBe(true)
  })

  it('L:2165 a close during the walk landing sends the walk again, and the first commit to arrive lands the base', () => {
    const closing = script(walking(), [
      arrival({ visit: 'v1' }),
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('a') },
    ])

    expect(closing.effects.filter((effect) => effect.type === 'startVisit')).toEqual([
      { type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: '/base' },
    ])
    expect(closing.state.walk).toEqual({ target: '/base', visit: null, startOnSwap: false })

    const { state: s, last } = script(closing.state, [
      { type: 'visitDispatched', visit: visit('v2'), tag: { kind: 'walk' } },
      committing({ visit: visit('v1'), mode: 'replace' }),
      arrival({ visit: 'v2' }),
    ])

    expect(s.base).toEqual({ blank: false, gen: 0 })
    expect(s.walk).toBeNull()
    expect(last.outcome).toEqual(landing('drop'))
  })

  it('L:2165 the walk sent again lands the base when its answer commits first', () => {
    const { state: s, last } = script(walking(), [
      arrival({ visit: 'v1' }),
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('a') },
      { type: 'visitDispatched', visit: visit('v2'), tag: { kind: 'walk' } },
      arrival({ visit: 'v2' }),
    ])

    expect(last.outcome).toEqual(landing('walk-base'))
    expect(reduce(s, committing({ visit: visit('v2'), mode: 'replace' })).state).toMatchObject({
      base: { blank: false, gen: 0 },
      walk: null,
    })
  })

  it('L:212 an in-session cold landing installs the blank under the layer with one push, then walks', () => {
    const { state: s, effects } = script(state(), [
      arrival({ layer: { key: 'guarded', base: '/layers/base' } }),
      { type: 'layerCommitting', id: id('new'), requestedReplace: false, urlChanged: false },
      { type: 'layerSwapped', id: id('new') },
      committing({ visit: visit('1'), mode: 'push' }),
      { type: 'baseSwapped' },
    ])

    expect(effects).toEqual([
      { type: 'installBase', token: 1, source: { kind: 'blank', url: '/layers/base' }, mode: 'push' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'walk' }, via: 'base', url: '/layers/base' },
    ])
    expect(s).toEqual(
      state({
        nextToken: 2,
        rows: [row('new', { key: 'guarded', standalone: true, entries: 0 })],
        base: { blank: true, gen: 1 },
        walk: { target: '/layers/base', visit: null, startOnSwap: false },
      }),
    )
  })

  it('L:504 an answer over the visit’s own instant placeholder lands cold, replacing it', () => {
    const step = arrived(state({ base: { blank: false, gen: 1 } }), {
      origin: baseOrigin({ gen: 0, instantGen: 1 }),
      layer: { key: 'panel', base: '/layers/base' },
      facts: { replace: true },
    })

    expect(step.outcome).toEqual(landing('cold', { id: 'new' }))
    expect(step.state.expect).toEqual({
      kind: 'base',
      token: 1,
      mode: 'replace',
      layer: 'new',
      source: { kind: 'blank', url: '/layers/base' },
    })
  })

  it('L:1120 an answer that cannot compose and declares no base lands as a plain page', () => {
    expect(arrived(state(), { layer: { key: 'plain', base: null } })).toEqual({
      state: state(),
      effects: [],
      outcome: landing('promote'),
    })
  })

  it('a document load onto a composite entry replaces the boot rows with the entry’s', () => {
    const s = state({ rows: [row('seed')], paint: { gated: true, owed: true } })

    expect(
      reduce(s, { type: 'restoredOnLoad', entry: entry([entryLayer('a'), entryLayer('b', { owner: id('a') })]) }),
    ).toEqual({
      state: state({ rows: [row('a'), row('b', { owner: id('a') })], paint: { gated: true, owed: true } }),
      effects: [
        { type: 'dispose', ids: ['seed'], reason: 'restored-away' },
        { type: 'reopen', ids: ['a', 'b'] },
      ],
      outcome: none,
    })
  })
})

describe('history', () => {
  it('L:545 L:585 L:723 Back off the top layer dismisses it through its exit, leaving the one beneath', () => {
    expect(
      reduce(state({ rows: [row('a'), row('b')] }), { type: 'popstate', entry: entry([entryLayer('a')]) }),
    ).toEqual({
      state: state({ rows: [row('a')], ghosts: [id('b')] }),
      effects: [{ type: 'cancelAll' }, { type: 'paint' }],
      outcome: handled,
    })
  })

  it('L:566 L:605 Forward reopens the entry’s layers with no request', () => {
    expect(
      reduce(state({ rows: [row('a')] }), {
        type: 'popstate',
        entry: entry([entryLayer('a'), entryLayer('b', { owner: id('a') })]),
      }),
    ).toEqual({
      state: state({ rows: [row('a'), row('b', { owner: id('a') })] }),
      effects: [{ type: 'reopen', ids: ['b'] }, { type: 'cancelAll' }, { type: 'paint' }],
      outcome: handled,
    })
  })

  it('L:741 history.go(-2) past the entry beneath drops the stack at once, with no exit', () => {
    expect(reduce(state({ rows: [row('a'), row('b')] }), { type: 'popstate', entry: entry([]) })).toEqual({
      state: state(),
      effects: [
        { type: 'dispose', ids: ['a', 'b'], reason: 'restored-away' },
        { type: 'cancelAll' },
        { type: 'paint' },
      ],
      outcome: handled,
    })
  })

  it('L:1455 a plain Back with no layer anywhere passes to 3.x', () => {
    expect(reduce(state(), { type: 'popstate', entry: entry([]) })).toEqual({
      state: state(),
      effects: [],
      outcome: { kind: 'restore', restore: { kind: 'pass' } },
    })
  })

  it('restores another base: drops the live rows, reopens the entry’s, and lets 3.x restore the base', () => {
    expect(
      reduce(state({ rows: [row('a')] }), { type: 'popstate', entry: entry([entryLayer('b')], { baseSame: false }) }),
    ).toEqual({
      state: state({ rows: [row('b')], base: { blank: false, gen: 1 }, paint: { gated: true, owed: true } }),
      effects: [
        { type: 'dispose', ids: ['a'], reason: 'restored-away' },
        { type: 'reopen', ids: ['b'] },
      ],
      outcome: { kind: 'restore', restore: { kind: 'base' } },
    })
  })
})

describe('the entries a restored row has pushed', () => {
  it('are the ones its entry counted, for every row that stays', () => {
    const step = reduce(state({ rows: [row('a', { entries: 3 }), row('b'), row('c')] }), {
      type: 'popstate',
      entry: entry([entryLayer('a', { entries: 2 }), entryLayer('b')]),
    })

    expect(step.state.rows).toEqual([row('a', { entries: 2 }), row('b')])
    expect(step.state.ghosts).toEqual(['c'])
  })
})

describe('the rows a history write holds', () => {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

  it('stores no row being closed, and keeps its address until its close steps back', () => {
    const rows = [row('a'), row('b', { close: cid('c1') }), row('c', { phase: 'opening' })]
    const exiting = entryRows(state({ rows, closes: closes(close('c1', ['b'])) }))

    expect([ids(exiting.stored), ids(exiting.addressed)]).toEqual([['a'], ['a', 'b']])

    const unwinding = entryRows(
      state({ rows, closes: closes(close('c1', ['b'], { phase: { kind: 'unwinding', token: tok(1) } })) }),
    )

    expect([ids(unwinding.stored), ids(unwinding.addressed)]).toEqual([['a'], ['a']])
  })
})

describe('a push the browser refused', () => {
  it('gives the entry back to the row that was charged for it, never below zero', () => {
    const refused = { type: 'writeRefused', id: id('a') } as const
    const s = state({ rows: [row('a', { entries: 1 }), row('b')] })

    expect(script(s, [refused]).state).toEqual(state({ rows: [row('a', { entries: 0 }), row('b')] }))
    expect(script(s, [refused, refused]).state).toEqual(state({ rows: [row('a', { entries: 0 }), row('b')] }))
    expect(reduce(state(), refused)).toEqual({ state: state(), effects: [], outcome: none })
  })
})

describe('an entry the browser pushed itself', () => {
  const anchored = { type: 'anchored' } as const

  it('is charged to the topmost layer that owns the address, whose url takes the hash', () => {
    const rows = [row('a'), row('b'), row('c', { ownsAddress: false }), row('d', { type: 'local', entries: 0 })]

    expect(reduce(state({ rows }), anchored)).toEqual({
      state: state({ rows: [rows[0], row('b', { entries: 2 }), rows[2], rows[3]] }),
      effects: [],
      outcome: { kind: 'anchor', owner: 'b' },
    })
  })

  it('is charged to the top layer when none owns the address, and the hash stays the base’s', () => {
    const rows = [row('a', { ownsAddress: false }), row('b', { type: 'local', entries: 0 })]

    expect(reduce(state({ rows }), anchored)).toEqual({
      state: state({ rows: [rows[0], row('b', { type: 'local', entries: 1 })] }),
      effects: [],
      outcome: { kind: 'anchor', owner: null },
    })
  })

  it('charges no layer that has not committed yet', () => {
    const rows = [row('a', { phase: 'opening', entries: 0 })]

    expect(reduce(state({ rows }), anchored)).toEqual({
      state: state({ rows }),
      effects: [],
      outcome: { kind: 'anchor', owner: null },
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

describe('tickets', () => {
  it('L:1312 L:1391 a ticket’s answer opens with the ticket’s id, owned by its opener, and the ticket is done', () => {
    const {
      state: s,
      effects,
      last,
    } = script(state(), [
      { type: 'openRequested', ticket: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
      arrival({ visit: 'v1', layer: { key: 'panel', base: '/base' } }),
    ])

    expect(last.outcome).toEqual(landing('open', { id: 't1', owner: 'base' }))

    const finished = reduce(s, { type: 'visitFinished', visit: visit('v1') })

    expect(finished.state).toEqual(state({ rows: [row('t1', { key: 'panel', phase: 'opening', entries: 0 })] }))
    expect([...effects, ...finished.effects]).toEqual([])
  })

  it('L:1376 a ticket opened from a layer is owned by that layer', () => {
    const { last } = script(state({ rows: [row('a')] }), [
      { type: 'openRequested', ticket: id('t1'), owner: id('a') },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
      arrival({ visit: 'v1', origin: layerOrigin('a'), layer: { key: 'child', base: '/base' } }),
    ])

    expect(last.outcome).toEqual(landing('open', { id: 't1', owner: 'a' }))
  })

  it('L:1562 L:1961 a ticket whose visit finished without landing on a row is refused', () => {
    const {
      state: s,
      effects,
      last,
    } = script(state(), [
      { type: 'openRequested', ticket: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
      arrival({ visit: 'v1' }),
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects).toEqual([{ type: 'refuse', ticket: 't1' }])
    expect(s).toEqual(state())
    expect(last.outcome).toEqual(none)
  })

  it('refuses a ticket its gate never dispatched, and leaves a dispatched one to its finish', () => {
    expect(
      script(state(), [
        { type: 'openRequested', ticket: id('t1'), owner: 'base' },
        { type: 'openRefused', ticket: id('t1') },
      ]),
    ).toMatchObject({ state: state(), effects: [{ type: 'refuse', ticket: 't1' }] })

    const dispatched = script(state(), [
      { type: 'openRequested', ticket: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
      { type: 'openRefused', ticket: id('t1') },
    ])

    expect(dispatched.effects).toEqual([])
    expect(dispatched.state.tickets.get(id('t1'))).toEqual({ id: 't1', owner: 'base', state: 'dispatched' })
  })

  it('gives up a ticket waiting on a prompt: the pin stays, and the layer answer after it returns under a fresh id', () => {
    const givenUp = reduce(pinnedOver(), { type: 'openRefused', ticket: id('t1') })

    expect(givenUp.effects).toEqual([{ type: 'refuse', ticket: 't1' }])
    expect(givenUp.state).toEqual(pinnedOver({ tickets: new Map() }))
    expect(
      arrived(givenUp.state, { origin: baseOrigin({ gen: 1 }), layer: { key: 'guarded', base: '/layers/base' } })
        .outcome,
    ).toEqual(landing('return', { id: 'new' }))
  })

  it('a plain page with errors answering a layer that owns no address hands its errors back to that layer', () => {
    const s = state({ rows: [row('a'), row('b', { ownsAddress: false })] })

    expect(arrived(s, { origin: layerOrigin('b'), facts: { matchesAddressTier: true, hasErrors: true } })).toEqual({
      state: s,
      effects: [],
      outcome: landing('handback', { id: 'b' }),
    })
    expect(arrived(s, { origin: layerOrigin('b'), facts: { matchesAddressTier: true } }).outcome).toEqual(
      landing('base'),
    )
    expect(
      arrived(s, { origin: layerOrigin('a'), facts: { matchesAddressTier: true, hasErrors: true } }).outcome,
    ).toEqual(landing('base'))
  })
})

describe('an open that shows a component at once', () => {
  const opened: StackEvent[] = [
    { type: 'openRequested', ticket: id('t1'), owner: id('a') },
    { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
    { type: 'placeholderOpened', ticket: id('t1'), ownsAddress: true },
  ]

  it('puts the layer up under the ticket id before any answer, keyed by that id, and the ticket is done', () => {
    const { state: s, effects } = script(state({ rows: [row('a')] }), opened)

    expect(s.rows).toEqual([row('a'), row('t1', { key: 't1', owner: id('a'), phase: 'opening', entries: 0 })])
    expect(s.tickets.size).toBe(0)
    expect(effects).toEqual([])
  })

  it('lands the answer on that layer, which takes the key the answer names', () => {
    const { state: s, last } = script(state({ rows: [row('a')] }), [
      ...opened,
      { type: 'layerCommitting', id: id('t1'), requestedReplace: false, urlChanged: false },
      arrival({ visit: 'v1', origin: layerOrigin('t1', true), layer: { key: 'Users/Edit', base: null } }),
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(last.effects).toEqual([])
    expect(s.rows.at(-1)).toEqual(row('t1', { key: 'Users/Edit', owner: id('a') }))
  })

  it('does nothing for a ticket that is gone', () => {
    const s = state({ rows: [row('a')] })

    expect(reduce(s, { type: 'placeholderOpened', ticket: id('t1'), ownsAddress: true }).state).toBe(s)
  })
})

describe('interstitials', () => {
  it('L:1937 L:2047 a prompt pins the stack; the layer answer after it returns the pinned base with the layer, one replace', () => {
    const pinned = script(state({ rows: [row('a')] }), [
      { type: 'openRequested', ticket: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
      committing({ visit: visit('v1'), mode: 'push', interstitial: true }),
      { type: 'visitFinished', visit: visit('v1') },
      { type: 'baseSwapped' },
    ])

    expect(pinned.effects).toEqual([{ type: 'capturePin', token: 1 }, { type: 'paint' }])
    expect(pinned.state).toEqual(
      state({
        nextToken: 2,
        base: { blank: false, gen: 1 },
        tickets: new Map([[id('t1'), { id: id('t1'), owner: 'base', state: 'dispatched' }]]),
        pin: { token: tok(1), gen: 1, pushes: 1, ticket: id('t1'), suspended: [row('a')] },
      }),
    )

    const {
      state: s,
      effects,
      last,
    } = script(pinned.state, [
      arrival({ visit: 'v2', origin: baseOrigin({ gen: 1 }), layer: { key: 'guarded', base: '/layers/base' } }),
      { type: 'layerCommitting', id: id('t1'), requestedReplace: false, urlChanged: false },
      committing({ visit: visit('2'), mode: 'replace' }),
    ])

    expect(effects).toEqual([
      { type: 'installBase', token: 2, source: { kind: 'pinned', pin: 1 }, mode: 'replace' },
      { type: 'releasePin', token: 1 },
    ])
    expect(last.outcome).toEqual(none)
    expect(s).toEqual(
      state({
        nextToken: 3,
        base: { blank: false, gen: 2 },
        rows: [row('a'), row('t1', { key: 'guarded', owner: id('a'), entries: 1 })],
        paint: { gated: true, owed: false },
      }),
    )
  })

  it('L:1975 a layer answer made while the prompt shows returns too, with a fresh id when no ticket waits', () => {
    expect(
      arrived(
        pinnedOver({ tickets: new Map(), pin: { token: tok(1), gen: 1, pushes: 1, ticket: null, suspended: [] } }),
        {
          origin: baseOrigin({ gen: 1 }),
          layer: { key: 'guarded', base: '/layers/base' },
        },
      ).outcome,
    ).toEqual(landing('return', { id: 'new' }))
  })

  it('L:1992 the return consumes the pin, so the next layer answer opens over the page on screen', () => {
    const returned = arrived(pinnedOver(), {
      origin: baseOrigin({ gen: 1 }),
      layer: { key: 'guarded', base: '/base' },
    }).state

    expect(returned.pin).toBeNull()
    expect(
      arrived(
        { ...returned, expect: null },
        { origin: baseOrigin({ gen: 2, top: 't1' }), layer: { key: 'next', base: '/base' } },
      ).outcome,
    ).toEqual(landing('open', { id: 'new', owner: 't1' }))
  })

  it('L:2013 navigating away from the prompt ends it: suspended rows go, the ticket is refused, the page released', () => {
    expect(reduce(pinnedOver(), committing({ mode: 'push' }))).toEqual({
      state: state({ nextToken: 2, base: { blank: false, gen: 2 }, paint: { gated: true, owed: false } }),
      effects: [
        { type: 'dispose', ids: ['a'], reason: 'navigated' },
        { type: 'refuse', ticket: 't1' },
        { type: 'releasePin', token: 1 },
      ],
      outcome: none,
    })
  })

  it('a wrong-password re-render of the prompt keeps the pin and moves its gen', () => {
    const step = reduce(pinnedOver(), committing({ mode: 'push', interstitial: true }))

    expect(step.state.pin).toEqual({ token: 1, gen: 2, pushes: 2, ticket: 't1', suspended: [row('a')] })
    expect(step.state.base).toEqual({ blank: false, gen: 2 })
    expect(step.effects).toEqual([])
  })

  it('L:2115 a prompt with nothing open pins an empty stack and paints nothing', () => {
    expect(reduce(state(), committing({ mode: 'push', interstitial: true }))).toEqual({
      state: state({
        nextToken: 2,
        base: { blank: false, gen: 1 },
        pin: { token: tok(1), gen: 1, pushes: 1, ticket: null, suspended: [] },
        paint: { gated: true, owed: false },
      }),
      effects: [{ type: 'capturePin', token: 1 }],
      outcome: none,
    })
  })

  it('L:2103 a layer answer that is also marked interstitial opens as a layer', () => {
    expect(arrived(state(), { layer: { key: 'prompted', base: '/base' }, facts: { aimed: true } }).outcome).toEqual(
      landing('open', { id: 'new', owner: 'base' }),
    )
  })
})

describe('hazards', () => {
  it('drops a layer answer, or a partial, made from a layer that closed: no state, no effects', () => {
    const s = state({ rows: [row('b')], ghosts: [id('a')] })

    expect(arrived(s, { origin: layerOrigin('a'), layer: { key: 'key:a', base: '/base' } })).toEqual({
      state: s,
      effects: [],
      outcome: landing('drop'),
    })
    expect(arrived(s, { origin: layerOrigin('a'), facts: { partial: true } })).toEqual({
      state: s,
      effects: [],
      outcome: landing('drop'),
    })
  })

  it('overlapping closes: a wider close adopts the narrower one’s waiters, and one refresh settles both', () => {
    const { state: s, effects } = script(state({ rows: [row('a'), row('b')] }), [
      { type: 'closeRequested', target: id('b'), close: cid('c1'), waiter: wid('w1') },
      { type: 'closeRequested', target: id('a'), close: cid('c2'), waiter: wid('w2') },
      { type: 'exited', id: id('b') },
    ])

    expect(s.closes).toEqual(closes(close('c2', ['a', 'b'], { exited: [id('b')], waiters: [wid('w1'), wid('w2')] })))
    expect(s.rows).toEqual([row('a', { close: cid('c2') }), row('b', { close: cid('c2') })])
    expect(effects).toEqual([{ type: 'paint' }, { type: 'paint' }])

    const done = script(s, [
      { type: 'exited', id: id('a') },
      { type: 'popstate', entry: entry([]) },
      { type: 'visitDispatched', visit: visit('r'), tag: { kind: 'refresh', close: cid('c2') } },
      { type: 'visitFinished', visit: visit('r') },
    ])

    expect(done.effects).toEqual([
      { type: 'historyGo', delta: -2, token: 1 },
      { type: 'writeEntry', mode: 'replace' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'refresh', close: 'c2' }, via: 'base', url: null },
      { type: 'dispose', ids: ['b', 'a'], reason: 'closed' },
      { type: 'settle', waiters: ['w1', 'w2'], result: 'closed' },
    ])
  })

  it('overlapping closes: a close already unwinding keeps its own refresh, and the wider one refreshes after it', () => {
    const s = state({
      nextToken: 2,
      rows: [row('a'), row('b', { close: cid('c1') })],
      closes: closes(
        close('c1', ['b'], { exited: [id('b')], waiters: [wid('w1')], phase: { kind: 'unwinding', token: tok(1) } }),
      ),
      expect: { kind: 'unwind', close: cid('c1'), token: tok(1) },
    })
    const { effects } = script(s, [
      { type: 'closeRequested', target: id('a'), close: cid('c2'), waiter: wid('w2') },
      { type: 'exited', id: id('a') },
      { type: 'popstate', entry: entry([entryLayer('a')]) },
      { type: 'visitDispatched', visit: visit('r1'), tag: { kind: 'refresh', close: cid('c1') } },
      { type: 'visitFinished', visit: visit('r1') },
      { type: 'popstate', entry: entry([]) },
      { type: 'visitDispatched', visit: visit('r2'), tag: { kind: 'refresh', close: cid('c2') } },
      { type: 'visitFinished', visit: visit('r2') },
    ])

    expect(effects).toEqual([
      { type: 'paint' },
      { type: 'writeEntry', mode: 'replace' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'refresh', close: 'c1' }, via: 'a', url: null },
      { type: 'historyGo', delta: -1, token: 2 },
      { type: 'dispose', ids: ['b'], reason: 'closed' },
      { type: 'settle', waiters: ['w1'], result: 'closed' },
      { type: 'writeEntry', mode: 'replace' },
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'refresh', close: 'c2' }, via: 'base', url: null },
      { type: 'dispose', ids: ['a'], reason: 'closed' },
      { type: 'settle', waiters: ['w2'], result: 'closed' },
    ])
  })

  it('a rewrite applies to its row while the layer it dismissed still plays its exit', () => {
    const { state: s, effects } = script(state({ rows: [row('a', { key: 'step' }), row('b')] }), [
      arrival({
        origin: baseOrigin({ top: 'b' }),
        layer: { key: 'step', base: '/base' },
        facts: { preserveState: true },
      }),
      { type: 'layerCommitting', id: id('a'), requestedReplace: false, urlChanged: true },
      { type: 'layerSwapped', id: id('a') },
    ])

    expect(s).toEqual(state({ rows: [row('a', { key: 'step', entries: 3 })], ghosts: [id('b')] }))
    expect(effects).toEqual([{ type: 'paint' }, { type: 'writeEntry', mode: 'push', charged: 'a' }, { type: 'paint' }])
    expect(reduce(s, { type: 'exited', id: id('b') }).effects).toEqual([
      { type: 'dispose', ids: ['b'], reason: 'closed' },
      { type: 'paint' },
    ])
  })

  it('Back clears the pin before anything else: suspended rows go, the ticket is refused, the page released', () => {
    expect(reduce(pinnedOver(), { type: 'popstate', entry: entry([]) })).toEqual({
      state: state({ nextToken: 2, base: { blank: false, gen: 1 } }),
      effects: [
        { type: 'dispose', ids: ['a'], reason: 'restored-away' },
        { type: 'refuse', ticket: 't1' },
        { type: 'releasePin', token: 1 },
      ],
      outcome: { kind: 'restore', restore: { kind: 'pass' } },
    })
  })

  it('an unwind the browser never answers removes the rows at the timeout', () => {
    const s = state({
      nextToken: 2,
      rows: [row('a', { close: cid('c1') })],
      closes: closes(close('c1', ['a'], { exited: [id('a')], phase: { kind: 'unwinding', token: tok(1) } })),
      expect: { kind: 'unwind', close: cid('c1'), token: tok(1) },
    })

    expect(reduce(s, { type: 'unwindSettled', token: tok(9), how: 'timeout' })).toEqual({
      state: s,
      effects: [],
      outcome: none,
    })
    expect(reduce(s, { type: 'unwindSettled', token: tok(1), how: 'timeout' })).toEqual({
      state: state({
        nextToken: 2,
        closes: closes(close('c1', ['a'], { exited: [id('a')], phase: { kind: 'refreshing', visit: null } })),
      }),
      effects: [
        { type: 'writeEntry', mode: 'replace' },
        { type: 'paint' },
        { type: 'startVisit', tag: { kind: 'refresh', close: 'c1' }, via: 'base', url: null },
      ],
      outcome: none,
    })
  })

  it('a stale walk hop drops: its answer, its failure and its finish change nothing', () => {
    const s = walking({
      walk: { target: '/base', visit: visit('v2'), startOnSwap: false },
      ops: new Map([
        [visit('v1'), { kind: 'walk', inFlight: 1, landed: false }],
        [visit('v2'), { kind: 'walk', inFlight: 1, landed: false }],
      ]),
    })

    expect(arrived(s, { visit: 'v1' })).toEqual({ state: s, effects: [], outcome: landing('drop') })
    expect(reduce(s, { type: 'walkHopFailed', visit: visit('v1') })).toEqual({ state: s, effects: [], outcome: none })
    expect(reduce(s, { type: 'visitFinished', visit: visit('v1') }).effects).toEqual([])
  })

  it('a 409 re-issue does not refuse its ticket: the first leg’s finish leaves it waiting for the second', () => {
    const {
      state: s,
      effects,
      last,
    } = script(state(), [
      { type: 'openRequested', ticket: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', ticket: id('t1') } },
      { type: 'visitFinished', visit: visit('v1') },
      arrival({ visit: 'v1', layer: { key: 'panel', base: '/base' } }),
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects).toEqual([])
    expect(s).toEqual(state({ rows: [row('t1', { key: 'panel', phase: 'opening', entries: 0 })] }))
    expect(last.outcome).toEqual(none)
  })
})
