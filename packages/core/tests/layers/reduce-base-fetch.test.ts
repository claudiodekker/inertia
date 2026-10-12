import { describe, expect, it } from 'vitest'
import { reduce } from '../../src/layers/reduce'
import { MAX_LAYER_CHAIN, type StackState } from '../../src/layers/state'
import {
  arrival,
  arrived,
  baseOrigin,
  cid,
  committing,
  entry,
  entryLayer,
  id,
  row,
  script,
  state,
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

describe('cold boot and the walk', () => {
  it('S:394 L:914 a cold boot seeds the layer on a blank base, walks after the first swap, and the hop lands the base', () => {
    const layer = {
      id: id('a'),
      type: 'routed' as const,
      key: 'panel',
      owner: 'base' as const,
      standalone: true,
      ownsAddress: true,
      entries: 0,
    }
    const booted = reduce(state(), { type: 'booted', layers: [layer], blank: true, declaredBase: '/base' })

    expect(booted.state).toEqual(
      state({
        rows: [row('a', { key: 'panel', standalone: true, entries: 0 })],
        base: { blank: true, gen: 0 },
        baseFetch: { url: '/base', visit: null, startOnSwap: true },
        paint: { gated: true, owed: true },
      }),
    )

    const { state: s, effects } = script(booted.state, [
      committing({ initial: true, mode: 'replace' }),
      { type: 'baseSwapped' },
      { type: 'visitDispatched', visit: visit('v1'), tag: { kind: 'fetchBase' } },
      arrival({ visit: 'v1' }),
      committing({ visit: visit('v1'), mode: 'replace' }),
      { type: 'baseSwapped' },
      { type: 'visitFinished', visit: visit('v1') },
    ])

    expect(effects).toEqual([
      { type: 'paint' },
      { type: 'startVisit', tag: { kind: 'fetchBase' }, via: 'base', url: '/base' },
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
        baseFetch: { url: '/deeper', visit: null, startOnSwap: false },
        ops: new Map([[visit('v1'), { kind: 'fetchBase', inFlight: 1, landed: true }]]),
      }),
      effects: [
        { type: 'setBlankUrl', url: '/deeper' },
        { type: 'startVisit', tag: { kind: 'fetchBase' }, via: 'base', url: '/deeper' },
      ],
      outcome: landing('fetched-beneath', { id: 'inner' }),
    })
  })

  it(`stops a walk whose next layer would make the stack ${MAX_LAYER_CHAIN} deep, landing the answer as the base with a warning`, () => {
    const s = walking({
      rows: Array.from({ length: MAX_LAYER_CHAIN - 1 }, (_, depth) =>
        row(`r${depth}`, { standalone: true, entries: 0 }),
      ),
    })

    expect(arrived(s, { visit: 'v1', layer: { key: 'deep', base: '/deeper' } })).toEqual({
      state: { ...s, ops: new Map([[visit('v1'), { kind: 'fetchBase', inFlight: 1, landed: true }]]) },
      effects: [
        {
          type: 'warn',
          message:
            'A layer chain more than 10 layers deep was declared, so "/deeper" was not fetched. The deepest layer that loaded is being used as the page.',
        },
      ],
      outcome: landing('fetched-base'),
    })
  })

  it('lands a hop whose declared base cycles back to a live row as the base, without a warning', () => {
    expect(
      arrived(walking(), { visit: 'v1', layer: { key: 'loop', base: '/panel' }, facts: { cycles: true } }).effects,
    ).toEqual([])
  })

  it('L:1037 a failed hop promotes the deepest layer to the page, and the base swap paints its dialog away', () => {
    const { state: s, effects } = script(walking(), [
      { type: 'baseFetchFailed', visit: visit('v1') },
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
      { type: 'baseFetchFailed', visit: visit('v1') },
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
    expect(s.baseFetch).toBeNull()
    expect(s.base.blank).toBe(true)
  })

  it('L:2165 a close during the walk landing sends the walk again, and the first commit to arrive lands the base', () => {
    const closing = script(walking(), [
      arrival({ visit: 'v1' }),
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('a') },
    ])

    expect(closing.effects.filter((effect) => effect.type === 'startVisit')).toEqual([
      { type: 'startVisit', tag: { kind: 'fetchBase' }, via: 'base', url: '/base' },
    ])
    expect(closing.state.baseFetch).toEqual({ url: '/base', visit: null, startOnSwap: false })

    const { state: s, last } = script(closing.state, [
      { type: 'visitDispatched', visit: visit('v2'), tag: { kind: 'fetchBase' } },
      committing({ visit: visit('v1'), mode: 'replace' }),
      arrival({ visit: 'v2' }),
    ])

    expect(s.base).toEqual({ blank: false, gen: 0 })
    expect(s.baseFetch).toBeNull()
    expect(last.outcome).toEqual(landing('drop'))
  })

  it('L:2165 the walk sent again lands the base when its answer commits first', () => {
    const { state: s, last } = script(walking(), [
      arrival({ visit: 'v1' }),
      { type: 'closeRequested', target: 'top', close: cid('c1'), waiter: wid('w1') },
      { type: 'exited', id: id('a') },
      { type: 'visitDispatched', visit: visit('v2'), tag: { kind: 'fetchBase' } },
      arrival({ visit: 'v2' }),
    ])

    expect(last.outcome).toEqual(landing('fetched-base'))
    expect(reduce(s, committing({ visit: visit('v2'), mode: 'replace' })).state).toMatchObject({
      base: { blank: false, gen: 0 },
      baseFetch: null,
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
      { type: 'startVisit', tag: { kind: 'fetchBase' }, via: 'base', url: '/layers/base' },
    ])
    expect(s).toEqual(
      state({
        nextToken: 2,
        rows: [row('new', { key: 'guarded', standalone: true, entries: 0 })],
        base: { blank: true, gen: 1 },
        baseFetch: { url: '/layers/base', visit: null, startOnSwap: false },
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
    const s = state({ rows: [row('layer')], paint: { gated: true, owed: true } })

    expect(
      reduce(s, { type: 'restoredOnLoad', entry: entry([entryLayer('a'), entryLayer('b', { owner: id('a') })]) }),
    ).toEqual({
      state: state({ rows: [row('a'), row('b', { owner: id('a') })], paint: { gated: true, owed: true } }),
      effects: [
        { type: 'dispose', ids: ['layer'], reason: 'restored-away' },
        { type: 'reopen', ids: ['a', 'b'] },
      ],
      outcome: none,
    })
  })
})
