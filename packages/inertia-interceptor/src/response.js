import { Route } from './index'

export default {
  sharedProps: {},
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
  render(component, props = {}, url = null) {
    return {
      component,
      props: { ... this.getShared(), ... props },
      url,
      version: null,
    }
  },
  redirect: (url, event = {}) => {
    if (! Route.exists('GET', url)) {
      return
    }

    return Route.invoke('GET', url, event)
  },
}
