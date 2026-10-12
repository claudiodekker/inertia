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
