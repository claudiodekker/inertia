import {
  createHeadManager,
  HeadManager,
  HeadManagerOnUpdateCallback,
  HeadManagerTitleCallback,
  Page,
  PageProps,
  resolveServerHead,
  router,
  SharedPageProps,
  type ServerHeadOption,
} from '@inertiajs/core'
import {
  computed,
  DefineComponent,
  defineComponent,
  h,
  markRaw,
  onMounted,
  Plugin,
  PropType,
  reactive,
  ref,
  shallowRef,
} from 'vue'
import { provideHydrationContext } from './hydration'
import LayerStack from './LayerStack'
import { state as layoutPropsState, resetLayoutProps } from './layoutProps'
import remember from './remember'
import renderPage from './renderPage'
import { VuePageHandlerArgs } from './types'
import useForm from './useForm'

export interface InertiaAppProps<SharedProps extends PageProps = PageProps> {
  initialPage: Page<SharedProps>
  initialComponent?: DefineComponent
  resolveComponent?: (name: string, page?: Page) => DefineComponent | Promise<DefineComponent>
  titleCallback?: HeadManagerTitleCallback
  onHeadUpdate?: HeadManagerOnUpdateCallback
  defaultLayout?: (name: string, page: Page) => unknown
  serverHead?: ServerHeadOption
  serverRendered?: boolean
}

export type InertiaApp = DefineComponent<InertiaAppProps>

const component = ref<DefineComponent | undefined>(undefined)
const page = ref<Page>()
let pageAccessor: Page | null = null
const layout = shallowRef(null)
const key = ref<number | undefined>(undefined)
export let headManager: HeadManager

const App: InertiaApp = defineComponent({
  name: 'Inertia',
  props: {
    initialPage: {
      type: Object as PropType<Page>,
      required: true,
    },
    initialComponent: {
      type: Object as PropType<DefineComponent>,
      required: false,
    },
    resolveComponent: {
      type: Function as PropType<(name: string, page?: Page) => DefineComponent | Promise<DefineComponent>>,
      required: false,
    },
    titleCallback: {
      type: Function as PropType<HeadManagerTitleCallback>,
      required: false,
      default: (title: string) => title,
    },
    onHeadUpdate: {
      type: Function as PropType<HeadManagerOnUpdateCallback>,
      required: false,
      default: () => () => {},
    },
    defaultLayout: {
      type: Function as PropType<(name: string, page: Page) => unknown>,
      required: false,
    },
    serverHead: {
      type: [Boolean, String, Function] as PropType<ServerHeadOption>,
      required: false,
    },
    serverRendered: {
      type: Boolean,
      required: false,
      default: true,
    },
  },
  setup({
    initialPage,
    initialComponent,
    resolveComponent,
    titleCallback,
    onHeadUpdate,
    defaultLayout,
    serverHead,
    serverRendered,
  }: InertiaAppProps) {
    component.value = initialComponent ? markRaw(initialComponent) : undefined
    page.value = { ...initialPage, flash: initialPage.flash ?? {} }
    key.value = undefined

    const isServer = typeof window === 'undefined'

    headManager = createHeadManager(
      isServer,
      (title: string) => (titleCallback ? titleCallback(title, page.value!) : title),
      onHeadUpdate || (() => {}),
      resolveServerHead(initialPage, serverHead),
    )

    // Scoped per app instance so multiple Inertia roots on one page don't clobber each other
    const hydrated = ref(!serverRendered)
    provideHydrationContext(hydrated)

    if (!isServer) {
      onMounted(() => (hydrated.value = true))

      router.init<DefineComponent>({
        initialPage,
        resolveComponent: resolveComponent!,
        swapComponent: async (options: VuePageHandlerArgs) => {
          if (!options.preserveState) {
            resetLayoutProps()
          }

          component.value = markRaw(options.component)
          page.value = options.page
          key.value = options.preserveState ? key.value : Date.now()
        },
        onFlash: (flash) => {
          page.value = { ...page.value!, flash }
        },
      })

      const syncServerHead = (event: { detail: { page: Page } }) => {
        headManager.updateServerHead(resolveServerHead(event.detail.page, serverHead))
      }

      router.on('navigate', syncServerHead)
      router.on('clientVisit', syncServerHead)
    }

    return () => {
      if (!component.value) {
        return [undefined, h(LayerStack)]
      }

      if (layout.value) {
        component.value.layout = layout.value
        layout.value = null
      }

      return [
        renderPage(
          component.value,
          page.value!,
          key.value,
          isServer
            ? { shared: {}, named: {} }
            : {
                get shared() {
                  return layoutPropsState.value.shared
                },
                get named() {
                  return layoutPropsState.value.named
                },
              },
          defaultLayout,
        ),
        h(LayerStack),
      ]
    }
  },
})
export default App

export const plugin: Plugin = {
  install(app) {
    router.form = useForm

    Object.defineProperty(app.config.globalProperties, '$inertia', { get: () => router })
    Object.defineProperty(app.config.globalProperties, '$page', { get: () => page.value })
    Object.defineProperty(app.config.globalProperties, '$headManager', { get: () => headManager })

    app.mixin(remember)
  },
}

export function usePage<TPageProps extends PageProps = PageProps>(): Page<TPageProps & SharedPageProps> {
  if (!pageAccessor) {
    pageAccessor = reactive({
      props: computed(() => page.value?.props),
      url: computed(() => page.value?.url),
      component: computed(() => page.value?.component),
      version: computed(() => page.value?.version),
      clearHistory: computed(() => page.value?.clearHistory),
      deferredProps: computed(() => page.value?.deferredProps),
      rescuedProps: computed(() => page.value?.rescuedProps),
      mergeProps: computed(() => page.value?.mergeProps),
      prependProps: computed(() => page.value?.prependProps),
      deepMergeProps: computed(() => page.value?.deepMergeProps),
      matchPropsOn: computed(() => page.value?.matchPropsOn),
      rememberedState: computed(() => page.value?.rememberedState),
      encryptHistory: computed(() => page.value?.encryptHistory),
      scrollProps: computed(() => page.value?.scrollProps),
      flash: computed(() => page.value?.flash),
    }) as Page
  }

  return pageAccessor as Page<TPageProps>
}
