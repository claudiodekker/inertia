import { afterEach, describe, expect, it, vi } from 'vitest'
import Queue from '../../src/queue'
import type { Page, PageProps } from '../../src/types'
import { openAppSync } from './support/app'
import { page, settled } from './support/browser'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('clonePageProps', () => {
  const pageWith = (props: PageProps): Page => ({
    component: 'Users/Index',
    props: { errors: {}, ...props },
    url: '/users',
    version: null,
    rescuedProps: [],
    flash: {},
    rememberedState: {},
  })

  const clonePageProps = async (input: Page): Promise<Page> => {
    const { history } = await import('../../../src/history')

    return (history as unknown as { clonePageProps(page: Page): Page }).clonePageProps(input)
  }

  it('returns props the browser can store in history', async () => {
    const cloned = await clonePageProps(pageWith({ name: 'Joe', user: new Proxy({ id: 5 }, {}) }))

    expect(() => structuredClone(cloned.props)).not.toThrow()
    expect(cloned.props).toEqual({ errors: {}, name: 'Joe', user: { id: 5 } })
  })

  it('returns the page untouched when its props are already cloneable', async () => {
    const input = pageWith({ name: 'Joe' })

    expect(await clonePageProps(input)).toBe(input)
  })

  it('does not mutate the original props', async () => {
    const onClick = () => {}
    const input = pageWith({ onClick, user: new Proxy({ id: 5 }, {}) })

    await clonePageProps(input)

    expect(input.props.onClick).toBe(onClick)
  })

  it('returns props the browser can store when the unstorable ones are on a layer', async () => {
    const app = await openAppSync(page('Users/Index', '/users'), {})
    const handle = app.router.layer({
      component: 'Confirm',
      props: { message: 'Discard?', user: new Proxy({ id: 5 }, {}) },
    })

    await settled()

    expect(handle.state).toBe('open')
    expect(app.written().at(-1)).toEqual(['push', '/users'])
    expect(() => structuredClone(window.history.state)).not.toThrow()
    expect(app.entry().layers).toEqual([
      expect.objectContaining({
        id: handle.id,
        component: 'Confirm',
        props: { errors: {}, message: 'Discard?', user: { id: 5 } },
      }),
    ])
  })
})

describe('the write queue', () => {
  it('runs an item added while the item ahead of it was settling', async () => {
    const queue = new Queue<Promise<void>>()
    const ran: string[] = []
    let first!: Promise<void>

    queue.add(() => (first = Promise.resolve().then(() => void ran.push('first'))))
    await first.then(() => queue.add(() => Promise.resolve().then(() => void ran.push('second'))))
    await new Promise((resolve) => setTimeout(resolve))

    expect(ran).toEqual(['first', 'second'])
  })
})
