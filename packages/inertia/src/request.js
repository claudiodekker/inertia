import Axios from 'axios'
import modal from './modal'

export default {
  cached: {},
  cancelToken: null,
  isCached(url) {
    console.log('isCached')
    return this.cached[url] && this.cached[url].response
  },
  isPreloading(url) {
    console.log('isPreloading')
    return this.cached[url] && this.cached[url].preloading
  },
  isInertiaResponse(response) {
    return response && response.headers['x-inertia']
  },
  ensureCacheEntryExists(url) {
    if (Object.keys(this.cached).indexOf(url) === -1) {
      this.cached[url] = {
        callbacks: [],
        preloading: false,
      }
    }
  },
  markAsPreloading(url) {
    this.ensureCacheEntryExists(url)
    this.cached[url].preloading = true
    console.log('markAsPreloading')
  },
  cacheResponse(url, response = null) {
    this.ensureCacheEntryExists(url)
    this.cached[url].response = response
    this.cached[url].preloading = false
    console.log('cacheResponse')
  },
  clearCached(url) {
    this.cacheResponse(url, null)
    console.log('cancelPreload')
  },
  observeResponse(url) {
    this.ensureCacheEntryExists(url)
    console.log('observeResponse')

    return new Promise(resolve => this.cached[url].callbacks.push(callback => resolve(callback)))
  },
  preload(url, { data = {}, headers = {} } = {}) {
    console.log(this)
    if (this.isPreloading(url) || this.isCached(url)) {
      console.log('preload::preloadingOrCached')
      return
    }

    console.log('preload')

    headers = {
      ... headers,
      'X-Inertia-Preload': true,
    }

    const args = { url, data, headers }
    this.send(args)
      .then(response => this.cacheResponse(url, response))
      .catch(() => this.clearCached(url))
  },
  send({ url, method = 'get', data = {}, headers = {}, cancelToken = null } = {}) {
    if (method === 'get') {
      if (this.isCached(url)) {
        console.log('send::cached')
        return Promise.resolve(this.cached[url].response)
      }

      if (this.isPreloading(url)) {
        console.log('send::observeResponse')
        return this.observeResponse(url)
      }

      this.markAsPreloading(url)
    }

    return Axios({
      method,
      url,
      data: method === 'get' ? {} : data,
      params: method === 'get' ? data : {},
      cancelToken,
      headers: {
        ...headers,
        Accept: 'text/html, application/xhtml+xml',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Inertia': true,
      },
    })
      .then(response => ({ success: true, response: response }))
      .catch(error => {
        if (Axios.isCancel(error)) {
          return Promise.reject(error)
        } else if (this.isInertiaResponse(error.response)) {
          return { success: true, response: error.response }
        } else if (error.response) {
          return { success: false, response: error.response}
        } else {
          return Promise.reject(error)
        }
      })
      .then(result => {
        const response = result.success
          ? Promise.resolve(result.response)
          : Promise.reject(result.response)

        this.cached[url].callbacks.forEach(callback => callback(response))
        this.cached[url].callbacks = []

        return response
      })
  },
  visit({ url, method = 'get', data = {}, headers = {} } = {}) {
    if (this.cancelToken) {
      this.cancelToken.cancel()
    }

    this.cancelToken = Axios.CancelToken.source()

    return this.send({
      url,
      method,
      data,
      headers,
      cancelToken: this.cancelToken.token,
    }).then(response => {
      this.clearCached(url)
      
      if (this.isInertiaResponse(response)) {
        return response.data
      } else {
        modal.show(response.data)
      }
    })
  },
}
