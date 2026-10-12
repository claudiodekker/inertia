import { layerSlot, type LayerView, type Page } from '@inertiajs/core'
import { createElement, ReactNode, useCallback, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import Layer from './Layer'
import { LayerContext } from './layerContext'
import PageContext from './PageContext'
import renderPage from './renderPage'
import { LayerComponent, ReactComponent } from './types'

type DefaultLayout = (name: string, page: Page) => unknown

const emptySnapshot = {
  shared: {} as Record<string, unknown>,
  named: {} as Record<string, Record<string, unknown>>,
}

// A restore can reopen a layer under the id of one still playing its exit, so a frame is keyed by instance.
const frames = new WeakMap<object, string>()
let frameCount = 0

const frameKey = (view: LayerView): string => {
  let key = frames.get(view.scope)

  if (!key) {
    key = `${view.id}:${++frameCount}`
    frames.set(view.scope, key)
  }

  return key
}

// The stack's paint resolves once the DOM shows the views, so the base and its layers land in one frame.
const subscribe = (onChange: () => void) => layerSlot.subscribe(() => flushSync(onChange))

function LayerFrame({
  view,
  shell,
  defaultLayout,
}: {
  view: LayerView
  shell: LayerComponent
  defaultLayout?: DefaultLayout
}) {
  const layout = useSyncExternalStore(view.layout.subscribe, view.layout.get, () => emptySnapshot)
  const bind = useCallback((el: Element | null) => layerSlot.bindElement(view.id, el), [view.id])

  return createElement(
    LayerContext.Provider,
    { value: view.scope },
    createElement(
      PageContext.Provider,
      { value: view.page },
      createElement(
        shell,
        view.shell,
        createElement(
          'div',
          { ...view.attributes, ref: bind },
          renderPage(view.component as ReactComponent, view.layoutPage, view.renderKey, layout, defaultLayout),
        ),
      ),
    ),
  )
}

export default function LayerStack({
  shell = Layer,
  defaultLayout,
  initialLayers,
}: {
  shell?: LayerComponent
  defaultLayout?: DefaultLayout
  /** Server only: the stack is client state, so a server render shows the boot plan's views. */
  initialLayers?: readonly LayerView[]
}): ReactNode {
  const views = useSyncExternalStore(subscribe, layerSlot.views, () => initialLayers ?? layerSlot.views())

  return views.map((view) => createElement(LayerFrame, { key: frameKey(view), view, shell, defaultLayout }))
}
