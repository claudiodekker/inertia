import { vi } from "vitest";
import type { HttpRequestConfig, HttpResponse, Page } from "../../../src/types";
import { fakeBrowser, settled } from "../runtime";

export { page, settled } from "../runtime";

type Answer = Partial<Page> & Record<string, unknown>;

export interface Req {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export const exitShells = (app: {
  views(): { shell: { open: boolean; done(): void } }[];
}) =>
  app
    .views()
    .filter((view) => !view.shell.open)
    .forEach((view) => view.shell.done());

export const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));

  return { opened, open };
};

/** The runtime harness with the request headers visible and the component resolver and flash hook replaceable. */
export async function bench(
  initial: Answer,
  handle: (request: Req) => Answer | Promise<Answer>,
  options: {
    resolve?: (name: string) => unknown;
    onFlash?: (flash: Page["flash"]) => void;
  } = {},
) {
  vi.resetModules();
  fakeBrowser(`http://localhost${initial.url}`);
  Object.assign(window, {
    setTimeout,
    clearTimeout,
    innerHeight: 800,
    innerWidth: 800,
  });

  const core = await import("../../../src");
  const { HttpCancelledError } = await import("../../../src/httpErrors");
  const requests: Req[] = [];

  core.http.setClient({
    request: (config: HttpRequestConfig): Promise<HttpResponse> => {
      const url = new URL(config.url, "http://localhost");
      const request = {
        method: config.method,
        path: url.pathname + url.search,
        headers: (config.headers ?? {}) as Record<string, string>,
      };

      requests.push(request);

      return new Promise((resolve, reject) => {
        config.signal?.addEventListener("abort", () =>
          reject(new HttpCancelledError()),
        );
        Promise.resolve(handle(request)).then(
          (answer) =>
            resolve({
              status: 200,
              headers: { "x-inertia": "true" },
              data: JSON.stringify(answer),
            }),
          reject,
        );
      });
    },
  });

  core.router.init({
    initialPage: {
      flash: {},
      rescuedProps: [],
      rememberedState: {},
      ...initial,
    } as Page,
    resolveComponent: (name: string) =>
      options.resolve ? options.resolve(name) : { name },
    swapComponent: async () => {},
    ...(options.onFlash && { onFlash: options.onFlash }),
  } as never);

  await settled();

  const basePage = async () => (await import("../../../src/page")).page.get();

  return {
    core,
    router: core.router,
    requests,
    layers: () => core.layerSlot.info(),
    views: () => core.layerSlot.views(),
    basePage,
    written: () =>
      (window.history as unknown as { written: [string, string][] }).written,
    entry: () =>
      (
        window.history.state as {
          page: Page & { layers?: Record<string, unknown>[] };
        }
      ).page,
    modules: async () => ({
      page: (await import("../../../src/page")).page,
      history: (await import("../../../src/history")).history,
      eventHandler: (await import("../../../src/eventHandler")).eventHandler,
      prefetchedRequests: (await import("../../../src/prefetched"))
        .prefetchedRequests,
    }),
  };
}

export type Bench = Awaited<ReturnType<typeof bench>>;

export const byPath =
  (routes: Record<string, Answer | (() => Answer | Promise<Answer>)>) =>
  (request: Req): Answer | Promise<Answer> => {
    const route =
      routes[`${request.method} ${request.path}`] ?? routes[request.path];

    if (!route) {
      throw new Error(`No route for ${request.method} ${request.path}`);
    }

    return typeof route === "function" ? route() : route;
  };
