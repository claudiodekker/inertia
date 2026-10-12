import { layerSlot, type LayerView, type Page } from '@inertiajs/core'
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onUnmounted,
  provide,
  shallowRef,
  type Component,
  type DefineComponent,
  type PropType,
} from 'vue'
import Layer from './Layer'
import { layerKey } from './layerContext'
import renderPage from './renderPage'

type DefaultLayout = (name: string, page: Page) => unknown

const LayerFrame = defineComponent({
  name: 'InertiaLayerFrame',
  props: {
    view: { type: Object as PropType<LayerView>, required: true },
    shell: { type: [Object, Function] as PropType<Component>, required: true },
    defaultLayout: { type: Function as PropType<DefaultLayout>, required: false },
  },
  setup(props) {
    provide(layerKey, { scope: props.view.scope, page: computed(() => props.view.page) })

    const layout = shallowRef(props.view.layout.get())
    const stop = props.view.layout.subscribe(() => (layout.value = props.view.layout.get()))

    onUnmounted(stop)

    return () => {
      const { view } = props

      return h(props.shell, view.shell, () =>
        h('div', { ...view.attributes, ref: (el) => layerSlot.bindElement(view.id, el as Element | null) }, [
          renderPage(
            view.component as DefineComponent,
            view.page,
            view.renderKey,
            {
              get shared() {
                return layout.value.shared
              },
              get named() {
                return layout.value.named
              },
            },
            props.defaultLayout,
          ),
        ]),
      )
    }
  },
})

export default defineComponent({
  name: 'InertiaLayerStack',
  props: {
    shell: { type: [Object, Function] as PropType<Component>, required: false },
    defaultLayout: { type: Function as PropType<DefaultLayout>, required: false },
  },
  setup(props) {
    const views = shallowRef(layerSlot.views())

    if (typeof window !== 'undefined') {
      onUnmounted(
        layerSlot.subscribe(() => {
          views.value = layerSlot.views()

          return nextTick()
        }),
      )
    }

    return () =>
      views.value.length > 0
        ? views.value.map((view) =>
            h(LayerFrame, { key: view.id, view, shell: props.shell ?? Layer, defaultLayout: props.defaultLayout }),
          )
        : null
  },
})
