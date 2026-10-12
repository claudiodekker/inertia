import { describe, expect, it, vi } from 'vitest'
import { compose } from '../../src/layers/entry'
import { layerAt, pageWith, world } from './support/base-fetch'
import { settled } from './support/browser'

const login = pageWith({ component: 'Auth/Login', url: '/login' })

const document = 'http://localhost/users/5/edit'

const teamsEntry = () =>
  compose(
    pageWith() as never,
    [
      {
        ...(pageWith({ component: 'Teams/Edit' }) as object),
        id: 'layer-9',
        key: 'Teams/Edit',
        type: 'routed',
        owner: null,
        entries: 1,
      },
    ] as never,
    false,
  ).data

const from = (href = 'http://localhost/login') => ({ href })

describe('the walk a cold layer sends for the base beneath it', () => {
  it('re-requests a restored entry that holds no page, replacing it with the page fetched for its url', async () => {
    const w = await world({ href: document, routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.dismiss()

    const captured = w.writes.filter(({ mode }) => mode === 'push').at(-1)!.state
    const installed = w.swaps.length
    const pushes = w.writes.filter(({ mode }) => mode === 'push').length

    w.popstate(captured)
    await settled()

    expect(w.requested.filter((path) => path === '/users')).toHaveLength(2)

    await w.answer('/users', pageWith())

    const base = await w.base()

    expect(w.requested.filter((path) => path === '/users')).toHaveLength(2)
    expect(base.component).toBe('Users/Index')
    expect(base.props).toEqual({ users: [] })
    expect(base.url).toBe('/users')
    // The placeholder shows as the loading view while the page is fetched (a recorded difference).
    expect(w.swaps.slice(installed)).toEqual([
      { component: 'Blank', preserveState: false },
      { component: 'Users/Index', preserveState: true },
    ])
    expect(w.writes.filter(({ mode }) => mode === 'push')).toHaveLength(pushes)
    expect(w.writes.at(-1)!.mode).toBe('replace')
    expect(w.writes.at(-1)!.state.page.component).toBe('Users/Index')
    expect(w.writes.at(-1)!.state.page.layers).toBeUndefined()
  })
})

describe('the walk a cold layer sends for the base beneath it', () => {
  it('restores an entry the walk never filled in by promoting its layer to the page', async () => {
    const w = await world({ ...from(), routes: { '/users': 'hold' } })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))

    const { state } = w.writes.find(({ mode }) => mode === 'push')!

    w.popstate(state)
    await settled()

    expect((await w.base()).component).toBe('Users/Edit')
    expect(w.layers()).toEqual([])
  })

  it('never hands the adapter a blank page when a blank entry is restored', async () => {
    const w = await world({
      href: 'http://localhost/users/5/edit',
      routes: { '/users': 'hold' },
    })
    await w.begin(login)
    await w.open(layerAt('/users/5/edit', 'Users/Edit', '/users'))
    await w.dismiss()

    const captured = w.writes.filter(({ mode }) => mode === 'push').at(-1)!.state
    const installed = w.swaps.length

    w.popstate(captured)
    await vi.waitFor(() => expect(w.requested.filter((path) => path === '/users').length).toBeGreaterThanOrEqual(2))

    expect(w.resolved).not.toContain('')
    expect(w.swaps.slice(installed)).toEqual([{ component: 'Blank', preserveState: false }])

    await w.answer('/users', pageWith())

    expect((await w.base()).component).toBe('Users/Index')
  })

  it('restores a composed entry as it was written, not as a re-request', async () => {
    const w = await world(from())
    await w.begin(login)

    w.popstate({ page: teamsEntry() })
    await settled()

    expect((await w.base()).component).toBe('Users/Index')
    expect(w.keys()).toEqual(['Teams/Edit'])
    expect(w.requested).toEqual([])
  })

  it('recovers a blank restore on an old version through missingHistoryItem, never rendering the blank', async () => {
    const w = await world({
      href: 'http://localhost/users',
      routes: {
        '/users': pageWith({
          component: 'Users/List',
          url: '/users',
          version: 'v1',
        }),
      },
    })
    await w.begin(pageWith({ component: 'Users/Index', url: '/users', version: 'v2' }))
    const visit = vi.spyOn(w.router, 'visit')

    w.popstate({
      page: pageWith({ component: '', url: '/users', version: 'v1' }),
    })
    await settled()

    expect(visit).toHaveBeenCalledWith('http://localhost/users', {
      preserveState: true,
      preserveScroll: true,
      replace: true,
    })
    expect(w.swaps).not.toContainEqual(expect.objectContaining({ component: '' }))
    expect(w.resolved).not.toContain('')
    expect((await w.base()).component).toBe('Users/List')
  })
})
