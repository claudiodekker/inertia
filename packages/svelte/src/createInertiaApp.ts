import {
  buildSSRBody,
  createHeadManager,
  exposeInterceptors,
  getInitialPageFromDOM,
  http as httpModule,
  layerSlot,
  resolveServerHead,
  router,
  setupProgress,
  type CreateInertiaAppOptions,
  type CreateInertiaAppOptionsForCSR,
  type InertiaAppSSRResponse,
  type LoadingResolver,
  type Page,
  type PageProps,
  type SharedPageProps,
} from '@inertiajs/core'
import { hydrate, mount, type Component } from 'svelte'
import App, { type InertiaAppProps } from './components/App.svelte'
import Blank from './components/Blank.svelte'
import { config } from './index'
import type { ComponentResolver, LayerComponent, ResolvedComponent, SvelteInertiaAppConfig } from './types'

type SvelteRenderResult = { body: string; head: string }

type SetupOptions<SharedProps extends PageProps> = {
  el: HTMLElement | null
  App: typeof App
  props: InertiaAppProps<SharedProps>
}

type SvelteWithApp<SharedProps extends PageProps> = (
  context: Map<any, any>,
  options: { ssr: boolean; page: Page<SharedProps> },
) => void

type LayerOptions = {
  /** The shell each layer renders in. Defaults to the shipped <Layer>. */
  layer?: LayerComponent
  /** What renders beneath a layer opened cold while its base page is fetched. Called with that base's url. */
  loading?: LoadingResolver<Component<any>>
}

type InertiaAppOptionsForCSR<SharedProps extends PageProps> = CreateInertiaAppOptionsForCSR<
  SharedProps,
  ComponentResolver,
  SetupOptions<SharedProps>,
  SvelteRenderResult | void,
  SvelteInertiaAppConfig
> &
  LayerOptions & {
    withApp?: never
  }

type InertiaAppOptionsAuto<SharedProps extends PageProps> = Omit<
  CreateInertiaAppOptions<
    ComponentResolver,
    SetupOptions<SharedProps>,
    SvelteRenderResult | void,
    SvelteInertiaAppConfig
  >,
  'setup'
> &
  LayerOptions & {
    page?: Page<SharedProps>
  } & (
    | { setup?: undefined; withApp?: SvelteWithApp<SharedProps> }
    | { setup: (options: SetupOptions<SharedProps>) => SvelteRenderResult | void; withApp?: never }
  )

type SvelteServerRender = (
  component: typeof App,
  options: { props: InertiaAppProps<PageProps>; context?: Map<any, any> },
) => SvelteRenderResult

type RenderFunction<SharedProps extends PageProps> = (
  page: Page<SharedProps>,
  render: SvelteServerRender,
) => Promise<InertiaAppSSRResponse>

export default async function createInertiaApp<SharedProps extends PageProps = PageProps & SharedPageProps>(
  options: InertiaAppOptionsForCSR<SharedProps>,
): Promise<InertiaAppSSRResponse | void>
export default async function createInertiaApp<SharedProps extends PageProps = PageProps & SharedPageProps>(
  options?: InertiaAppOptionsAuto<SharedProps>,
): Promise<void | RenderFunction<SharedProps>>
export default async function createInertiaApp<SharedProps extends PageProps = PageProps & SharedPageProps>(
  {
    id = 'app',
    resolve,
    setup,
    progress = {},
    page,
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

  const resolvePage = (name: string, page?: Page) => Promise.resolve(resolve!(name, page)) as Promise<ResolvedComponent>
  const resolveWrapped = layerSlot.wrapResolver<ResolvedComponent | Component<any>>(resolvePage, loading, {
    default: Blank,
    layout: [],
  })
  const resolveComponent = async (name: string, page?: Page, layers?: Parameters<typeof resolveWrapped>[2]) => {
    const found = await resolveWrapped(name, page, layers)

    return (typeof found === 'function' ? { default: found } : found) as ResolvedComponent
  }

  // The base and every layer the document arrived with resolve before the first render, so the
  // server and the hydrating client render the same tree.
  const boot = async (response: Page) => {
    const plan = layerSlot.planBoot(response, isServer ? '' : window.location.hash)
    const [initialComponent, ...seedComponents] = await Promise.all([
      resolveComponent(plan.base.component, plan.base, plan.info),
      ...plan.seeds.map((seed) => resolvePage(seed.page.component, seed.page)),
    ])

    return { plan, initialComponent, seedComponents }
  }

  // SSR render function factory - when on server without page, return a render function
  // This is used by the Vite plugin's SSR transform
  if (isServer && !page) {
    return async (page: Page<SharedProps>, render: SvelteServerRender) => {
      const { plan, initialComponent, seedComponents } = await boot(page)

      const props: InertiaAppProps<SharedProps> = {
        initialPage: plan.base as Page<SharedProps>,
        initialComponent,
        initialLayers: layerSlot.ssrViews(plan, seedComponents),
        resolveComponent,
        defaultLayout: layout,
        serverRendered: true,
        layer,
      }

      let svelteApp: SvelteRenderResult

      if (setup) {
        const result = await setup({ el: null, App, props })
        if (!result) {
          throw new Error('Inertia SSR setup function must return a render result ({ body, head })')
        }
        svelteApp = result
      } else {
        const context = new Map()

        if (withApp) {
          withApp(context, { ssr: true, page })
        }

        svelteApp = await render(App, { props, context })
      }

      const body = buildSSRBody(id, page, svelteApp.body)

      return {
        body,
        head: [...resolveServerHead(plan.top, serverHead), svelteApp.head],
      }
    }
  }

  const initialPage = page || getInitialPageFromDOM<Page<SharedProps>>(id)!

  const [{ plan, initialComponent, seedComponents }] = await Promise.all([
    boot(initialPage),
    router.decryptHistory().catch(() => {}),
  ])

  const serverHeadManager =
    !isServer && serverHead
      ? createHeadManager(
          false,
          (title) => title,
          () => {},
          resolveServerHead(plan.top, serverHead),
        )
      : null

  const el = isServer ? null : document.getElementById(id)!

  if (!isServer) {
    layerSlot.boot(plan, seedComponents)
  }

  const props: InertiaAppProps<SharedProps> = {
    initialPage: plan.base as Page<SharedProps>,
    initialComponent,
    initialLayers: isServer ? layerSlot.ssrViews(plan, seedComponents) : undefined,
    resolveComponent,
    defaultLayout: layout,
    serverRendered: isServer || el!.hasAttribute('data-server-rendered'),
    layer,
  }

  // SSR with page provided (legacy pattern used by ssr.ts)
  if (isServer) {
    if (!setup) {
      throw new Error('Inertia SSR requires a setup function that returns a render result ({ body, head })')
    }

    const svelteApp = await setup({ el: null, App, props })

    if (svelteApp) {
      const body = buildSSRBody(id, initialPage, svelteApp.body)

      return {
        body,
        head: [...resolveServerHead(plan.top, serverHead), svelteApp.head],
      }
    }

    return
  }

  // CSR
  const target = el!
  const isServerRendered = props.serverRendered!

  if (setup) {
    await setup({ el: target, App, props })
  } else {
    const context = new Map()

    if (withApp) {
      withApp(context, { ssr: false, page: initialPage })
    }

    if (isServerRendered) {
      hydrate(App, { target, props, context })
    } else {
      mount(App, { target, props, context })
    }
  }

  if (serverHeadManager) {
    const syncServerHead = (event: { detail: { page: Page } }) => {
      serverHeadManager.updateServerHead(resolveServerHead(layerSlot.topPage() ?? event.detail.page, serverHead))
    }

    router.on('navigate', syncServerHead)
    router.on('clientVisit', syncServerHead)
  }

  if (progress) {
    setupProgress(progress)
  }
}
