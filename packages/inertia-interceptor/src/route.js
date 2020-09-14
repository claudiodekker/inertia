export default {
  routes: {},
  parseRoute(uri) {
    // Fetch the current domain's root address, and parse everything
    // (protocol, host, port), after which we will remove this
    // portion from the URL to end up with the route itself.
    const rootAddress = window.location.href.split('/').slice(0, 3).join('/')
    const [ endpoint, params ] = uri.replace(rootAddress, '').split('?')

    return {
      route: endpoint && endpoint.charAt(0) === '/' ? endpoint : '/' + endpoint,
      params: new URLSearchParams(params || {}),
    }
  },
  addRoute(method, uri, action = null) {
    const _method = method.toLowerCase()
    const { route } = this.parseRoute(uri)

    // Ensure that the method 'group' (GET, POST, PATCH) exists.
    if (Object.keys(this.routes).indexOf(_method) === -1) {
      this.routes[_method] = {}
    }

    // Ensure that the action is actually an invokable function.
    if (typeof action !== 'function') {
      console.error(`[Interceptor] Route action [${method.toUpperCase()} ${route}] is not a function.`)

      return false
    }

    this.routes[_method][route] = action
  },
  exists(method, uri) {
    const { route } = this.parseRoute(uri)

    if (Object.keys(this.routes[method.toLowerCase()] || {}).indexOf(route) > -1) {
      return true
    }

    console.warn(`[Interceptor] No route registered for [${method.toUpperCase()} ${route}].`, this.routes)
    return false
  },
  invoke(method, uri, event = null) {
    const { route, params } = this.parseRoute(uri)

    const action = this.routes[method.toLowerCase()][route]
    const response = action({ method, route, params, uri, event })

    // After all redirects are said and done, we'll make sure to
    // set our resulting url to the current URI so it can be
    // properly reflected in the browser's address bar.
    if (response.url === null) {
      response.url = uri
    }

    return response
  },
  get(path, action = null) {
    return this.addRoute('GET', path, action)
  },
  post(path, action = null) {
    return this.addRoute('POST', path, action)
  },
  put(path, action = null) {
    return this.addRoute('PUT', path, action)
  },
  patch(path, action = null) {
    return this.addRoute('PATCH', path, action)
  },
  delete(path, action = null) {
    return this.addRoute('DELETE', path, action)
  },
}
