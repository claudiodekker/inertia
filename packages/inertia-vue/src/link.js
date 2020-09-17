import { Inertia, shouldIntercept } from '@inertiajs/inertia'

export default {
  functional: true,
  props: {
    data: {
      type: Object,
      default: () => ({}),
    },
    href: {
      type: String,
      required: true,
    },
    method: {
      type: String,
      default: 'get',
    },
    replace: {
      type: Boolean,
      default: false,
    },
    prefetch: {
      type: Boolean,
      default: true,
    },
    preserveScroll: {
      type: Boolean,
      default: false,
    },
    preserveState: {
      type: Boolean,
      default: false,
    },
    only: {
      type: Array,
      default: () => [],
    },
    headers: {
      type: Object,
      default: () => ({}),
    },
  },
  render(h, { props, data, children }) {
    return h('a', {
      ...data,
      attrs: {
        ...data.attrs,
        href: props.href,
      },
      on: {
        ...(data.on || {}),
        click: event => {
          if (data.on && data.on.click) {
            data.on.click(event)
          }

          if (shouldIntercept(event)) {
            event.preventDefault()

            Inertia.visit(props.href, {
              data: props.data,
              method: props.method,
              replace: props.replace,
              preserveScroll: props.preserveScroll,
              preserveState: props.preserveState,
              only: props.only,
              headers: props.headers,
            }).then(() => data.prefetcher = undefined)
          }
        },
        mouseover: event => {
          if (data.on && data.on.hover) {
            data.on.hover(event)
          }

          if (!props.prefetch || data.prefetcher) {
            return
          }

          data.prefetchTimer = setTimeout(() => {
            if (props.method.toLowerCase() === 'get') {
              Inertia.preload(props.href, { data: props.data, headers: props.headers })
            }

            data.prefetchTimer = undefined
          }, 65)
        },
        mouseleave: () => {
          if (data.prefetchTimer) {
            clearTimeout(data.prefetchTimer)
            data.prefetchTimer = undefined
          }
        },
      },
    }, children)
  },
}
