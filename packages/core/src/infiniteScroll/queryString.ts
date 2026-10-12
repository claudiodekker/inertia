import { hrefToUrl, urlHasProtocol, urlToString } from '..'
import debounce from '../debounce'
import { getElementsInViewportFromCollection } from '../domUtils'
import { stack } from '../layers/stack'
import { InfiniteScrollScope } from '../types'
import Queue from './../queue'
import { getPageFromElement } from './elements'

// Shared queue among all instances to ensure URL updates are processed sequentially
const queue = new Queue<Promise<void>>()

// One url in the making per router: the page's, and one for each layer paginating beside it
const syncing = new Map<InfiniteScrollScope['router'], { initial: URL; payload: URL; absolute: boolean }>()

/**
 * As users scroll through infinite content, this system updates the URL to reflect
 * which page they're currently viewing. It uses a "most visible page" calculation
 * so that the URL reflects whichever page has the most visible items.
 */
export const useInfiniteScrollQueryString = (options: {
  scope: InfiniteScrollScope
  getPageName: () => string
  getItemsElement: () => HTMLElement
  shouldPreserveUrl: () => boolean
}) => {
  let enabled = true

  const queuePageUpdate = (page: string) => {
    queue
      .add(() => {
        return new Promise((resolve) => {
          if (!enabled) {
            syncing.delete(options.scope.router)
            return resolve()
          }

          if (stack.isLocal(options.scope.router)) {
            return resolve()
          }

          let sync = syncing.get(options.scope.router)

          if (!sync) {
            const currentPageUrl = options.scope.page.get().url
            sync = {
              initial: hrefToUrl(currentPageUrl),
              payload: hrefToUrl(currentPageUrl),
              absolute: urlHasProtocol(currentPageUrl),
            }
            syncing.set(options.scope.router, sync)
          }

          const pageName = options.getPageName()
          const searchParams = sync.payload.searchParams

          // Clean URLs: don't show ?page=1 in the URL, just remove the parameter entirely
          if (page === '1') {
            searchParams.delete(pageName)
          } else {
            searchParams.set(pageName, page)
          }

          setTimeout(() => resolve())
        })
      })
      .finally(() => {
        const sync = syncing.get(options.scope.router)

        if (enabled && sync && sync.initial.href !== sync.payload.href) {
          // Update URL without triggering a page reload or affecting scroll position
          options.scope.router.replace({
            url: urlToString(sync.payload, sync.absolute),
            preserveScroll: true,
            preserveState: true,
          })
        }

        syncing.delete(options.scope.router)
      })
  }

  // Debounced to avoid excessive URL updates during fast scrolling
  const onItemIntersected = debounce((itemElement: HTMLElement) => {
    const itemsElement = options.getItemsElement()

    if (!enabled || options.shouldPreserveUrl() || !itemElement || !itemsElement) {
      return
    }

    // Count how many items from each page are currently visible in the viewport
    const pageMap = new Map<string, number>()
    const elements = [...itemsElement.children] as HTMLElement[]

    getElementsInViewportFromCollection(elements, itemElement).forEach((element) => {
      const page = getPageFromElement(element) ?? '1'

      if (pageMap.has(page)) {
        pageMap.set(page, pageMap.get(page)! + 1)
      } else {
        pageMap.set(page, 1)
      }
    })

    // Find the page with the most visible items - this becomes the "current" page
    const sortedPages = Array.from(pageMap.entries()).sort((a, b) => b[1] - a[1])
    const mostVisiblePage = sortedPages[0]?.[0]

    if (mostVisiblePage !== undefined) {
      queuePageUpdate(mostVisiblePage)
    }
  }, 250)

  return {
    onItemIntersected,
    cancel: () => (enabled = false),
  }
}
