import { describe, expect, it } from 'vitest'
import { reduce } from '../../src/layers/reduce'
import { initialState, type LayerId, type LayerRow, type RouteFacts, type StackState } from '../../src/layers/state'

const id = (value: string) => value as LayerId

const row = (value: string, overrides: Partial<LayerRow> = {}): LayerRow => ({
  id: id(value),
  type: 'routed',
  key: `key:${value}`,
  owner: 'base',
  phase: 'open',
  ownsAddress: true,
  entries: 1,
  renderKey: 0,
  ...overrides,
})

const state = (overrides: Partial<StackState> = {}): StackState => ({ ...initialState, ...overrides })

const facts = (overrides: Partial<RouteFacts> = {}): RouteFacts => ({
  aimed: false,
  baseMatches: false,
  partial: false,
  async: false,
  preserveState: false,
  preserveUrl: false,
  ...overrides,
})

const baseOrigin = (overrides: { top?: string | null; gen?: number; instantGen?: number | null } = {}) => ({
  kind: 'base' as const,
  top: overrides.top === undefined ? null : id(overrides.top!),
  gen: overrides.gen ?? 0,
  instantGen: overrides.instantGen ?? null,
})

const layerOrigin = (value: string, instant = false) => ({ kind: 'layer' as const, id: id(value), instant })

const arrived = (
  s: StackState,
  origin: ReturnType<typeof baseOrigin> | ReturnType<typeof layerOrigin>,
  layer: { key: string; base: string | null } | null,
  f: Partial<RouteFacts> = {},
) => reduce(s, { type: 'responseArrived', origin, marks: { layer }, facts: facts(f), newId: id('new') })

describe('responseArrived', () => {
  it('passes a plain page made from the base', () => {
    const s = state({ rows: [row('a')] })

    expect(arrived(s, baseOrigin({ top: 'a' }), null)).toEqual({
      state: s,
      effects: [],
      outcome: { kind: 'landing', landing: { kind: 'pass' } },
    })
  })

  it('lands a plain page made from a live layer on the base', () => {
    const s = state({ rows: [row('a')] })

    expect(arrived(s, layerOrigin('a'), null).outcome).toEqual({ kind: 'landing', landing: { kind: 'base' } })
  })

  it('drops a layer response made from a layer that is gone', () => {
    const s = state({ rows: [row('b')] })

    expect(arrived(s, layerOrigin('a'), { key: 'key:a', base: '/base' })).toEqual({
      state: s,
      effects: [],
      outcome: { kind: 'landing', landing: { kind: 'drop' } },
    })
  })

  it('opens a layer the visit was aimed at, as an opening row owned by the base', () => {
    const step = arrived(state(), baseOrigin(), { key: 'panel', base: '/base' }, { aimed: true })

    expect(step.outcome).toEqual({ kind: 'landing', landing: { kind: 'open', id: 'new', owner: 'base' } })
    expect(step.state.rows).toEqual([
      { id: 'new', type: 'routed', key: 'panel', owner: 'base', phase: 'opening', ownsAddress: true, entries: 0, renderKey: 0 },
    ])
    expect(step.effects).toEqual([])
  })

  it('opens over the top layer live at dispatch, owned by it, and records a preserveUrl open as owning no address', () => {
    const step = arrived(state({ rows: [row('a')] }), baseOrigin({ top: 'a' }), { key: 'other', base: '/base' }, { preserveUrl: true })

    expect(step.outcome).toEqual({ kind: 'landing', landing: { kind: 'open', id: 'new', owner: 'a' } })
    expect(step.state.rows[1]).toEqual({
      id: 'new',
      type: 'routed',
      key: 'other',
      owner: 'a',
      phase: 'opening',
      ownsAddress: false,
      entries: 0,
      renderKey: 0,
    })
  })

  it('opens a layer made from a layer as that layer’s child', () => {
    const step = arrived(state({ rows: [row('a')] }), layerOrigin('a'), { key: 'child', base: '/base' })

    expect(step.outcome).toEqual({ kind: 'landing', landing: { kind: 'open', id: 'new', owner: 'a' } })
  })

  it('rewrites the row with the same key, dismisses the rows above it as ghosts and paints', () => {
    const s = state({ rows: [row('a', { key: 'step' }), row('b')] })
    const step = arrived(s, baseOrigin({ top: 'b' }), { key: 'step', base: '/base' })

    expect(step).toEqual({
      state: state({ rows: [row('a', { key: 'step', entries: 2, renderKey: 1 })], ghosts: [id('b')] }),
      effects: [{ type: 'paint' }],
      outcome: { kind: 'landing', landing: { kind: 'rewrite', id: 'a', dismissed: ['b'], remount: true } },
    })
  })

  it('rewrites in place without a remount when the visit preserves state', () => {
    const s = state({ rows: [row('a', { key: 'step' })] })
    const step = arrived(s, baseOrigin({ top: 'a' }), { key: 'step', base: '/base' }, { preserveState: true })

    expect(step).toEqual({
      state: s,
      effects: [],
      outcome: { kind: 'landing', landing: { kind: 'rewrite', id: 'a', dismissed: [], remount: false } },
    })
  })

  it('refreshes the same-key row for a partial reload', () => {
    const s = state({ rows: [row('a', { key: 'counted' })] })
    const step = arrived(s, layerOrigin('a'), { key: 'counted', base: '/base' }, { partial: true, async: true, preserveState: true })

    expect(step).toEqual({
      state: s,
      effects: [],
      outcome: { kind: 'landing', landing: { kind: 'refresh', id: 'a', remount: false } },
    })
  })

  it('refreshes the origin layer for the answer to its own instant visit', () => {
    const s = state({ rows: [row('a', { key: 'panel:first' })] })

    expect(arrived(s, layerOrigin('a', true), { key: 'panel:second', base: '/base' }).outcome).toEqual({
      kind: 'landing',
      landing: { kind: 'refresh', id: 'a', remount: false },
    })
  })

  it('drops a background refresh made from the base that matches no layer', () => {
    const s = state({ rows: [row('a')] })

    expect(arrived(s, baseOrigin({ top: 'a' }), { key: 'other', base: '/base' }, { async: true, preserveState: true }).outcome).toEqual({
      kind: 'landing',
      landing: { kind: 'drop' },
    })
  })

  it('drops a layer response dispatched over a base that has since been replaced', () => {
    const s = state({ base: { gen: 2 } })

    expect(arrived(s, baseOrigin({ gen: 1 }), { key: 'panel', base: '/base' }, { aimed: true }).outcome).toEqual({
      kind: 'landing',
      landing: { kind: 'drop' },
    })
  })

  it('lands cold, or as a page without a declared base, when it cannot compose over the screen', () => {
    expect(arrived(state(), baseOrigin(), { key: 'guarded', base: '/base' }).outcome).toEqual({
      kind: 'landing',
      landing: { kind: 'cold' },
    })
    expect(arrived(state(), baseOrigin(), { key: 'guarded', base: null }).outcome).toEqual({
      kind: 'landing',
      landing: { kind: 'promote' },
    })
  })
})

describe('layerCommitting', () => {
  const committing = (s: StackState, requestedReplace: boolean, urlChanged: boolean) =>
    reduce(s, { type: 'layerCommitting', id: id('a'), requestedReplace, urlChanged })

  it('pushes the first commit of an opening row and charges it one entry', () => {
    expect(committing(state({ rows: [row('a', { phase: 'opening', entries: 0 })] }), false, false)).toEqual({
      state: state({ rows: [row('a', { phase: 'open', entries: 1 })] }),
      effects: [{ type: 'writeEntry', mode: 'push' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'push' } },
    })
  })

  it('replaces for an opening visit that asked to replace, charging nothing', () => {
    expect(committing(state({ rows: [row('a', { phase: 'opening', entries: 0 })] }), true, false)).toEqual({
      state: state({ rows: [row('a', { phase: 'open', entries: 0 })] }),
      effects: [{ type: 'writeEntry', mode: 'replace' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'replace' } },
    })
  })

  it('pushes an open row moving to a new url, and replaces one that stays', () => {
    expect(committing(state({ rows: [row('a')] }), false, true)).toEqual({
      state: state({ rows: [row('a', { entries: 2 })] }),
      effects: [{ type: 'writeEntry', mode: 'push' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'push' } },
    })
    expect(committing(state({ rows: [row('a')] }), true, false)).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'writeEntry', mode: 'replace' }],
      outcome: { kind: 'commit', decision: { kind: 'write', mode: 'replace' } },
    })
  })

  it('skips a row that is no longer in the model', () => {
    const s = state({ rows: [row('b')] })

    expect(committing(s, false, false)).toEqual({
      state: s,
      effects: [],
      outcome: { kind: 'commit', decision: { kind: 'skip' } },
    })
  })
})

describe('baseCommitting', () => {
  it('keeps the stack for a replace of the same page and closes the gate', () => {
    const s = state({ rows: [row('a')] })

    expect(reduce(s, { type: 'baseCommitting', mode: 'replace', sameAsLive: true })).toEqual({
      state: state({ rows: [row('a')], paint: { gated: true, owed: false } }),
      effects: [],
      outcome: { kind: 'none' },
    })
  })

  it('drops every row and ghost for a push, bumps the base gen and owes a paint', () => {
    const s = state({ base: { gen: 3 }, rows: [row('a'), row('b')], ghosts: [id('c')] })

    expect(reduce(s, { type: 'baseCommitting', mode: 'push', sameAsLive: true })).toEqual({
      state: state({ base: { gen: 4 }, paint: { gated: true, owed: true } }),
      effects: [{ type: 'dispose', ids: ['a', 'b', 'c'], reason: 'navigated' }],
      outcome: { kind: 'none' },
    })
  })

  it('drops for a replace onto a different page', () => {
    const step = reduce(state({ rows: [row('a')] }), { type: 'baseCommitting', mode: 'replace', sameAsLive: false })

    expect(step.state.rows).toEqual([])
    expect(step.effects).toEqual([{ type: 'dispose', ids: ['a'], reason: 'navigated' }])
  })

  it('bumps the gen of an idle base without owing a paint', () => {
    expect(reduce(state(), { type: 'baseCommitting', mode: 'push', sameAsLive: false })).toEqual({
      state: state({ base: { gen: 1 }, paint: { gated: true, owed: false } }),
      effects: [],
      outcome: { kind: 'none' },
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
      outcome: { kind: 'none' },
    })
    expect(reduce(swapped.state, { type: 'baseSwapped' })).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'paint' }],
      outcome: { kind: 'none' },
    })
  })

  it('paints a layer swap at once while the gate is open', () => {
    const s = state({ rows: [row('a')] })

    expect(reduce(s, { type: 'layerSwapped', id: id('a') })).toEqual({ state: s, effects: [{ type: 'paint' }], outcome: { kind: 'none' } })
  })

  it('opens the gate without a paint when nothing changed while it was closed', () => {
    expect(reduce(state({ paint: { gated: true, owed: false } }), { type: 'baseSwapped' })).toEqual({
      state: state(),
      effects: [],
      outcome: { kind: 'none' },
    })
  })

  it('ignores a swap of a layer that left the model', () => {
    const s = state()

    expect(reduce(s, { type: 'layerSwapped', id: id('a') })).toEqual({ state: s, effects: [], outcome: { kind: 'none' } })
  })
})

describe('exited', () => {
  it('disposes a ghost once its exit finished and paints it away', () => {
    expect(reduce(state({ rows: [row('a')], ghosts: [id('b')] }), { type: 'exited', id: id('b') })).toEqual({
      state: state({ rows: [row('a')] }),
      effects: [{ type: 'dispose', ids: ['b'], reason: 'closed' }, { type: 'paint' }],
      outcome: { kind: 'none' },
    })
  })
})
