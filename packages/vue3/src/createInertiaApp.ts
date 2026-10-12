/// <reference path="./env.d.ts" />
import {
  buildSSRBody,
  CreateInertiaAppOptions,
  CreateInertiaAppOptionsForCSR,
  CreateInertiaAppOptionsForSSR,
  exposeInterceptors,
  getInitialPageFromDOM,
  http as httpModule,
  InertiaAppSSRResponse,
  layerSlot,
  LoadingResolver,
  Page,
  PageProps,
  router,
  setupProgress,
  SharedPageProps,
} from '@inertiajs/core'
import { Component, createApp, createSSRApp, DefineComponent, h, markRaw, Plugin, App as VueApp } from 'vue'
import App, { InertiaApp, InertiaAppProps, plugin } from './app'
import { config } from './index'
import { VueInertiaAppConfig } from './types'

type ComponentResolver = (
  name: string,
  page?: Page<SharedPageProps>,
) => DefineComponent | Promise<DefineComponent> | { default: DefineComponent }

type SetupOptions<ElementType, SharedProps extends PageProps> = {
  el: ElementType
  App: InertiaApp
  props: InertiaAppProps<SharedProps>
  plugin: Plugin
}

type VueWithApp<SharedProps extends PageProps> = (
  app: VueApp,
  options: { ssr: boolean; page: Page<SharedProps> },
) => void

type LayerOptions = {
  /** The shell each layer renders in. Defaults to the shipped <Layer>. */
  layer?: Component
  /** What renders beneath a layer opened cold while its base page is fetched. Called with that base's url. */
  loading?: LoadingResolver<Component>
}

type InertiaAppOptionsForCSR<SharedProps extends PageProps> = CreateInertiaAppOptionsForCSR<
  SharedProps,
  ComponentResolver,
  SetupOptions<HTMLElement, SharedProps>,
  void,
  VueInertiaAppConfig
> &
  LayerOptions & {
    withApp?: never
  }

type InertiaAppOptionsForSSR<SharedProps extends PageProps> = CreateInertiaAppOptionsForSSR<
  SharedProps,
  ComponentResolver,
  SetupOptions<null, SharedProps>,
  VueApp,
  VueInertiaAppConfig
> &
  LayerOptions & {
    render: (app: VueApp) => Promise<string>
    withApp?: never
  }

type InertiaAppOptionsAuto<SharedProps extends PageProps> = Omit<
  CreateInertiaAppOptions<
    ComponentResolver,
    SetupOptions<HTMLElement | null, SharedProps>,
    VueApp | void,
    VueInertiaAppConfig
  >,
  'setup'
> &
  LayerOptions & {
    page?: Page<SharedProps>
    render?: undefined
  } & (
    | { setup?: undefined; withApp?: VueWithApp<SharedProps> }
    | { setup: (options: SetupOptions<HTMLElement | null, SharedProps>) => VueApp | void; withApp?: never }
  )

type RenderToString = (app: VueApp) => Promise<string>

/** What the blank base renders when the app has no loading component for it: nothing, in no layout. */
const Blank = markRaw({ name: 'InertiaBlank', layout: [], render: () => null }) as unknown as DefineComponent

type RenderFunction<SharedProps extends PageProps> = (
  page: Page<SharedProps>,
  renderToString: RenderToString,
) => Promise<InertiaAppSSRResponse>

export default async function createInertiaApp<SharedProps extends PageProps = PageProps & SharedPageProps>(
  options: InertiaAppOptionsForCSR<SharedProps>,
): Promise<void>
export default async function createInertiaApp<SharedProps extends PageProps = PageProps & SharedPageProps>(
  options: InertiaAppOptionsForSSR<SharedProps>,
): Promise<InertiaAppSSRResponse>
export default async function createInertiaApp<SharedProps extends PageProps = PageProps & SharedPageProps>(
  options?: InertiaAppOptionsAuto<SharedProps>,
): Promise<void | RenderFunction<SharedProps>>
export default async function createInertiaApp<SharedProps extends PageProps = PageProps & SharedPageProps>(
  {
    id = 'app',
    resolve,
    setup,
    title,
    progress = {},
    page,
    render,
    defaults = {},
    nonce,
    http,
    layout,
    serverHead,
    withApp,
    layer,
    loading,
    dev = !!import.meta.env?.DEV,
  }:
    | InertiaAppOptionsForCSR<SharedProps>
    | InertiaAppOptionsForSSR<SharedProps>
    | InertiaAppOptionsAuto<SharedProps> = {} as InertiaAppOptionsAuto<SharedProps>,
): Promise<InertiaAppSSRResponse | RenderFunction<SharedProps> | void> {
  config.replace(defaults)

  if (nonce) {
    config.set('nonce', nonce)
  }

  if (http) {
    httpModule.setClient(http)
  }

  if (dev) {
    exposeInterceptors()
  }

  const isServer = typeof window === 'undefined'

  const resolvePage = (name: string, page?: Page) =>
    Promise.resolve(resolve!(name, page)).then((module) => module.default || module)
  const resolveComponent = layerSlot.wrapResolver(
    resolvePage,
    loading as LoadingResolver<DefineComponent> | undefined,
    Blank,
  )

  // The base and every layer the document arrived with resolve before the first render, so the
  // server and the hydrating client render the same tree.
  const boot = async (response: Page) => {
    const plan = layerSlot.planBoot(response, isServer ? '' : window.location.hash)
    const [initialComponent, ...layerComponents] = await Promise.all([
      resolveComponent(plan.base.component, plan.base, plan.info),
      ...plan.layers.map((layer) => resolvePage(layer.page.component, layer.page)),
    ])

    return { plan, initialComponent, layerComponents }
  }

  // SSR render function factory - when on server without page/render, return a render function
  // This is used by the Vite plugin's SSR transform
  if (isServer && !page && !render) {
    return async (page: Page<SharedProps>, renderToString: RenderToString) => {
      let head: string[] = []

      const { plan, initialComponent, layerComponents } = await boot(page)

      const props: InertiaAppProps<SharedProps> = {
        initialPage: plan.base as Page<SharedProps>,
        initialComponent,
        initialLayers: layerSlot.ssrViews(plan, layerComponents),
        resolveComponent,
        titleCallback: title,
        onHeadUpdate: (elements: string[]) => (head = elements),
        defaultLayout: layout,
        serverHead,
        serverRendered: true,
        layer,
      }

      let vueApp: VueApp

      if (setup) {
        vueApp = (setup as (options: SetupOptions<null, SharedProps>) => VueApp)({
          el: null,
          App,
          props,
          plugin,
        })
      } else {
        vueApp = createSSRApp({ render: () => h(App, props) })
        vueApp.use(plugin)

        if (withApp) {
          withApp(vueApp, { ssr: true, page })
        }
      }

      const html = await renderToString(vueApp)
      const body = buildSSRBody(id, page, html)

      return { head, body }
    }
  }

  const initialPage = page || getInitialPageFromDOM<Page<SharedProps>>(id)!

  let head: string[] = []

  const vueApp = await Promise.all([boot(initialPage), router.decryptHistory().catch(() => {})]).then(([booted]) => {
    const { plan, initialComponent, layerComponents } = booted
    const el = isServer ? null : document.getElementById(id)!

    if (!isServer) {
      layerSlot.boot(plan, layerComponents)
    }

    const props: InertiaAppProps<SharedProps> = {
      initialPage: plan.base as Page<SharedProps>,
      initialComponent,
      initialLayers: isServer ? layerSlot.ssrViews(plan, layerComponents) : undefined,
      resolveComponent,
      titleCallback: title,
      onHeadUpdate: isServer ? (elements: string[]) => (head = elements) : undefined,
      defaultLayout: layout,
      serverHead,
      serverRendered: isServer || el!.hasAttribute('data-server-rendered'),
      layer,
    }

    if (isServer) {
      return (setup as (options: SetupOptions<null, SharedProps>) => VueApp)({
        el: null,
        App,
        props,
        plugin,
      })
    }

    const target = el!
    const isServerRendered = props.serverRendered!

    if (setup) {
      return (setup as (options: SetupOptions<HTMLElement, SharedProps>) => void)({
        el: target,
        App,
        props,
        plugin,
      })
    }

    // Default mounting when setup is not provided
    if (isServerRendered) {
      const app = createSSRApp({ render: () => h(App, props) })
      app.use(plugin)

      if (withApp) {
        withApp(app, { ssr: false, page: initialPage })
      }

      app.mount(target)
    } else {
      const app = createApp({ render: () => h(App, props) })
      app.use(plugin)

      if (withApp) {
        withApp(app, { ssr: false, page: initialPage })
      }

      app.mount(target)
    }
  })

  if (!isServer && progress) {
    setupProgress(progress)
  }

  if (isServer && render && vueApp) {
    const html = await render(vueApp)
    const body = buildSSRBody(id, initialPage, html)

    return { head, body }
  }
}
