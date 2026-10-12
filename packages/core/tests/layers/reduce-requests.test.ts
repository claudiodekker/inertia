import { describe, expect, it } from 'vitest'
import { reduce } from '../../src/layers/reduce'
import type { StackEvent, StackState } from '../../src/layers/state'
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

const walking = (overrides: Partial<StackState> = {}) =>
  state({
    rows: [row('a', { standalone: true, entries: 0 })],
    base: { blank: true, gen: 0 },
    baseFetch: { url: '/base', visit: visit('v1'), startOnSwap: false },
    ops: new Map([[visit('v1'), { kind: 'fetchBase', inFlight: 1, landed: false }]]),
    ...overrides,
  })

const pinnedOver = (overrides: Partial<StackState> = {}) =>
  state({
    base: { blank: false, gen: 1 },
    nextToken: 2,
    interstitial: { token: tok(1), gen: 1, pushes: 1, request: id('t1'), suspended: [row('a')] },
    openRequests: new Map([[id('t1'), { id: id('t1'), owner: 'base', state: 'dispatched' }]]),
    ...overrides,
  })

describe('tickets', () => {
  it('L:1312 L:1391 a ticket’s answer opens with the ticket’s id, owned by its opener, and the ticket is done', () => {
    const {
      state: s,
      effects,
      last,
    } = script(state(), [
      { type: 'openRequested', request: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
      arrival({ visit: 'v1', layer: { key: 'panel', base: '/base' } }),
    ])

    expect(last.outcome).toEqual(landing('open', { id: 't1', owner: 'base' }))

    const finished = reduce(s, { type: 'visitFinished', visit: visit('v1') })

    expect(finished.state).toEqual(state({ rows: [row('t1', { key: 'panel', phase: 'opening', entries: 0 })] }))
    expect([...effects, ...finished.effects]).toEqual([])
  })

  it('L:1376 a ticket opened from a layer is owned by that layer', () => {
    const { last } = script(state({ rows: [row('a')] }), [
      { type: 'openRequested', request: id('t1'), owner: id('a') },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
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
      { type: 'openRequested', request: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
      arrival({ visit: 'v1' }),
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects).toEqual([{ type: 'refuse', request: 't1' }])
    expect(s).toEqual(state())
    expect(last.outcome).toEqual(none)
  })

  it('refuses a ticket its gate never dispatched, and leaves a dispatched one to its finish', () => {
    expect(
      script(state(), [
        { type: 'openRequested', request: id('t1'), owner: 'base' },
        { type: 'openRefused', request: id('t1') },
      ]),
    ).toMatchObject({ state: state(), effects: [{ type: 'refuse', request: 't1' }] })

    const dispatched = script(state(), [
      { type: 'openRequested', request: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
      { type: 'openRefused', request: id('t1') },
    ])

    expect(dispatched.effects).toEqual([])
    expect(dispatched.state.openRequests.get(id('t1'))).toEqual({ id: 't1', owner: 'base', state: 'dispatched' })
  })

  it('gives up a ticket waiting on a prompt: the pin stays, and the layer answer after it returns under a fresh id', () => {
    const givenUp = reduce(pinnedOver(), { type: 'openRefused', request: id('t1') })

    expect(givenUp.effects).toEqual([{ type: 'refuse', request: 't1' }])
    expect(givenUp.state).toEqual(pinnedOver({ openRequests: new Map() }))
    expect(
      arrived(givenUp.state, { origin: baseOrigin({ gen: 1 }), layer: { key: 'guarded', base: '/layers/base' } })
        .outcome,
    ).toEqual(landing('return', { id: 'new' }))
  })

  it('a plain page with errors answering a layer that owns no address hands its errors back to that layer', () => {
    const s = state({ rows: [row('a'), row('b', { ownsAddress: false })] })

    expect(arrived(s, { origin: layerOrigin('b'), facts: { matchesAddressOwner: true, hasErrors: true } })).toEqual({
      state: s,
      effects: [],
      outcome: landing('handback', { id: 'b' }),
    })
    expect(arrived(s, { origin: layerOrigin('b'), facts: { matchesAddressOwner: true } }).outcome).toEqual(
      landing('base'),
    )
    expect(
      arrived(s, { origin: layerOrigin('a'), facts: { matchesAddressOwner: true, hasErrors: true } }).outcome,
    ).toEqual(landing('base'))
  })
})

describe('an open that shows a component at once', () => {
  const opened: StackEvent[] = [
    { type: 'openRequested', request: id('t1'), owner: id('a') },
    { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
    { type: 'placeholderOpened', request: id('t1'), ownsAddress: true },
  ]

  it('puts the layer up under the ticket id before any answer, keyed by that id, and the ticket is done', () => {
    const { state: s, effects } = script(state({ rows: [row('a')] }), opened)

    expect(s.rows).toEqual([row('a'), row('t1', { key: 't1', owner: id('a'), phase: 'opening', entries: 0 })])
    expect(s.openRequests.size).toBe(0)
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

    expect(reduce(s, { type: 'placeholderOpened', request: id('t1'), ownsAddress: true }).state).toBe(s)
  })
})

describe('interstitials', () => {
  it('L:1937 L:2047 a prompt pins the stack; the layer answer after it returns the pinned base with the layer, one replace', () => {
    const pinned = script(state({ rows: [row('a')] }), [
      { type: 'openRequested', request: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
      committing({ visit: visit('v1'), mode: 'push', interstitial: true }),
      { type: 'visitFinished', visit: visit('v1') },
      { type: 'baseSwapped' },
    ])

    expect(pinned.effects).toEqual([{ type: 'holdBase', token: 1 }, { type: 'paint' }])
    expect(pinned.state).toEqual(
      state({
        nextToken: 2,
        base: { blank: false, gen: 1 },
        openRequests: new Map([[id('t1'), { id: id('t1'), owner: 'base', state: 'dispatched' }]]),
        interstitial: { token: tok(1), gen: 1, pushes: 1, request: id('t1'), suspended: [row('a')] },
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
      { type: 'installBase', token: 2, source: { kind: 'held', token: 1 }, mode: 'replace' },
      { type: 'releaseBase', token: 1 },
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
        pinnedOver({
          openRequests: new Map(),
          interstitial: { token: tok(1), gen: 1, pushes: 1, request: null, suspended: [] },
        }),
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

    expect(returned.interstitial).toBeNull()
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
        { type: 'refuse', request: 't1' },
        { type: 'releaseBase', token: 1 },
      ],
      outcome: none,
    })
  })

  it('a wrong-password re-render of the prompt keeps the pin and moves its gen', () => {
    const step = reduce(pinnedOver(), committing({ mode: 'push', interstitial: true }))

    expect(step.state.interstitial).toEqual({ token: 1, gen: 2, pushes: 2, request: 't1', suspended: [row('a')] })
    expect(step.state.base).toEqual({ blank: false, gen: 2 })
    expect(step.effects).toEqual([])
  })

  it('L:2115 a prompt with nothing open pins an empty stack and paints nothing', () => {
    expect(reduce(state(), committing({ mode: 'push', interstitial: true }))).toEqual({
      state: state({
        nextToken: 2,
        base: { blank: false, gen: 1 },
        interstitial: { token: tok(1), gen: 1, pushes: 1, request: null, suspended: [] },
        paint: { gated: true, owed: false },
      }),
      effects: [{ type: 'holdBase', token: 1 }],
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
    const s = state({ rows: [row('b')], dismissed: [id('a')] })

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

    expect(s).toEqual(state({ rows: [row('a', { key: 'step', entries: 3 })], dismissed: [id('b')] }))
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
        { type: 'refuse', request: 't1' },
        { type: 'releaseBase', token: 1 },
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
      baseFetch: { url: '/base', visit: visit('v2'), startOnSwap: false },
      ops: new Map([
        [visit('v1'), { kind: 'fetchBase', inFlight: 1, landed: false }],
        [visit('v2'), { kind: 'fetchBase', inFlight: 1, landed: false }],
      ]),
    })

    expect(arrived(s, { visit: 'v1' })).toEqual({ state: s, effects: [], outcome: landing('drop') })
    expect(reduce(s, { type: 'baseFetchFailed', visit: visit('v1') })).toEqual({ state: s, effects: [], outcome: none })
    expect(reduce(s, { type: 'visitFinished', visit: visit('v1') }).effects).toEqual([])
  })

  it('a 409 re-issue does not refuse its ticket: the first leg’s finish leaves it waiting for the second', () => {
    const {
      state: s,
      effects,
      last,
    } = script(state(), [
      { type: 'openRequested', request: id('t1'), owner: 'base' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'open', request: id('t1') } },
      { type: 'visitFinished', visit: visit('v1') },
      arrival({ visit: 'v1', layer: { key: 'panel', base: '/base' } }),
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects).toEqual([])
    expect(s).toEqual(state({ rows: [row('t1', { key: 'panel', phase: 'opening', entries: 0 })] }))
    expect(last.outcome).toEqual(none)
  })
})
