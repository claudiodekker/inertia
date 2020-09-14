import { Inertia } from '@inertiajs/inertia'
import { default as Route } from './route'

export default {
  setup(element = null, routes = null) {
    // When the user passes a closure, we'll call it with the Route helper.
    // This allows them to define routes without the need to manually
    // import the 'Route' helper in their codebase. Useful!
    if (typeof routes === 'function') {
      routes(Route)
    }

    if (element && Route.exists('GET', window.location.href)) {
      // Next, we'll initialize the 'root' element that Inertia mounts on.
      // We'll do this by 'visiting' an initial page, and by 'passing'
      // the page data, just like the @inertia directive would do.
      element.setAttribute('data-page', JSON.stringify(Route.invoke('GET', window.location.href)))
    }

    // Finally, we register ourselves to Inertia's on-visit listener.
    // We'll use this to intercept & cancel the outgoing request
    // after which we'll resolve and update the page directly
    Inertia.on('visit', event => {
      const path = event.detail.url.toString()
      const method = event.detail.options.method || 'GET'

      // Check if the route is actually registered.
      // If it isn't, we won't intercept it.
      if (! Route.exists(method, path)) {
        return
      }

      event.preventDefault()

      Inertia.setPage(
        Route.invoke(method, path, event),
        event.detail.options,
      )
    })
  },
}
