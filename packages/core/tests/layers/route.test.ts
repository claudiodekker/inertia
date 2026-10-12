import { describe, expect, it } from 'vitest'
import { classify } from '../../src/layers/route'
import { MAX_WALK, type Landing, type StackState } from '../../src/layers/state'
import { arrival, baseOrigin, id, layerOrigin, row, state, tok, visit, type Arrival } from './fixtures'

const walk = (overrides: Partial<StackState> = {}) =>
  state({
    rows: [row('a', { standalone: true })],
    base: { blank: true, gen: 0 },
    walk: { target: '/base', hops: 1, visit: visit('w'), startOnSwap: false },
    ops: new Map([[visit('w'), { kind: 'walk', inFlight: 1, landed: false }]]),
    ...overrides,
  })

const ticketed = (overrides: Partial<StackState> = {}) =>
  state({
    tickets: new Map([[id('t'), { id: id('t'), owner: 'base', state: 'dispatched' }]]),
    ops: new Map([[visit('v'), { kind: 'open', ticket: id('t'), inFlight: 1 }]]),
    ...overrides,
  })

const pinned = state({
  base: { blank: false, gen: 2 },
  pin: { token: tok(1), gen: 2, pushes: 1, ticket: null, suspended: [row('a')] },
})

const layer = (key: string, base: string | null = '/base') => ({ key, base })

const cases: [string, StackState, Arrival, Landing][] = [
  ['an idle base answer with no marks passes', state(), {}, { kind: 'pass' }],
  ['a walk hop for the current walk lands as the base', walk(), { visit: 'w' }, { kind: 'walk-base' }],
  [
    'a walk hop with its own base goes beneath',
    walk(),
    { visit: 'w', layer: layer('inner', '/deeper') },
    { kind: 'walk-beneath', id: id('new') },
  ],
  [
    'a walk hop at the cap lands as the base',
    walk({ walk: { target: '/base', hops: MAX_WALK, visit: visit('w'), startOnSwap: false } }),
    { visit: 'w', layer: layer('deep', '/deeper') },
    { kind: 'walk-base' },
  ],
  [
    'a walk hop whose base cycles lands as the base',
    walk(),
    { visit: 'w', layer: layer('loop', '/loop'), facts: { cycles: true } },
    { kind: 'walk-base' },
  ],
  [
    'a walk hop of a superseded walk drops',
    walk({ walk: { target: '/base', hops: 1, visit: visit('w2'), startOnSwap: false } }),
    { visit: 'w' },
    { kind: 'drop' },
  ],
  [
    'a walk hop once the base is real drops',
    walk({ base: { blank: false, gen: 0 } }),
    { visit: 'w' },
    { kind: 'drop' },
  ],
  [
    'a layer answer for a gone origin layer drops',
    state(),
    { origin: layerOrigin('x'), layer: layer('k') },
    { kind: 'drop' },
  ],
  [
    'a partial for a gone origin layer drops',
    state(),
    { origin: layerOrigin('x'), facts: { partial: true } },
    { kind: 'drop' },
  ],
  ['a plain answer for a gone origin layer lands on the base', state(), { origin: layerOrigin('x') }, { kind: 'base' }],
  [
    'a close answer made from a layer closes it',
    state({ rows: [row('a')] }),
    { origin: layerOrigin('a'), close: true },
    { kind: 'close', id: id('a'), beneath: 'base' },
  ],
  [
    'a close answer made from the base closes the top live at dispatch',
    state({ rows: [row('a')] }),
    { origin: baseOrigin({ top: 'a' }), close: true },
    { kind: 'close', id: id('a'), beneath: 'base' },
  ],
  [
    'a close answer made from the base with that top gone passes',
    state(),
    { origin: baseOrigin({ top: 'a' }), close: true },
    { kind: 'pass' },
  ],
  [
    'a layer answer while the prompt is the base returns',
    pinned,
    { origin: baseOrigin({ gen: 2 }), layer: layer('k') },
    { kind: 'return', id: id('new') },
  ],
  [
    'a layer answer after the prompt left does not return',
    { ...pinned, base: { blank: false, gen: 3 } },
    { origin: baseOrigin({ gen: 3 }), layer: layer('k'), facts: { aimed: true } },
    { kind: 'open', id: id('new'), owner: 'base' },
  ],
  [
    'the answer to a layer’s own instant visit refreshes it',
    state({ rows: [row('a')] }),
    { origin: layerOrigin('a', true), layer: layer('other') },
    { kind: 'refresh', id: id('a'), remount: false },
  ],
  [
    'a same-key partial refreshes the row, remounting without preserveState',
    state({ rows: [row('a', { key: 'k' })] }),
    { layer: layer('k'), facts: { partial: true } },
    { kind: 'refresh', id: id('a'), remount: true },
  ],
  [
    'a same-key answer prefers the origin layer over the topmost',
    state({ rows: [row('a', { key: 'k' }), row('b', { key: 'k' })] }),
    { origin: layerOrigin('a'), layer: layer('k'), facts: { preserveState: true } },
    { kind: 'rewrite', id: id('a'), dismissed: [id('b')], remount: false },
  ],
  [
    'a same-key answer from the base rewrites the topmost match',
    state({ rows: [row('a', { key: 'k' }), row('b', { key: 'k' })] }),
    { layer: layer('k') },
    { kind: 'rewrite', id: id('b'), dismissed: [], remount: true },
  ],
  [
    'a local row never matches a key',
    state({ rows: [row('l', { type: 'local', key: 'k' })] }),
    { layer: layer('k'), facts: { aimed: true } },
    { kind: 'open', id: id('new'), owner: 'base' },
  ],
  [
    'a background refresh from a layer matching no key refreshes that layer',
    state({ rows: [row('a')] }),
    { origin: layerOrigin('a'), layer: layer('other'), facts: { async: true, preserveState: true } },
    { kind: 'refresh', id: id('a'), remount: false },
  ],
  [
    'a background refresh from the base matching no key drops',
    state({ rows: [row('a')] }),
    { layer: layer('other'), facts: { async: true, preserveState: true } },
    { kind: 'drop' },
  ],
  [
    'a layer answer over a base replaced since dispatch drops',
    state({ base: { blank: false, gen: 1 } }),
    { origin: baseOrigin({ gen: 0 }), layer: layer('k'), facts: { aimed: true } },
    { kind: 'drop' },
  ],
  [
    'a layer answer over its own instant placeholder lands cold',
    state({ base: { blank: false, gen: 1 } }),
    { origin: baseOrigin({ gen: 0, instantGen: 1 }), layer: layer('k') },
    { kind: 'cold', id: id('new') },
  ],
  [
    'a baseless answer over its own instant placeholder lands as a page',
    state({ base: { blank: false, gen: 1 } }),
    { origin: baseOrigin({ gen: 0, instantGen: 1 }), layer: layer('k', null) },
    { kind: 'promote' },
  ],
  [
    'a ticket’s answer opens with the ticket id and owner',
    ticketed(),
    { layer: layer('k') },
    { kind: 'open', id: id('t'), owner: 'base' },
  ],
  [
    'a ticket whose owner left opens over the base',
    ticketed({ tickets: new Map([[id('t'), { id: id('t'), owner: id('gone'), state: 'dispatched' }]]) }),
    { layer: layer('k') },
    { kind: 'open', id: id('t'), owner: 'base' },
  ],
  [
    'a ticket’s answer that cannot compose lands cold with the ticket id',
    ticketed({ base: { blank: false, gen: 1 } }),
    { origin: baseOrigin({ gen: 0, instantGen: 1 }), layer: layer('k') },
    { kind: 'cold', id: id('t') },
  ],
  [
    'a layer answer made from a live layer opens as its child',
    state({ rows: [row('a')] }),
    { origin: layerOrigin('a'), layer: layer('k') },
    { kind: 'open', id: id('new'), owner: id('a') },
  ],
  [
    'an aimed base answer opens over the base',
    state(),
    { layer: layer('k'), facts: { aimed: true } },
    { kind: 'open', id: id('new'), owner: 'base' },
  ],
  [
    'a base answer whose declared base is on screen opens over it',
    state(),
    { layer: layer('k'), facts: { baseMatches: true } },
    { kind: 'open', id: id('new'), owner: 'base' },
  ],
  [
    'a base answer with a top live at dispatch opens over it',
    state({ rows: [row('a')] }),
    { origin: baseOrigin({ top: 'a' }), layer: layer('k') },
    { kind: 'open', id: id('new'), owner: id('a') },
  ],
  [
    'a base answer that composes over nothing lands cold',
    state(),
    { layer: layer('k') },
    { kind: 'cold', id: id('new') },
  ],
  [
    'a baseless base answer that composes over nothing lands as a page',
    state(),
    { layer: layer('k', null) },
    { kind: 'promote' },
  ],
  [
    'a plain answer with errors for an addressless layer hands back',
    state({ rows: [row('a', { ownsAddress: false })] }),
    { origin: layerOrigin('a'), facts: { matchesAddressTier: true, hasErrors: true } },
    { kind: 'handback', id: id('a') },
  ],
  [
    'a plain answer from a layer lands on the base',
    state({ rows: [row('a')] }),
    { origin: layerOrigin('a') },
    { kind: 'base' },
  ],
  [
    'a plain answer from the base passes with layers open',
    state({ rows: [row('a')] }),
    { origin: baseOrigin({ top: 'a' }) },
    { kind: 'pass' },
  ],
]

describe('classify', () => {
  it.each(cases)('%s', (_title, s, a, expected) => {
    expect(classify(s, arrival(a))).toEqual(expected)
  })
})
