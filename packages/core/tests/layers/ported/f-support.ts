import { vi } from "vitest";
import type { HttpRequestConfig, HttpResponse, Page } from "../../../src/types";
import { fakeBrowser, settled } from "../runtime";

export { page, settled } from "../runtime";

type Answer = Partial<Page> & Record<string, unknown>;

interface Options {
  navigation?: "navigate" | "reload" | "back_forward";
  entry?: unknown;
  boot?: boolean;
  /** Runs once the core is imported, before the document boots. */
  onCore?: (core: typeof import("../../../src")) => void;
}

const memoryStorage = () => {
  const items = new Map<string, string>();

  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
};

/**
 * runtime.ts with the window a few scenarios need: session storage, WebCrypto, the navigation type of the
 * document, a history entry the document was loaded onto, and the popstate listeners to call directly.
 */
export async function start(
  initial: Answer,
  routes: Record<string, Answer | (() => Promise<Answer>)>,
  { navigation = "navigate", entry, boot = false, onCore }: Options = {},
) {
  vi.resetModules();
  fakeBrowser(`http://localhost${initial.url}`);

  const popstate: ((event: { state: unknown }) => void)[] = [];
  const addEventListener = window.addEventListener;

  window.addEventListener = ((
    type: string,
    listener: (event: { state: unknown }) => void,
  ) => {
    if (type === "popstate") {
      popstate.push(listener);
    }

    (addEventListener as (...args: unknown[]) => void)(type, listener);
  }) as typeof window.addEventListener;
  Object.assign(window, {
    sessionStorage: memoryStorage(),
    crypto: globalThis.crypto,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    performance: { getEntriesByType: () => [{ type: navigation }] },
  });

  if (entry !== undefined) {
    window.history.state = { page: entry };
  }

  const core = await import("../../../src");
  onCore?.(core);

  const { HttpCancelledError } = await import("../../../src/httpErrors");
  const sent: string[] = [];

  core.http.setClient({
    request: (config: HttpRequestConfig): Promise<HttpResponse> => {
      const url = new URL(config.url, "http://localhost");
      const path = url.pathname + url.search;
      const route = routes[`${config.method} ${path}`] ?? routes[path];

      sent.push(`${config.method} ${path}`);

      if (!route) {
        throw new Error(`No route for ${config.method} ${path}`);
      }

      const answered = (answer: Answer): HttpResponse => ({
        status: 200,
        headers: { "x-inertia": "true" },
        data: JSON.stringify(answer),
      });

      if (typeof route !== "function") {
        return Promise.resolve(answered(route));
      }

      return new Promise((resolve, reject) => {
        config.signal?.addEventListener("abort", () =>
          reject(new HttpCancelledError()),
        );
        route().then((answer) => resolve(answered(answer)), reject);
      });
    },
  });

  const response = {
    flash: {},
    rescuedProps: [],
    rememberedState: {},
    ...initial,
  } as Page;
  let initialPage = response;

  if (boot) {
    const plan = core.layerSlot.planBoot(response, "");

    core.layerSlot.boot(plan, [{ name: response.component }]);
    initialPage = plan.base;
  }

  const swaps: { component: string; preserveState: boolean }[] = [];

  core.router.init({
    initialPage,
    resolveComponent: (name: string) => ({ name }),
    swapComponent: async ({ component, preserveState }) => {
      swaps.push({
        component: (component as { name: string }).name,
        preserveState,
      });
    },
  });

  await settled();

  const fired: CustomEvent[] = [];

  document.dispatchEvent = (event: Event) => {
    fired.push(event as CustomEvent);

    return true;
  };

  const modules = {
    history: (await import("../../../src/history")).history,
    currentPage: (await import("../../../src/page")).page,
    prefetchedRequests: (await import("../../../src/prefetched"))
      .prefetchedRequests,
    stack: (await import("../../../src/layers/stack")).stack,
    historySessionStorageKeys: (await import("../../../src/encryption"))
      .historySessionStorageKeys,
  };

  return {
    ...modules,
    router: core.router,
    interceptors: core.interceptors,
    Router: (await import("../../../src/router")).Router,
    layers: () => core.layerSlot.info(),
    views: () => core.layerSlot.views(),
    subscribe: core.layerSlot.subscribe,
    topPage: () => core.layerSlot.topPage(),
    basePage: () => modules.currentPage.get(),
    sent,
    swaps,
    fired,
    written: () =>
      (window.history as unknown as { written: [string, string][] }).written,
    entry: () =>
      (
        window.history.state as {
          page: Page & { layers?: Record<string, unknown>[] };
        }
      ).page,
    popstate: (state: unknown) =>
      popstate.forEach((listener) => listener({ state })),
  };
}

export type App = Awaited<ReturnType<typeof start>>;

export const seedKeys = (app: App) => {
  window.sessionStorage.setItem(app.historySessionStorageKeys.key, "[1,2,3]");
  window.sessionStorage.setItem(app.historySessionStorageKeys.iv, "[4,5,6]");
};

export const keysHeld = (app: App) =>
  window.sessionStorage.getItem(app.historySessionStorageKeys.key) !== null;

export const exitShells = (app: App) =>
  app
    .views()
    .filter((view) => !view.shell.open)
    .forEach((view) => view.shell.done());

export const baseGen = (app: App): number =>
  (app.stack as unknown as { state: { base: { gen: number } } }).state.base.gen;

export const requestsOf = (router: unknown): { origin: unknown }[] =>
  (router as { syncRequestStream: { requests: { origin: unknown }[] } })
    .syncRequestStream.requests;

export const cached = (app: App) =>
  (
    app.prefetchedRequests as unknown as {
      cached: { response: Promise<{ origin: unknown }> }[];
    }
  ).cached;
