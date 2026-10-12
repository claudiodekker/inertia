import { isPropsObject, isPropsObjectOrCallback, normalizeLayouts, type Page } from '@inertiajs/core'
import { Component, DefineComponent, h, VNode } from 'vue'

type LayoutComponent = DefineComponent | Component

export type LayoutSnapshot = {
  shared: Record<string, any>
  named: Record<string, any>
}

function isComponent(value: unknown): value is LayoutComponent {
  if (!value) {
    return false
  }

  if (typeof value === 'function') {
    return true
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return (
      typeof obj.render === 'function' ||
      typeof obj.setup === 'function' ||
      typeof obj.template === 'string' ||
      '__file' in obj ||
      '__name' in obj
    )
  }

  return false
}

function isRenderFunction(value: unknown): boolean {
  if (typeof value !== 'function') {
    return false
  }

  const fn = value as Function
  return fn.length === 2 && typeof fn.prototype === 'undefined'
}

export default function renderPage(
  component: DefineComponent,
  page: Page,
  key: number | undefined,
  layoutSnapshot: LayoutSnapshot,
  defaultLayout?: (name: string, page: Page) => unknown,
): VNode {
  component.inheritAttrs = !!component.inheritAttrs

  const child = h(component, {
    ...page.props,
    key,
  })

  if (component.layout && isRenderFunction(component.layout)) {
    return (component.layout as Function)(h, child)
  }

  let effectiveLayout: unknown
  let callbackProps: Record<string, unknown> | null = null
  const layoutValue = component.layout

  if (
    typeof layoutValue === 'function' &&
    (layoutValue as Function).length <= 1 &&
    typeof (layoutValue as Function).prototype === 'undefined'
  ) {
    const result = (layoutValue as Function)(page.props)

    if (isPropsObjectOrCallback(result, isComponent)) {
      effectiveLayout = defaultLayout?.(page.component, page)
      callbackProps = result as Record<string, unknown>
    } else {
      effectiveLayout = result
    }
  } else if (isPropsObject(layoutValue, isComponent)) {
    effectiveLayout = defaultLayout?.(page.component, page)
    callbackProps = layoutValue as Record<string, unknown>
  } else {
    effectiveLayout = layoutValue ?? defaultLayout?.(page.component, page)
  }

  if (effectiveLayout) {
    let layouts = normalizeLayouts(
      effectiveLayout,
      isComponent,
      component.layout && !callbackProps ? isRenderFunction : undefined,
    )

    if (callbackProps) {
      layouts = layouts.map((l) => ({
        ...l,
        props: { ...l.props, ...callbackProps },
      }))
    }

    if (layouts.length > 0) {
      return layouts.reduceRight((childNode, layout) => {
        const layoutComponent = layout.component as DefineComponent
        layoutComponent.inheritAttrs = !!layoutComponent.inheritAttrs

        return h(
          layoutComponent,
          {
            ...page.props,
            ...layout.props,
            ...layoutSnapshot.shared,
            ...(layout.name ? layoutSnapshot.named[layout.name] || {} : {}),
          },
          () => childNode,
        )
      }, child)
    }
  }

  return child
}
