import { isPropsObject, isPropsObjectOrCallback, normalizeLayouts, type Page, type PageProps } from '@inertiajs/core'
import type { Component } from 'svelte'
import { h, type RenderProps } from './components/Render.svelte'
import type { LayoutResolver, LayoutType, ResolvedComponent } from './types'

export type LayoutSnapshot = { shared: Record<string, any>; named: Record<string, Record<string, any>> }

export type DefaultLayout = (name: string, page: Page) => unknown

function isComponent(value: unknown): value is Component {
  if (!value) {
    return false
  }

  if (typeof value === 'function') {
    const fn = value as Function & { name?: string }
    return fn.name !== ''
  }

  if (typeof value === 'object' && '$$' in value) {
    return true
  }

  return false
}

function isRenderFunction(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    (value as Function).length === 2 &&
    typeof (value as Function).prototype === 'undefined'
  )
}

/** The page component inside its layouts. The base and every layer render through it. */
export default function renderPage(
  component: ResolvedComponent,
  page: Page,
  key: number | null,
  layoutSnapshot: LayoutSnapshot,
  defaultLayout?: DefaultLayout,
): RenderProps {
  const child = h(component.default, page.props, [], key)

  if (component.layout && isRenderFunction(component.layout)) {
    return (component.layout as LayoutResolver)(h, child)
  }

  let effectiveLayout: LayoutType | undefined
  let callbackProps: Record<string, unknown> | null = null
  const layoutValue = component.layout

  if (
    typeof layoutValue === 'function' &&
    (layoutValue as Function).length <= 1 &&
    typeof (layoutValue as Function).prototype === 'undefined'
  ) {
    const result = (layoutValue as Function)(page.props)

    if (isPropsObjectOrCallback(result, isComponent)) {
      effectiveLayout = defaultLayout?.(page.component, page) as LayoutType | undefined
      callbackProps = result as Record<string, unknown>
    } else {
      effectiveLayout = result as LayoutType | undefined
    }
  } else if (isPropsObject(layoutValue, isComponent)) {
    effectiveLayout = defaultLayout?.(page.component, page) as LayoutType | undefined
    callbackProps = layoutValue as Record<string, unknown>
  } else {
    effectiveLayout = (layoutValue ?? defaultLayout?.(page.component, page)) as LayoutType | undefined
  }

  return effectiveLayout
    ? resolveLayout(
        effectiveLayout,
        child,
        page.props,
        key,
        layoutSnapshot,
        !!component.layout && !callbackProps,
        callbackProps,
      )
    : child
}

function resolveLayout(
  layout: LayoutType,
  child: RenderProps,
  pageProps: PageProps,
  key: number | null,
  dynamicProps: LayoutSnapshot,
  isFromPage: boolean = true,
  callbackProps: Record<string, unknown> | null = null,
): RenderProps {
  if (isFromPage && isRenderFunction(layout)) {
    return (layout as LayoutResolver)(h, child)
  }

  let layouts = normalizeLayouts(layout, isComponent, isFromPage ? isRenderFunction : undefined)

  if (callbackProps) {
    layouts = layouts.map((l) => ({ ...l, props: { ...l.props, ...callbackProps } }))
  }

  if (layouts.length > 0) {
    return layouts.reduceRight((child, layout) => {
      return {
        ...h(
          layout.component,
          {
            ...pageProps,
            ...layout.props,
            ...dynamicProps.shared,
            ...(layout.name ? dynamicProps.named[layout.name] || {} : {}),
          },
          [child],
          key,
        ),
        name: layout.name,
      }
    }, child)
  }

  return child
}
