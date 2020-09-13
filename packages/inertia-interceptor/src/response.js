export default {
  sharedProps: {},
  version: null,
  share(key, value = null) {
    if (typeof key === 'object') {
      this.sharedProps = { ... this.sharedProps, ...key}
    } else {
      this.sharedProps[key] = value
    }
  },
  getShared(key = null) {
    if (key) {
      return this.sharedProps[key] || null
    }

    return this.sharedProps
  },
  setVersion(version) {
    this.version = version
  },
  getVersion() {
    return typeof this.version === 'function'
      ? this.version()
      : this.version
  },
  render(component, props = {}, url = null) {
    const resolvedProps = { ... this.getShared(), ... props }
    Object.keys(resolvedProps).forEach(key => {
      const value = resolvedProps[key]

      if (typeof value === 'function') {
        resolvedProps[key] = value()
      }
    })

    return {
      component,
      props: resolvedProps,
      url,
      version: this.getVersion(),
    }
  },
}
