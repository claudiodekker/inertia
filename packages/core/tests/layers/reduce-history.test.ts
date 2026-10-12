import { describe, expect, it } from 'vitest'
import { entryRows } from '../../src/layers/close'
import { reduce } from '../../src/layers/reduce'
import { cid, close, closes, entry, entryLayer, id, row, script, state, tok } from './support/fixtures'

const none = { kind: 'none' }

const handled = { kind: 'restore', restore: { kind: 'handled' } }

describe('history', () => {
  it('Back off the top layer dismisses it through its exit, leaving the one beneath', () => {
    expect(
      reduce(state({ rows: [row('a'), row('b')] }), { type: 'popstate', entry: entry([entryLayer('a')]) }),
    ).toEqual({
      state: state({ rows: [row('a')], dismissed: [id('b')] }),
      effects: [{ type: 'cancelAll' }, { type: 'paint' }],
      outcome: handled,
    })
  })

  it('Forward reopens the entry’s layers with no request', () => {
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

  it('history.go(-2) past the entry beneath drops the stack at once, with no exit', () => {
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

  it('a plain Back with no layer anywhere passes to 3.x', () => {
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
    expect(step.state.dismissed).toEqual(['c'])
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
