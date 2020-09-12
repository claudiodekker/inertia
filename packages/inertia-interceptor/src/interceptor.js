import { Inertia } from '@inertiajs/inertia'
import { default as Response } from './response'
import { default as Route } from './route'

export default {
  routes: {},
  parseEvent(event) {
    const { url, options } = event.detail

    return {
      url: url.toString(),
      method: options.method.toLowerCase(),
      data: options.data,
      event,
    }
  },

  setup(element = null, component = null, props = {}, url = null) {
    if (element && component) {
      element.setAttribute('data-page', JSON.stringify(Response.render(
        component,
        props,
        url,
      )))
    }

    Inertia.on('visit', event => {
      const hostname = window.location.href.split('/').slice(0, 3).join('/')

      const path = event.detail.url.toString().replace(hostname, '')
      const method = event.detail.options.method

      if (!Route.exists(method, path)) {
        return false
      }

      event.preventDefault()
      Inertia.setPage(
        Route.visit(method, path, event),
        event.detail.options,
      )
    })
  },
}
