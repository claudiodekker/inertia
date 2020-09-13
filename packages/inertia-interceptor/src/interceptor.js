import { Inertia } from '@inertiajs/inertia'
import { default as Route } from './route'

export default {
  setup(element = null, endpoint = '/') {
    if (element && endpoint) {
      element.setAttribute('data-page', JSON.stringify(Route.visit('get', endpoint)))
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
