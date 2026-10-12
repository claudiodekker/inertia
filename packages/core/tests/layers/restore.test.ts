import { describe, expect, it } from 'vitest'
import { planRestore } from '../../src/layers/restore'
import { cid, entry, entryLayer, id, row, state } from './fixtures'

const plan = (overrides: object = {}) => ({
  kind: 'restore',
  base: false,
  dismiss: null,
  drop: [],
  rewind: [],
  reopen: [],
  ...overrides,
})

describe('planRestore', () => {
  it('passes a plain entry with nothing live', () => {
    expect(planRestore(state(), entry([]))).toEqual({ kind: 'pass' })
  })

  it('recovers a stored blank placeholder with nothing live', () => {
    expect(planRestore(state(), entry([], { blank: true, url: '/layers/base' }))).toEqual({
      kind: 'recover',
      url: '/layers/base',
    })
  })

  it('restores a plain entry as the base while the base on screen is still the blank placeholder', () => {
    expect(planRestore(state({ base: { blank: true, gen: 0 } }), entry([], { baseSame: false }))).toEqual(
      plan({ base: true }),
    )
  })

  it('does not pass while a ghost still exits', () => {
    expect(planRestore(state({ ghosts: [id('g')] }), entry([]))).toEqual(plan())
  })

  it('restores another base: drops every live row and reopens every entry layer', () => {
    expect(planRestore(state({ rows: [row('a'), row('b')] }), entry([entryLayer('c')], { baseSame: false }))).toEqual(
      plan({ base: true, drop: ['a', 'b'], reopen: ['c'] }),
    )
  })

  it('dismisses the top row when the entry is the stack beneath it and the top pushed one entry', () => {
    expect(planRestore(state({ rows: [row('a'), row('b')] }), entry([entryLayer('a')]))).toEqual(plan({ dismiss: 'b' }))
  })

  it('drops instead of dismissing a top that pushed more than one entry, or is closing', () => {
    expect(planRestore(state({ rows: [row('a', { entries: 2 })] }), entry([]))).toEqual(plan({ drop: ['a'] }))
    expect(planRestore(state({ rows: [row('a', { close: cid('c') })] }), entry([]))).toEqual(plan({ drop: ['a'] }))
  })

  it('drops the rows past the entry when it is a shorter prefix', () => {
    expect(planRestore(state({ rows: [row('a'), row('b'), row('c')] }), entry([entryLayer('a')]))).toEqual(
      plan({ drop: ['b', 'c'] }),
    )
  })

  it('reopens the entry layers past the live rows when they are a prefix of it', () => {
    expect(
      planRestore(state({ rows: [row('a')] }), entry([entryLayer('a'), entryLayer('b'), entryLayer('c')])),
    ).toEqual(plan({ reopen: ['b', 'c'] }))
  })

  it('rewinds rows whose snapshot differs when the stack matches', () => {
    expect(
      planRestore(
        state({ rows: [row('a'), row('b')] }),
        entry([entryLayer('a'), entryLayer('b')], { sameSnapshot: new Set([id('a')]) }),
      ),
    ).toEqual(plan({ rewind: ['b'] }))
  })

  it('drops and reopens from the first row that differs by id, key or type', () => {
    expect(
      planRestore(state({ rows: [row('a'), row('b')] }), entry([entryLayer('a'), entryLayer('b', { key: 'other' })])),
    ).toEqual(plan({ drop: ['b'], reopen: ['b'] }))
    expect(planRestore(state({ rows: [row('a'), row('b')] }), entry([entryLayer('x')]))).toEqual(
      plan({ drop: ['a', 'b'], reopen: ['x'] }),
    )
  })
})
