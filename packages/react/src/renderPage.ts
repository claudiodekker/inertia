import { isPropsObject, isPropsObjectOrCallback, normalizeLayouts, type Page } from '@inertiajs/core'
import { createElement, isValidElement, ReactNode } from 'react'
import { LayoutFunction, ReactComponent } from './types'

export type LayoutSnapshot = {
  shared: Record<string, any>
  named: Record<string, Record<string, any>>
}

function isComponent(value: unknown): value is ReactComponent {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value)
}

function isRenderFunction(value: unknown): boolean {
  if (typeof value !== 'function') {
    return false
  }

  const fn = value as Function
  return fn.length === 1 && typeof fn.prototype === 'undefined'
}

function isLayoutResolver(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    (value as Function).length <= 1 &&
    typeof (value as Function).prototype === 'undefined'
  )
}

export default function renderPage(
  Component: ReactComponent,
  page: Page,
  key: number | null,
  layoutSnapshot: LayoutSnapshot,
  defaultLayout?: (name: string, page: Page) => unknown,
): ReactNode {
  const props = page.props
  const child = createElement(Component, { key, ...props })

  let effectiveLayout: unknown
  let callbackProps: Record<string, unknown> | null = null
  const layoutValue = Component.layout

  if (isLayoutResolver(layoutValue)) {
    const result = (layoutValue as Function)(props)

    if (isValidElement(result)) {
      return (layoutValue as LayoutFunction)(child)
    }

    if (isPropsObjectOrCallback(result, isComponent)) {
      effectiveLayout = defaultLayout?.(page.component, page)
      callbackProps = result as Record<string, unknown>
    } else {
      effectiveLayout = result
    }
  } else if (isPropsObject(layoutValue, isComponent)) {
    effectiveLayout = defaultLayout?.(page.component, page)
    callbackProps = layoutValue as unknown as Record<string, unknown>
  } else {
    effectiveLayout = layoutValue ?? defaultLayout?.(page.component, page)
  }

  let layouts = normalizeLayouts(
    effectiveLayout,
    isComponent,
    layoutValue && !callbackProps ? isRenderFunction : undefined,
  )

  if (callbackProps) {
    layouts = layouts.map((l) => ({
      ...l,
      props: { ...l.props, ...callbackProps },
    }))
  }

  if (layouts.length > 0) {
    return layouts.reduceRight((childNode, layout) => {
      return createElement(
        layout.component,
        {
          ...props,
          ...layout.props,
          ...layoutSnapshot.shared,
          ...(layout.name ? layoutSnapshot.named[layout.name] || {} : {}),
        },
        childNode,
      )
    }, child)
  }

  return child
}
