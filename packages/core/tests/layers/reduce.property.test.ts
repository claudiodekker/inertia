import { writeFileSync } from 'node:fs'
import fc from 'fast-check'
import { afterAll, describe, it } from 'vitest'
import { reduce } from '../../src/layers/reduce'
import {
  initialState,
  type EntryFacts,
  type LayerId,
  type LayerRow,
  type StackEvent,
  type StackState,
  type Step,
  type Token,
  type VisitId,
  type WaiterId,
} from '../../src/layers/state'
import { cid, id, visit, wid } from './fixtures'

type Command = [kind: number, a: number, b: number, c: number, flags: number]

const kinds: [StackEvent['type'], number][] = [
  ['responseArrived', 22],
  ['baseCommitting', 10],
  ['baseSwapped', 8],
  ['layerCommitting', 10],
  ['layerSwapped', 2],
  ['popstate', 7],
  ['unwindSettled', 4],
  ['closeRequested', 8],
  ['exited', 10],
  ['openRequested', 3],
  ['openRefused', 1],
  ['placeholderOpened', 1],
  ['localOpened', 2],
  ['visitDispatched', 6],
  ['visitFinished', 5],
  ['walkHopFailed', 1],
  ['restoredOnLoad', 1],
  ['anchored', 2],
  ['writeRefused', 1],
]
const wheel = kinds.flatMap(([kind, weight]) => Array<StackEvent['type']>(weight).fill(kind))

const pick = <T>(items: readonly T[], index: number): T | undefined =>
  items.length > 0 ? items[index % items.length] : undefined

/** Interprets a random command against the current state, so the sequence reaches closes, walks, pins and unwinds. */
function eventFor(s: StackState, [k, a, b, c, f]: Command, n: number): StackEvent {
  const bit = (i: number) => ((f >> i) & 1) === 1
  const fresh = (prefix: string) => `${prefix}${n}`
  const rowIds = s.rows.map((r) => r.id)
  const anyId = [...rowIds, ...s.ghosts, id('gone')]
  const visits: VisitId[] = [...s.ops.keys(), ...(s.walk?.visit ? [s.walk.visit] : [])]
  const someVisit = () =>
    s.walk?.visit && bit(26) ? s.walk.visit : visits.length > 0 && a % 4 !== 0 ? pick(visits, a)! : visit(fresh('v'))
  const owner = () => (bit(0) ? 'base' : (pick(rowIds, b) ?? 'base'))

  switch (wheel[k % wheel.length]) {
    case 'responseArrived': {
      const top = s.rows.filter((r) => r.phase === 'open').at(-1)?.id ?? null
      const keys = [...s.rows.map((r) => r.key), 'k1', 'k2', 'k3']

      return {
        type: 'responseArrived',
        visit: someVisit(),
        origin: bit(2)
          ? { kind: 'layer', id: pick(anyId, b)!, instant: bit(3) && bit(22) }
          : {
              kind: 'base',
              top: bit(4) ? (pick(rowIds, b) ?? null) : top,
              gen: bit(5) && bit(23) && bit(24) ? s.base.gen - 1 : s.base.gen,
              instantGen: bit(6) ? s.base.gen : null,
            },
        marks: {
          layer: bit(7) ? null : { key: pick(keys, c)!, base: bit(8) ? null : pick(['/base', '/a', '/b'], c >> 3)! },
          close: c % 10 === 0,
        },
        facts: {
          aimed: bit(9),
          baseMatches: bit(10),
          cycles: bit(11) && bit(12),
          matchesAddressTier: bit(13),
          hasErrors: bit(14),
          partial: bit(15) && bit(16),
          async: bit(17) && bit(25),
          preserveState: bit(18),
          preserveUrl: bit(19) && bit(20),
          replace: bit(21),
        },
        newId: id(fresh('n')),
        newClose: cid(fresh('c')),
      }
    }
    case 'baseCommitting': {
      const token = s.expect?.kind === 'base' ? (String(s.expect.token) as VisitId) : null
      const choice = a % 4

      return {
        type: 'baseCommitting',
        visit:
          choice === 0
            ? token
            : choice === 1
              ? (pick([...s.ops.keys()], b) ?? null)
              : choice === 2
                ? null
                : visit(fresh('v')),
        mode: bit(0) ? 'push' : 'replace',
        against: (['same', 'moved', 'elsewhere', 'other'] as const)[b % 4],
        answer: ([null, 'refresh', 'navigation'] as const)[b % 3],
        interstitial: b % 5 === 0,
        initial: b % 17 === 0,
      }
    }
    case 'baseSwapped':
      return { type: 'baseSwapped' }
    case 'layerCommitting': {
      const opening = s.rows.filter((r) => r.phase === 'opening').map((r) => r.id)

      return {
        type: 'layerCommitting',
        id: bit(0) && opening.length > 0 ? pick(opening, a)! : pick(anyId, a)!,
        requestedReplace: bit(1) && bit(2),
        urlChanged: bit(3),
      }
    }
    case 'layerSwapped':
      return { type: 'layerSwapped', id: pick(anyId, a)! }
    case 'popstate':
      return { type: 'popstate', entry: entryFor(s, a, b, c, f, n) }
    case 'restoredOnLoad':
      return { type: 'restoredOnLoad', entry: entryFor(s, a, b, c, f, n) }
    case 'unwindSettled':
      return {
        type: 'unwindSettled',
        token: (s.expect?.kind === 'unwind' && bit(0) ? s.expect.token : (a % 5) + 1) as Token,
        how: bit(1) ? 'answered' : 'timeout',
      }
    case 'closeRequested':
      return {
        type: 'closeRequested',
        target: a % 4 === 0 ? 'top' : pick([...rowIds, id('gone')], b)!,
        close: cid(fresh('c')),
        waiter: wid(fresh('w')),
      }
    case 'exited': {
      const exiting = [...s.closes.values()]
        .filter((close) => close.phase.kind === 'exiting')
        .flatMap((close) => close.layers.filter((layer) => !close.exited.includes(layer)))
      const candidates = [...exiting, ...s.ghosts]

      return { type: 'exited', id: candidates.length > 0 && a % 5 !== 0 ? pick(candidates, b)! : pick(anyId, b)! }
    }
    case 'openRequested':
      return { type: 'openRequested', ticket: id(fresh('t')), owner: owner() }
    case 'openRefused':
      return { type: 'openRefused', ticket: pick([...s.tickets.keys()], a) ?? id(fresh('t')) }
    case 'placeholderOpened':
      return {
        type: 'placeholderOpened',
        ticket: pick([...s.tickets.keys()], a) ?? id(fresh('t')),
        ownsAddress: bit(0),
      }
    case 'localOpened':
      return { type: 'localOpened', id: id(fresh('l')), owner: owner(), key: 'Local' }
    case 'visitDispatched': {
      const refreshing = [...s.closes.values()]
        .filter((close) => close.phase.kind === 'refreshing')
        .map((close) => close.id)
      const tag = (
        [
          { kind: 'open', ticket: pick([...s.tickets.keys()], b) ?? id(fresh('t')) },
          { kind: 'walk' },
          { kind: 'refresh', close: pick(refreshing, b) ?? cid(fresh('c')) },
          { kind: 'recover' },
        ] as const
      )[s.walk && s.walk.visit === null && bit(1) ? 1 : a % 4]

      return { type: 'visitDispatched', visit: bit(0) ? someVisit() : visit(fresh('v')), tag }
    }
    case 'visitFinished':
      return { type: 'visitFinished', visit: someVisit() }
    case 'anchored':
      return { type: 'anchored' }
    case 'writeRefused':
      return { type: 'writeRefused', id: pick(anyId, a)! }
    case 'walkHopFailed':
      return { type: 'walkHopFailed', visit: s.walk?.visit && bit(0) ? s.walk.visit : visit(fresh('v')) }
    default:
      return { type: 'baseSwapped' }
  }
}

function entryFor(s: StackState, a: number, b: number, c: number, f: number, n: number): EntryFacts {
  const facts = (r: LayerRow) => ({
    id: r.id,
    key: r.key,
    type: r.type,
    owner: r.owner,
    standalone: r.standalone,
    ownsAddress: r.ownsAddress,
    entries: r.entries,
  })
  const extra = (i: number) => ({
    id: id(`e${n}-${i}`),
    key: `k${i}`,
    type: 'routed' as const,
    owner: 'base' as const,
    standalone: false,
    ownsAddress: true,
    entries: 1,
  })
  const live = s.rows.map(facts)
  const layers = [
    () => live.slice(0, b % (live.length + 1)),
    () => [...live, extra(1), ...(c % 2 ? [extra(2)] : [])],
    () => live.map((layer, i) => (i === live.length - 1 ? { ...layer, key: 'changed' } : layer)),
    () => [],
    () => [...live.slice(0, -1), ...s.ghosts.map((ghost) => ({ ...extra(0), id: ghost }))],
  ][a % 5]()

  return {
    layers,
    url: '/base',
    baseSame: c % 6 !== 0,
    blank: c % 13 === 0,
    sameSnapshot: new Set(s.rows.filter((_, i) => ((f >> i) & 1) === 1).map((r) => r.id)),
  }
}

const booted: StackEvent = {
  type: 'booted',
  seeds: [
    { id: id('seed'), type: 'routed', key: 'k1', owner: 'base', standalone: true, ownsAddress: true, entries: 0 },
  ],
  blank: true,
  walkTo: '/base',
}

const counts = {
  events: {} as Record<string, number>,
  landings: {} as Record<string, number>,
  effects: {} as Record<string, number>,
  stepsWith: {
    rows: 0,
    ghosts: 0,
    closes: 0,
    walk: 0,
    pin: 0,
    unwind: 0,
    baseInstall: 0,
    tickets: 0,
    blank: 0,
  } as Record<string, number>,
  closePhases: {} as Record<string, number>,
  runs: 0,
  steps: 0,
}
const bump = (table: Record<string, number>, key: string) => (table[key] = (table[key] ?? 0) + 1)

function violations(s: StackState, step: Step, event: StackEvent): string[] {
  const out: string[] = []
  const rowIds = s.rows.map((r) => r.id)

  if (s.walk !== null && !s.base.blank) {
    out.push('walk !== null but base is not blank')
  }

  for (const r of s.rows) {
    if (r.close !== null) {
      const close = s.closes.get(r.close)

      if (!close) {
        out.push(`row ${r.id} names close ${r.close}, which does not exist`)
      } else if (!close.layers.includes(r.id)) {
        out.push(`row ${r.id} names close ${r.close}, which does not cover it`)
      }
    }
  }

  const covered = new Map<LayerId, string>()

  for (const close of s.closes.values()) {
    for (const layer of close.layers) {
      if (covered.has(layer)) {
        out.push(`row ${layer} is in closes ${covered.get(layer)} and ${close.id}`)
      }

      covered.set(layer, close.id)

      const r = s.rows.find((candidate) => candidate.id === layer)

      if (close.phase.kind === 'refreshing' ? r !== undefined : r?.close !== close.id) {
        out.push(
          `close ${close.id} (${close.phase.kind}) covers ${layer}, which is ${r ? `in rows with close ${r.close}` : 'not in rows'}`,
        )
      }
    }
  }

  const unwinding = [...s.closes.values()].filter((close) => close.phase.kind === 'unwinding')

  if (s.expect?.kind === 'unwind') {
    const close = s.closes.get(s.expect.close)

    if (close?.phase.kind !== 'unwinding' || close.phase.token !== s.expect.token) {
      out.push(`expect.unwind names close ${s.expect.close}, which is not unwinding with token ${s.expect.token}`)
    }
  }

  if (unwinding.length > (s.expect?.kind === 'unwind' ? 1 : 0)) {
    out.push(`${unwinding.length} closes unwinding with expect ${s.expect?.kind ?? 'null'}`)
  }

  if (
    event.type === 'responseArrived' &&
    step.outcome.kind === 'landing' &&
    step.outcome.landing.kind === 'drop' &&
    step.effects.some((effect) => effect.type === 'writeEntry' || effect.type === 'paint')
  ) {
    out.push(`a drop landing emitted ${JSON.stringify(step.effects)}`)
  }

  const ids = [...rowIds, ...s.ghosts, ...(s.pin?.suspended.map((r) => r.id) ?? [])]

  if (new Set(ids).size !== ids.length) {
    out.push(`row ids are not unique: ${ids.join(',')}`)
  }

  for (const rows of [s.rows, s.pin?.suspended ?? []]) {
    rows.forEach((r, index) => {
      if (r.owner !== 'base' && !rows.slice(0, index).some((below) => below.id === r.owner)) {
        out.push(`row ${r.id} is owned by ${r.owner}, which is not a row below it`)
      }
    })
  }

  return out
}

function record(s: StackState, step: Step, event: StackEvent) {
  bump(counts.events, event.type)
  step.effects.forEach((effect) => bump(counts.effects, effect.type))

  if (step.outcome.kind === 'landing') {
    bump(counts.landings, step.outcome.landing.kind)
  }

  const flags: [string, boolean][] = [
    ['rows', s.rows.length > 0],
    ['ghosts', s.ghosts.length > 0],
    ['closes', s.closes.size > 0],
    ['walk', s.walk !== null],
    ['pin', s.pin !== null],
    ['unwind', s.expect?.kind === 'unwind'],
    ['baseInstall', s.expect?.kind === 'base'],
    ['tickets', s.tickets.size > 0],
    ['blank', s.base.blank],
  ]

  flags.forEach(([name, on]) => on && bump(counts.stepsWith, name))
  s.closes.forEach((close) => bump(counts.closePhases, close.phase.kind))
  counts.steps++
}

describe('reduce over random event sequences', () => {
  afterAll(() => {
    if (process.env.LAYERS_PROPERTY_STATS) {
      writeFileSync(process.env.LAYERS_PROPERTY_STATS, JSON.stringify(counts, null, 2) + '\n')
    }
  })

  it('keeps the stack invariants after every step', () => {
    fc.assert(
      fc.property(
        fc.nat(3),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.nat()), { maxLength: 40, size: 'max' }),
        (start, commands) => {
          let s = initialState
          const trail: StackEvent[] = []
          const waiters = { issued: new Set<WaiterId>(), settled: new Set<WaiterId>() }
          const events = start === 0 ? [booted] : []

          counts.runs++

          const apply = (event: StackEvent) => {
            trail.push(event)

            const step = reduce(s, event)
            const problems = violations(step.state, step, event)

            if (event.type === 'closeRequested') {
              waiters.issued.add(event.waiter)
            }

            for (const effect of step.effects) {
              if (effect.type === 'settle') {
                for (const waiter of effect.waiters) {
                  if (waiters.settled.has(waiter)) {
                    problems.push(`waiter ${waiter} settled twice`)
                  }

                  waiters.settled.add(waiter)
                }
              }
            }

            const pending = new Set([...step.state.closes.values()].flatMap((close) => close.waiters))

            for (const waiter of waiters.issued) {
              if (!pending.has(waiter) && !waiters.settled.has(waiter)) {
                problems.push(`waiter ${waiter} was dropped: neither settled nor held by a close`)
              }
            }

            record(step.state, step, event)

            if (problems.length > 0) {
              throw new Error(
                `${problems.join('\n')}\nafter events:\n${trail.map((e) => JSON.stringify(e, mapReplacer)).join('\n')}`,
              )
            }

            s = step.state
          }

          events.forEach(apply)
          commands.forEach((command, n) => apply(eventFor(s, command, n)))
        },
      ),
      { numRuns: 1000 },
    )
  })
})

function mapReplacer(_key: string, value: unknown) {
  return value instanceof Set ? [...value] : value
}
