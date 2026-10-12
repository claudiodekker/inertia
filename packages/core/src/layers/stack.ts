import type { Page } from '../types'

export const stack = {
  baseLocation: (): URL | null => null,
  baseCommitting: (_page: Page, _replace: boolean, _visitId: string | undefined, _initial: boolean): void => {},
  baseSwapped: (): void => {},
  popstate: (data: Page): Page | null => data,
  restoreOnLoad: (data: Page): Page => data,
  scopeOf: (_el: Element): null => null,
}
