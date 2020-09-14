export default {
  routes: {},
  parseRoute(uri) {
    const rootAddress = window.location.href.split('/').slice(0, 3).join('/')
    const [ endpoint, params ] = uri.replace(rootAddress, '').split('?')

    return {
      route: endpoint && endpoint.charAt(0) === '/' ? endpoint : '/' + endpoint,
      params: new URLSearchParams(params || {}),
    }
  },
  addRoute(method, uri, callback = null) {
    const _method = method.toLowerCase()
    const { route } = this.parseRoute(uri)

    // Ensure that the method 'group' (GET, POST, PATCH) exists.
    if (Object.keys(this.routes).indexOf(_method) === -1) {
      this.routes[_method] = {}
    }

    this.routes[_method][route] = callback
  },
  exists(method, uri) {
    const { route } = this.parseRoute(uri)
    if (Object.keys(this.routes[method.toLowerCase()] || {}).indexOf(route) > -1) {
      return true
    }

    console.error(`[Interceptor] No route registered for [${method.toUpperCase()} ${route}].`, this.routes)
    return false
  },
  invoke(method, uri, event = null) {
    const { route, params } = this.parseRoute(uri)

    const action = this.routes[method.toLowerCase()][route]
    if (typeof action !== 'function') {
      console.error(`[Interceptor] Route [${method.toUpperCase()} ${route}] is not a function.`)

      return false
    }

    const response = action({ params, uri, event })

    // After all redirects are said and done, we'll make sure to
    // set our resulting url to the current URI so it can be
    // properly reflected in the browser's address bar.
    if (response.url === null) {
      response.url = uri
    }

    return response
  },
  get(path, callback = null) {
    return this.addRoute('GET', path, callback)
  },
  post(path, callback = null) {
    return this.addRoute('POST', path, callback)
  },
  put(path, callback = null) {
    return this.addRoute('PUT', path, callback)
  },
  patch(path, callback = null) {
    return this.addRoute('PATCH', path, callback)
  },
  delete(path, callback = null) {
    return this.addRoute('DELETE', path, callback)
  },
}
