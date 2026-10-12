<script module lang="ts">
  import { type LayerView, type Page, type PageProps } from '@inertiajs/core'
  import type { ComponentResolver, LayerComponent, ResolvedComponent } from '../types'

  export interface InertiaAppProps<SharedProps extends PageProps = PageProps> {
    initialComponent: ResolvedComponent
    initialPage: Page<SharedProps>
    resolveComponent: ComponentResolver
    defaultLayout?: (name: string, page: Page) => unknown
    /** Server only: the stack is client state, so a server render shows the boot plan's layers. */
    initialLayers?: readonly LayerView[]
    layer?: LayerComponent
    serverRendered?: boolean
  }
</script>

<script lang="ts">
  import { router } from '@inertiajs/core'
  import { onMount } from 'svelte'
  import { setHydrationContext } from '../hydration'
  import { resetLayoutProps, storeState } from '../layoutProps.svelte'
  import { setPage } from '../page.svelte'
  import { useLayerViews } from '../layerViews.svelte'
  import renderPage, { type LayoutSnapshot } from '../renderPage'
  import Layer from './Layer.svelte'
  import { layerStack, noLayers } from './LayerStack.svelte'
  import Render, { type RenderProps } from './Render.svelte'

  interface Props {
    initialComponent: InertiaAppProps['initialComponent']
    initialPage: InertiaAppProps['initialPage']
    resolveComponent: InertiaAppProps['resolveComponent']
    defaultLayout?: InertiaAppProps['defaultLayout']
    initialLayers?: InertiaAppProps['initialLayers']
    layer?: LayerComponent
    serverRendered?: boolean
  }

  const {
    initialComponent,
    initialPage,
    resolveComponent,
    defaultLayout,
    initialLayers,
    // The shipped shell also takes the attributes of a <dialog>, which a LayerComponent need not
    layer = Layer as unknown as LayerComponent,
    serverRendered = true,
  }: Props = $props()

  // svelte-ignore state_referenced_locally
  let component = $state(initialComponent)
  let key = $state<number | null>(null)
  // svelte-ignore state_referenced_locally
  let page = $state({ ...initialPage, flash: initialPage.flash ?? {} })
  let renderProps = $derived.by<RenderProps>(() => renderPage(component, page, key, currentLayoutSnapshot(), defaultLayout))

  // Synchronous initialization so the global page store is populated during SSR
  // ($effect.pre does not run during Svelte 5 SSR)
  // svelte-ignore state_referenced_locally
  setPage(page)

  // Reactively update the global page state when local page state changes
  $effect.pre(() => {
    setPage(page)
  })

  const isServer = typeof window === 'undefined'

  // svelte-ignore state_referenced_locally
  const stack = useLayerViews(initialLayers)

  function currentLayoutSnapshot(): LayoutSnapshot {
    // Getters keep the reactive reads inside the layout branch, as in 3.x
    return isServer
      ? { shared: {}, named: {} }
      : {
          get shared() {
            return storeState.shared
          },
          get named() {
            return storeState.named
          },
        }
  }

  // Scoped per app instance so multiple Inertia roots on one page don't clobber each other
  // svelte-ignore state_referenced_locally
  const hydration = $state({ hydrated: !serverRendered })
  setHydrationContext(hydration)

  if (!isServer) {
    onMount(() => (hydration.hydrated = true))

    // svelte-ignore state_referenced_locally
    router.init<ResolvedComponent>({
      initialPage,
      resolveComponent,
      swapComponent: async (args) => {
        // Explicitly sync the global page store before swapping components,
        // ensuring the page store is up-to-date when the new component's
        // script block runs (necessary for async: true).
        setPage(args.page)
        component = args.component
        page = args.page
        key = args.preserveState ? key : Date.now()

        if (!args.preserveState) {
          resetLayoutProps()
        }
      },
      onFlash: (flash) => {
        page = { ...page, flash }
      },
    })
  }
</script>

<Render {...renderProps} />
{@render (stack.list.length > 0 ? layerStack : noLayers)(stack.list, layer, defaultLayout)}
