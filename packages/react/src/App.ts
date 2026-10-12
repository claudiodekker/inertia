import {
  createHeadManager,
  layerSlot,
  type LayerView,
  HeadManagerOnUpdateCallback,
  HeadManagerTitleCallback,
  Page,
  PageHandler,
  PageProps,
  resolveServerHead,
  router,
  type ServerHeadOption,
} from '@inertiajs/core'
import {
  createElement,
  FunctionComponent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { flushSync } from 'react-dom'
import HeadContext from './HeadContext'
import LayerStack from './LayerStack'
import { resetLayoutProps, store } from './layoutProps'
import PageContext from './PageContext'
import renderPage from './renderPage'
import { LayerComponent, ReactComponent, ReactPageHandlerArgs } from './types'

let pendingInitialSwap: ReactPageHandlerArgs | null = null
let routerIsInitialized = false
let swapComponent: PageHandler<ReactComponent> = async (args) => {
  // Dummy function so we can init the router outside of the useEffect hook. This is
  // needed so `router.reload()` works right away (on mount) in any of the user's
  // components. We swap in the real function in the useEffect hook below.
  // The router can swap before that (e.g. a back_forward visit that restores a page
  // from history), so we remember it here and replay it once the real function is in
  // place instead of dropping the swap.
  pendingInitialSwap = args
}

type CurrentPage = {
  component: ReactComponent | null
  page: Page
  key: number | null
}

export interface InertiaAppProps<SharedProps extends PageProps = PageProps> {
  children?: (options: { Component: ReactComponent; props: PageProps; key: number | null }) => ReactNode
  initialPage: Page<SharedProps>
  initialComponent?: ReactComponent
  /** Server only: the layers the document arrived with, rendered over the base. */
  initialLayers?: readonly LayerView[]
  resolveComponent?: (name: string, page?: Page) => ReactComponent | Promise<ReactComponent>
  titleCallback?: HeadManagerTitleCallback
  onHeadUpdate?: HeadManagerOnUpdateCallback
  defaultLayout?: (name: string, page: Page) => unknown
  serverHead?: ServerHeadOption
  /** The shell each layer renders in. Defaults to the shipped <Layer>. */
  layer?: LayerComponent
}

export type InertiaApp = FunctionComponent<InertiaAppProps>

const emptySnapshot = {
  shared: {} as Record<string, unknown>,
  named: {} as Record<string, Record<string, unknown>>,
}

export default function App<SharedProps extends PageProps = PageProps>({
  children,
  initialPage,
  initialComponent,
  initialLayers,
  resolveComponent,
  titleCallback,
  onHeadUpdate,
  defaultLayout,
  serverHead,
  layer,
}: InertiaAppProps<SharedProps>) {
  const [current, setCurrent] = useState<CurrentPage>({
    component: initialComponent || null,
    page: { ...initialPage, flash: initialPage.flash ?? {} },
    key: null,
  })

  const pageRef = useRef(current.page)
  pageRef.current = current.page

  // Title and server head follow the top layer: the server's initial layers, the client's stack.
  const topPage = (fallback: Page) => layerSlot.topPage() ?? initialLayers?.at(-1)?.page ?? fallback

  const headManager = useMemo(() => {
    return createHeadManager(
      typeof window === 'undefined',
      (title: string) => (titleCallback ? titleCallback(title, topPage(pageRef.current)) : title),
      onHeadUpdate || (() => {}),
      resolveServerHead(topPage(initialPage), serverHead),
    )
  }, [])

  const dynamicLayoutProps = useSyncExternalStore(store.subscribe, store.get, () => emptySnapshot)

  if (!routerIsInitialized) {
    router.init<ReactComponent>({
      initialPage,
      resolveComponent: resolveComponent!,
      swapComponent: async (args) => swapComponent(args),
      onFlash: (flash) => {
        setCurrent((current) => ({
          ...current,
          page: { ...current.page, flash },
        }))
      },
    })

    routerIsInitialized = true
  }

  useEffect(() => {
    swapComponent = async ({ component, page, preserveState, initialRender }: ReactPageHandlerArgs) => {
      if (initialRender) {
        // We block setting the current page on the initial page to
        // prevent the initial page from being re-rendered again.
        return
      }

      if (!preserveState) {
        resetLayoutProps()
      }

      flushSync(() =>
        setCurrent((current) => ({
          component,
          page,
          key: preserveState ? current.key : Date.now(),
        })),
      )
    }

    // Replay the swap the dummy function above captured before we got here, if any.
    if (pendingInitialSwap) {
      const pending = pendingInitialSwap
      pendingInitialSwap = null
      swapComponent(pending)
    }

    const syncServerHead = (event: { detail: { page: Page } }) => {
      headManager.updateServerHead(resolveServerHead(topPage(event.detail.page), serverHead))
    }

    const removeNavigateListener = router.on('navigate', syncServerHead)
    const removeClientVisitListener = router.on('clientVisit', syncServerHead)

    return () => {
      removeNavigateListener()
      removeClientVisitListener()
    }
  }, [])

  if (!current.component) {
    return createElement(
      HeadContext.Provider,
      { value: headManager },
      createElement(PageContext.Provider, { value: current.page }, null),
    )
  }

  const renderChildren =
    children || (({ Component, key }) => renderPage(Component, current.page, key, dynamicLayoutProps, defaultLayout))

  return createElement(
    HeadContext.Provider,
    { value: headManager },
    createElement(
      PageContext.Provider,
      { value: current.page },
      renderChildren({
        Component: current.component,
        key: current.key,
        props: current.page.props,
      }),
    ),
    createElement(LayerStack, { shell: layer, defaultLayout, initialLayers }),
  )
}

App.displayName = 'Inertia'
