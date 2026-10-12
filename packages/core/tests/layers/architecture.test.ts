import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = join(__dirname, '../../src')

const scoped = ['router.ts', 'request.ts', 'requestParams.ts', 'response.ts', 'prefetched.ts']

const imports = (file: string): { names: string[]; from: string }[] =>
  [...readFileSync(join(src, file), 'utf8').matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)].map(
    ([, names, from]) => ({
      names: names.split(',').map((name) =>
        name
          .trim()
          .split(/\s+as\s+/)[0]
          .replace(/^type\s+/, ''),
      ),
      from,
    }),
  )

describe('scope seam', () => {
  it.each(scoped)('%s reads the page store and router through its scope', (file) => {
    const found = imports(file)

    expect(
      found.filter(({ names, from }) => from === './page' && names.includes('page')),
      `${file} imports the \`page\` singleton from './page'. Read it through \`this.scope.page\` (or \`baseScope\`).`,
    ).toEqual([])

    expect(
      found.filter(({ names, from }) => ['.', './index'].includes(from) && names.includes('router')),
      `${file} imports the \`router\` singleton from '.' or './index'. Read it through \`this.scope.router\`.`,
    ).toEqual([])
  })
})

const pure = ['layers/state.ts', 'layers/route.ts', 'layers/restore.ts', 'layers/reduce.ts', 'layers/entry.ts']
const pureSiblings = ['./state', './route', './restore', './reduce', './entry']

const code = (file: string) =>
  readFileSync(join(src, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, (literal) => (/^['"]\.{0,2}\//.test(literal) ? literal : '""'))

const specifiers = (source: string) =>
  [
    ...source.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?(['"])([^'"]+)\3/gm),
    ...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g),
  ].map((match) =>
    match.length === 5 ? { typeOnly: !!match[2], from: match[4] } : { typeOnly: false, from: match[2] },
  )

describe('the pure control plane', () => {
  it.each(pure)('%s imports only the other pure modules, or types', (file) => {
    const offending = specifiers(code(file)).filter(({ typeOnly, from }) => !typeOnly && !pureSiblings.includes(from))

    expect(
      offending,
      `${file} imports runtime code. The reducer, classify, planRestore and entry are pure: they may import values only from ${pureSiblings.join(', ')}, and anything else as \`import type\`. Move the effect into stack.ts.`,
    ).toEqual([])
  })

  it.each(pure)('%s touches no browser, timer or clock global', (file) => {
    const globals = [
      ...code(file).matchAll(
        /\b(window|document|globalThis|history|location|navigator|localStorage|sessionStorage|setTimeout|setInterval|queueMicrotask|requestAnimationFrame|fetch|console|Date|performance|crypto)\b|Math\.random/g,
      ),
    ].map(([name]) => name)

    expect(
      globals,
      `${file} reads a browser, timer or clock global. Pass the fact in on the event, or emit an effect for stack.ts to run.`,
    ).toEqual([])
  })
})
