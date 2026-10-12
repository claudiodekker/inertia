import { reduce } from '../../src/layers/reduce'
import {
  initialState,
  type CloseId,
  type CloseRow,
  type EntryFacts,
  type EntryLayerFacts,
  type LayerId,
  type LayerRow,
  type Origin,
  type RouteFacts,
  type StackEffect,
  type StackEvent,
  type StackState,
  type Step,
  type Token,
  type VisitId,
  type WaiterId,
} from '../../src/layers/state'

export const id = (value: string) => value as LayerId
export const visit = (value: string) => value as VisitId
export const cid = (value: string) => value as CloseId
export const wid = (value: string) => value as WaiterId
export const tok = (value: number) => value as Token

export const row = (value: string, overrides: Partial<LayerRow> = {}): LayerRow => ({
  id: id(value),
  type: 'routed',
  key: `key:${value}`,
  owner: 'base',
  phase: 'open',
  standalone: false,
  ownsAddress: true,
  entries: 1,
  renderKey: 0,
  close: null,
  ...overrides,
})

export const close = (value: string, layers: string[], overrides: Partial<CloseRow> = {}): CloseRow => ({
  id: cid(value),
  layers: layers.map(id),
  exited: [],
  waiters: [],
  phase: { kind: 'exiting' },
  ...overrides,
})

export const closes = (...rows: CloseRow[]) => new Map(rows.map((c) => [c.id, c]))

export const state = (overrides: Partial<StackState> = {}): StackState => ({ ...initialState, ...overrides })

export const facts = (overrides: Partial<RouteFacts> = {}): RouteFacts => ({
  aimed: false,
  baseMatches: false,
  cycles: false,
  matchesAddressTier: false,
  hasErrors: false,
  partial: false,
  async: false,
  preserveState: false,
  preserveUrl: false,
  replace: false,
  ...overrides,
})

export const baseOrigin = (
  overrides: { top?: string | null; gen?: number; instantGen?: number | null } = {},
): Origin => ({
  kind: 'base',
  top: overrides.top ? id(overrides.top) : null,
  gen: overrides.gen ?? 0,
  instantGen: overrides.instantGen ?? null,
})

export const layerOrigin = (value: string, instant = false): Origin => ({ kind: 'layer', id: id(value), instant })

export interface Arrival {
  origin?: Origin
  layer?: { key: string; base: string | null } | null
  close?: boolean
  facts?: Partial<RouteFacts>
  visit?: string
  newId?: string
  newClose?: string
}

export const arrival = (a: Arrival = {}): Extract<StackEvent, { type: 'responseArrived' }> => ({
  type: 'responseArrived',
  visit: visit(a.visit ?? 'v'),
  origin: a.origin ?? baseOrigin(),
  marks: { layer: a.layer ?? null, close: a.close ?? false },
  facts: facts(a.facts),
  newId: id(a.newId ?? 'new'),
  newClose: cid(a.newClose ?? 'cnew'),
})

export const arrived = (s: StackState, a: Arrival = {}): Step => reduce(s, arrival(a))

export const committing = (
  overrides: Partial<Omit<Extract<StackEvent, { type: 'baseCommitting' }>, 'type'>> = {},
): StackEvent => ({
  type: 'baseCommitting',
  visit: null,
  mode: 'push',
  sameAsLive: false,
  interstitial: false,
  initial: false,
  ...overrides,
})

export const entryLayer = (value: string, overrides: Partial<EntryLayerFacts> = {}): EntryLayerFacts => ({
  id: id(value),
  key: `key:${value}`,
  type: 'routed',
  owner: 'base',
  standalone: false,
  ownsAddress: true,
  entries: 1,
  ...overrides,
})

export const entry = (layers: EntryLayerFacts[], overrides: Partial<EntryFacts> = {}): EntryFacts => ({
  layers,
  url: '/base',
  baseSame: true,
  blank: false,
  sameSnapshot: new Set(layers.map((layer) => layer.id)),
  ...overrides,
})

/** Runs events in order; returns the last step and every effect in order. */
export function script(s: StackState, events: StackEvent[]): { state: StackState; effects: StackEffect[]; last: Step } {
  let current = s
  let last: Step = { state: s, effects: [], outcome: { kind: 'none' } }
  const effects: StackEffect[] = []

  for (const event of events) {
    last = reduce(current, event)
    current = last.state
    effects.push(...last.effects)
  }

  return { state: current, effects, last }
}
