export default {
  routes: {},
  ensurePathPrefixed(path) {
    return path.charAt(0) !== '/'
      ? '/' + path
      : path
  },
  register(method, path, callback = null) {
    if (Object.keys(this.routes).indexOf(method.toLowerCase()) === -1) {
      this.routes[method] = {}
    }

    this.routes[method.toLowerCase()][this.ensurePathPrefixed(path)] = callback
  },
  exists(method, path) {
    return Object.keys(this.routes[method.toLowerCase()] || {}).indexOf(this.ensurePathPrefixed(path)) > -1
  },
  visit(method, path, event = {}) {
    if (!this.exists(method, path)) {
      return false
    }

    const response = this.routes[method.toLowerCase()][this.ensurePathPrefixed(path)](event)
    if (response.url === null) {
      response.url = path
    }

    return response
  },
}
