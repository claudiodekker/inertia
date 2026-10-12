import { vi } from "vitest";
import type { HttpRequestConfig, HttpResponse, Page } from "../../../src/types";
import { fakeBrowser, settled } from "../runtime";

export type Answer = Partial<Page> & Record<string, unknown>;

export const pageWith = (overrides: Answer = {}): Answer => ({
  component: "Users/Index",
  props: { users: [] },
  url: "/users",
  version: null,
  rescuedProps: [],
  flash: {},
  rememberedState: {},
  ...overrides,
});

export const layerAt = (
  url: string,
  component: string,
  base?: string,
): Answer =>
  pageWith({ component, url, layer: { key: component, base }, props: {} });

export const errorPage: HttpResponse = {
  status: 500,
  data: "<html>Server Error</html>",
  headers: {},
};

export const elsewhere: HttpResponse = {
  status: 409,
  data: "",
  headers: {
    "x-inertia-location": "http://localhost/elsewhere",
    "x-inertia-version": "v2",
  },
};

type Route =
  | Answer
  | HttpResponse
  | ((config: HttpRequestConfig) => Promise<Answer | HttpResponse>);

const isRaw = (route: unknown): route is HttpResponse =>
  typeof route === "object" &&
  route !== null &&
  "status" in route &&
  "headers" in route &&
  "data" in route;

export interface Swap {
  component: string;
  preserveState: boolean;
}

export async function world(options: {
  href: string;
  routes?: Record<string, Route | "hold">;
  component?: (name: string) => unknown;
}) {
  vi.resetModules();
  fakeBrowser(options.href);

  const events: string[] = [];
  const popstate: ((event: { state: unknown }) => void)[] = [];
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const writes: {
    mode: "push" | "replace";
    url: string;
    state: { page: Page & { layers?: Record<string, unknown>[] } };
  }[] = [];
  const history = window.history as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  const session = new Map<string, string>();

  Object.assign(window, {
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
    },
  });

  const originalAdd = window.addEventListener.bind(window);

  window.addEventListener = ((
    type: string,
    listener: (event: { state: unknown }) => void,
  ) => {
    if (type === "popstate") {
      popstate.push(listener);
    }

    originalAdd(type, listener as never);
  }) as never;

  for (const [method, mode] of [
    ["pushState", "push"],
    ["replaceState", "replace"],
  ] as const) {
    const original = history[method].bind(history);

    history[method] = (state: unknown, title: unknown, url: unknown) => {
      writes.push({
        mode,
        url: url as string,
        state: structuredClone(state) as never,
      });
      original(state, title, url);
    };
  }

  document.addEventListener = ((
    type: string,
    listener: (event: Event) => void,
  ) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  }) as never;
  document.dispatchEvent = ((event: Event) => {
    events.push(event.type);
    listeners.get(event.type)?.forEach((listener) => listener(event));

    return true;
  }) as never;

  const core = await import("../../../src");
  const { HttpCancelledError } = await import("../../../src/httpErrors");
  const { default: dialog } = await import("../../../src/dialog");
  const overlay = vi.spyOn(dialog, "show").mockImplementation(() => {});

  const requested: string[] = [];
  const headers = new Map<string, Record<string, string>>();
  const routes = new Map<string, Route | "hold">(
    Object.entries(options.routes ?? {}),
  );
  const held = new Map<
    string,
    {
      resolve: (response: HttpResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  const inertia = (answer: Answer): HttpResponse => ({
    status: 200,
    headers: { "x-inertia": "true" },
    data: JSON.stringify(answer),
  });

  core.http.setClient({
    request: (config: HttpRequestConfig): Promise<HttpResponse> => {
      const url = new URL(config.url, "http://localhost");
      const path = url.pathname;
      const route = routes.get(path);

      requested.push(path);
      headers.set(path, (config.headers ?? {}) as Record<string, string>);

      if (route === undefined) {
        throw new Error(`No route for ${config.method} ${path}`);
      }

      if (route === "hold") {
        return new Promise((resolve, reject) => {
          config.signal?.addEventListener("abort", () =>
            reject(new HttpCancelledError()),
          );
          held.set(path, { resolve, reject });
        });
      }

      if (typeof route === "function") {
        return route(config).then((answer) =>
          isRaw(answer) ? answer : inertia(answer),
        );
      }

      return Promise.resolve(isRaw(route) ? route : inertia(route));
    },
  });

  const swaps: Swap[] = [];
  const resolved: string[] = [];
  const Blank = { name: "Blank" };
  const resolve = core.layerSlot.wrapResolver(
    (name: string) => {
      resolved.push(name);

      return options.component ? options.component(name) : { name };
    },
    undefined,
    Blank as { name: string },
  );

  const initialise = (initialPage: Answer) =>
    core.router.init({
      initialPage: {
        flash: {},
        rescuedProps: [],
        rememberedState: {},
        ...initialPage,
      } as Page,
      resolveComponent: resolve as never,
      swapComponent: (async ({
        component,
        preserveState,
      }: {
        component: unknown;
        preserveState: boolean;
      }) =>
        swaps.push({
          component: (component as { name: string }).name,
          preserveState,
        })) as never,
    });

  return {
    core,
    router: core.router,
    requested,
    headers,
    swaps,
    resolved,
    events,
    writes,
    overlay,
    routes,
    held,
    session,
    errors: await import("../../../src/httpErrors"),
    begin: async (initialPage: Answer) => {
      initialise(initialPage);
      await settled();
    },
    boot: async (response: Answer, hash = "") => {
      const plan = core.layerSlot.planBoot(
        {
          flash: {},
          rescuedProps: [],
          rememberedState: {},
          ...response,
        } as Page,
        hash,
      );

      core.layerSlot.boot(
        plan,
        plan.seeds.map((seed) => ({ name: seed.page.component })),
      );
      initialise(plan.base);
      await settled();

      return plan;
    },
    base: async () => (await import("../../../src/page")).page.get(),
    entry: () =>
      (
        window.history.state as {
          page: Page & { layers?: Record<string, unknown>[] };
        }
      ).page,
    layers: () => core.layerSlot.info(),
    keys: () => core.layerSlot.info().map((layer) => layer.key),
    urls: () => core.layerSlot.info().map((layer) => layer.url),
    popstate: (state: unknown) =>
      popstate.forEach((listener) => listener({ state })),
    answer: async (path: string, answer: Answer | HttpResponse) => {
      held.get(path)!.resolve(isRaw(answer) ? answer : inertia(answer));
      await settled();
    },
    refuse: async (path: string, error: Error) => {
      held.get(path)!.reject(error);
      await settled();
    },
    exit: () =>
      core.layerSlot
        .views()
        .filter((view) => !view.shell.open)
        .forEach((view) => view.shell.done()),
    dismiss: async () => {
      const closed = core.router.close();

      await settled();
      core.layerSlot
        .views()
        .filter((view) => !view.shell.open)
        .forEach((view) => view.shell.done());
      await closed;
      await settled();
    },
    open: async (response: Answer, visit: Record<string, unknown> = {}) => {
      routes.set("/login", response);
      core.router.visit("/login", { method: "post", ...visit });
      await settled();
    },
  };
}
