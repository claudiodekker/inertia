import { describe, expect, it } from 'vitest'
import { openApp } from './support/app'
import { page, settled } from './support/browser'

const users = page('Users/Index', '/users')
const layer = (url: string) => page('Users/Edit', url, { layer: { key: 'Users/Edit', base: '/users' } })

const steppedBack = async (app: Awaited<ReturnType<typeof openApp>>) => {
  const deltas: number[] = []
  const go = window.history.go.bind(window.history)

  window.history.go = (delta: number) => {
    deltas.push(delta)
    go(delta)
  }

  void app.router.close()
  await settled()
  app
    .views()
    .filter((view) => !view.shell.open)
    .forEach((view) => view.shell.done())
  await settled()

  return deltas
}

describe('the entries a close steps back over', () => {
  it('are the ones the restored entry counted, after Back inside a layer', async () => {
    const app = await openApp(users, {
      '/users/5/edit': layer('/users/5/edit'),
      '/users/6/edit': layer('/users/6/edit'),
      '/users': users,
    })

    app.router.visit('/users/5/edit')
    await settled()
    app.router.layerHandle()!.router.visit('/users/6/edit')
    await settled()

    expect((app.entry().layers as { entries: number }[])[0].entries).toBe(2)

    window.history.back()
    await settled()

    expect(await steppedBack(app)).toEqual([-1])
    expect(window.location.href).toBe('http://localhost/users')
    expect(app.layers()).toEqual([])
  })

  it('are the ones the restored entry counted, after Back off an anchor', async () => {
    const app = await openApp(users, { '/users/5/edit': layer('/users/5/edit'), '/users': users })

    app.router.visit('/users/5/edit')
    await settled()
    window.history.pushState(null, '', '/users/5/edit#notes')
    window.history.go(0)
    await settled()
    window.history.back()
    await settled()

    expect(await steppedBack(app)).toEqual([-1])
    expect(window.location.href).toBe('http://localhost/users')
  })
})
