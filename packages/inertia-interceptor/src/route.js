export default {
  routes: {},
  ensurePathPrefixed(path) {
    return path.charAt(0) !== '/'
      ? '/' + path
      : path
  },
  register(method, path, callback = null) {
    const _method = method.toLowerCase()

    // Ensure that the method 'group' (GET, POST, PATCH) exists.
    if (Object.keys(this.routes).indexOf(_method) === -1) {
      this.routes[_method] = {}
    }

    this.routes[_method][this.ensurePathPrefixed(path)] = callback
  },
  exists(method, path) {
    if (Object.keys(this.routes[method.toLowerCase()] || {}).indexOf(this.ensurePathPrefixed(path)) > -1) {
      return true
    }

    console.error(`[Interceptor] No route registered for [${method.toUpperCase()} ${path}].`, this.routes)
    return false
  },
  invoke(method, path, event = {}) {
    const route = this.routes[method.toLowerCase()][this.ensurePathPrefixed(path)]
    if (typeof route !== 'function') {
      console.error(`[Interceptor] Route [${method.toUpperCase()} ${path}] is not a function.`)

      return false
    }

    const response = route(event)

    // After all redirects are said and done, we'll make sure to
    // set the current 'url' to the first response's route.
    if (response.url === null) {
      response.url = path
    }

    return response
  },
  get(path, callback = null) {
    return this.register('GET', path, callback)
  },
  post(path, callback = null) {
    return this.register('POST', path, callback)
  },
  put(path, callback = null) {
    return this.register('PUT', path, callback)
  },
  patch(path, callback = null) {
    return this.register('PATCH', path, callback)
  },
  delete(path, callback = null) {
    return this.register('DELETE', path, callback)
  },
}
