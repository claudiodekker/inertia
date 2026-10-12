import { describe, expect, it } from 'vitest'
import { page, runtime, settled } from './support/runtime'

const panel = page('Panel', '/panel', { layer: { key: 'panel', base: '/users' } })

// index.ts constructs the router while these are still loading. 3.x cannot be entered through the first
// three either; the next three reach the router or its default scope before the index.
const loadsBeforeTheRouter = /\/(router|eventHandler|initialVisit|request|layers\/scope|layers\/layerRouter)\.ts$/

// stack.ts constructs these while it loads, and nothing else imports them.
const constructedByTheStack = /\/layers\/(base|stackHistory|openRequests)\.ts$/

const modules = Object.entries(import.meta.glob('../../src/**/*.ts')).filter(
  ([path]) => !loadsBeforeTheRouter.test(path) && !constructedByTheStack.test(path),
)

describe('opening a layer whichever core module is loaded first', () => {
  it.each(modules)('opens a layer when %s is loaded first', async (_path, loadFirst) => {
    const app = await runtime(page('Users', '/users'), { '/panel': panel }, loadFirst)

    app.router.layer('/panel')
    await settled()

    expect(app.layers().map((layer) => layer.component)).toEqual(['Panel'])
  })
})
