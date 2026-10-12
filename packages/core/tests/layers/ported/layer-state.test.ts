import { describe, expect, it, vi } from "vitest";
import {
  bench,
  byPath,
  exitShells,
  gate,
  page,
  settled,
  type Bench,
} from "./e-support";

const users = page("Users/Index", "/users", {
  props: { errors: {}, users: [] },
});
const edit = page("Users/Edit", "/users/5/edit", {
  layer: { key: "Users/Edit" },
  props: { errors: {}, user: { id: 5 } },
});
const teamsShow = page("Teams/Show", "/teams/9", {
  layer: { key: "Teams/Show" },
  props: { errors: {}, team: { id: 9 } },
});

const partialOf = (app: Bench) =>
  app.requests.filter(
    (request) => request.headers["X-Inertia-Partial-Data"] !== undefined,
  );

describe("a layer's deferred and rescued props", () => {
  it("loads the deferred props a layer response declared into the layer", async () => {
    let opens = 0;
    const app = await bench(users, (request) => {
      if (
        request.headers["X-Inertia-Partial-Data"] === undefined &&
        opens++ === 0
      ) {
        return {
          ...edit,
          deferredProps: { slow: ["stats"] },
          rescuedProps: ["stats"],
        };
      }

      return {
        ...edit,
        props: { errors: {}, user: { id: 5 }, stats: [1, 2, 3] },
        rescuedProps: [],
      };
    });

    app.router.visit("/users/5/edit");
    await settled();

    expect(app.requests.map((request) => request.path)).toEqual([
      "/users/5/edit",
      "/users/5/edit",
    ]);
    expect(app.requests[1].headers["X-Inertia-Partial-Component"]).toBe(
      "Users/Edit",
    );
    expect(app.requests[1].headers["X-Inertia-Partial-Data"]).toBe("stats");
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1, 2, 3],
    });
    expect(app.views()[0].page.rescuedProps).toEqual([]);
    expect((await app.basePage()).props).toEqual({ errors: {}, users: [] });
  });

  it("aims the deferred follow-up at a layer that preserved the url, not at the page", async () => {
    const app = await bench(users, (request) =>
      request.headers["X-Inertia-Partial-Data"]?.includes("stats")
        ? { ...edit, props: { errors: {}, user: { id: 5 }, stats: [1] } }
        : { ...edit, deferredProps: { slow: ["stats"] } },
    );

    app.router.visit("/users/5/edit", { preserveUrl: true });
    await settled();

    expect(app.entry().layers![0]).toMatchObject({
      component: "Users/Edit",
      preservesUrl: true,
    });
    expect(window.location.pathname).toBe("/users");
    expect(
      partialOf(app).map((request) => ({
        url: request.path,
        component: request.headers["X-Inertia-Partial-Component"],
      })),
    ).toEqual([{ url: "/users/5/edit", component: "Users/Edit" }]);
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1],
    });
    expect((await app.basePage()).props).toEqual({ errors: {}, users: [] });
  });

  it("does not re-fire the page's pending deferred props when a layer opens over it", async () => {
    const app = await bench(users, (request) => {
      if (request.headers["X-Inertia-Partial-Data"]?.includes("stats")) {
        return new Promise(() => {});
      }

      return request.path === "/users/5/edit"
        ? {
            ...edit,
            deferredProps: { slow: ["stats"] },
            rescuedProps: ["stats"],
          }
        : { ...users, deferredProps: { slow: ["stats"] } };
    });

    app.router.visit("/users");
    await settled();
    expect(partialOf(app).map((request) => request.path)).toEqual(["/users"]);

    app.router.visit("/users/5/edit");
    await settled();

    expect(partialOf(app).map((request) => request.path)).toEqual([
      "/users",
      "/users/5/edit",
    ]);
  });

  it("rescued props travel with the layer and resolve into its props", async () => {
    const follow = gate();
    const app = await bench(users, (request) =>
      request.headers["X-Inertia-Partial-Data"] === undefined
        ? {
            ...edit,
            deferredProps: { slow: ["stats"] },
            rescuedProps: ["stats", "notes"],
          }
        : follow.opened.then(() => ({
            ...edit,
            props: { errors: {}, user: { id: 5 }, stats: [1, 2, 3] },
            rescuedProps: [],
          })),
    );

    app.router.visit("/users/5/edit");
    await settled();

    expect(app.views()[0].page.rescuedProps).toEqual(["stats", "notes"]);
    expect(app.entry().layers![0].rescuedProps).toEqual(["stats", "notes"]);
    expect(partialOf(app)).toHaveLength(1);

    follow.open();
    await settled();

    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1, 2, 3],
    });
    expect(app.views()[0].page.rescuedProps).toEqual(["notes"]);
    expect((await app.basePage()).props).toEqual({ errors: {}, users: [] });
  });

  it("re-asks for the deferred props a restored entry's layer is still missing", async () => {
    const app = await bench(
      {
        ...users,
        props: { errors: {}, users: [], sidebar: ["loaded"] },
        deferredProps: { slow: ["sidebar"] },
      },
      (request) =>
        request.headers["X-Inertia-Partial-Data"] === undefined
          ? { ...edit, deferredProps: { slow: ["stats"] } }
          : new Promise(() => {}),
    );
    const initial = app.requests.length;

    app.router.visit("/users/5/edit");
    await settled();
    window.history.back();
    await settled();
    exitShells(app);
    await settled();
    expect(app.layers()).toEqual([]);

    window.history.go(1);
    await settled();

    expect(app.layers().map((layer) => layer.component)).toEqual([
      "Users/Edit",
    ]);
    expect(
      app.requests
        .slice(initial)
        .map((request) => [
          request.headers["X-Inertia-Partial-Data"],
          request.headers["X-Inertia-Partial-Component"],
        ]),
    ).toEqual([
      [undefined, undefined],
      ["stats", "Users/Edit"],
      ["stats", "Users/Edit"],
    ]);
  });
});

describe("the deferred props a page write was carrying", () => {
  const full = (overrides: Record<string, unknown> = {}) => ({
    ...users,
    flash: {},
    rescuedProps: [],
    rememberedState: {},
    ...overrides,
  });

  const listening = async (handle: Parameters<typeof bench>[1]) => {
    const app = await bench(users, handle);
    const { page: base, eventHandler } = await app.modules();
    const groups: unknown[] = [];
    const stop = eventHandler.on(
      "loadDeferredProps",
      (deferredProps: unknown) => groups.push(deferredProps),
    );

    return { app, base, groups, stop };
  };

  it("are announced by the write that lands when a newer one supersedes it", async () => {
    const { base, groups, stop } = await listening(() => new Promise(() => {}));

    base.set(full({ deferredProps: { default: ["stats"] } }) as never);
    await base.set(
      full({ props: { errors: {}, users: [], stats: [] } }) as never,
    );

    stop();

    expect(groups).toEqual([{ default: ["stats"] }]);
  });

  it("are dropped when the write that lands is on another page entirely", async () => {
    const { base, groups, stop } = await listening(() => new Promise(() => {}));

    base.set(full({ deferredProps: { default: ["stats"] } }) as never);
    await base.set(full({ component: "Teams/Index", url: "/teams" }) as never);

    stop();

    expect(groups).toEqual([]);
  });

  it("are announced again by a cached prefetch replayed onto the page a second time", async () => {
    const deferred = page("Users/Show", "/users/5", {
      deferredProps: { default: ["stats"] },
    });
    let fetched = 0;
    const { app, groups, stop } = await listening((request) => {
      if (request.headers["X-Inertia-Partial-Data"] !== undefined) {
        return new Promise(() => {});
      }

      fetched++;

      return request.path === "/users/5" ? deferred : users;
    });

    app.router.prefetch("/users/5", {}, { cacheFor: "30s" });
    await vi.waitFor(() => expect(fetched).toBe(1));

    const visit = (url: string) =>
      new Promise<void>((resolve) =>
        app.router.visit(url, {
          onSuccess: () => resolve(),
          onError: () => resolve(),
        }),
      );

    await visit("/users/5");
    await visit("/users");
    await visit("/users/5");

    stop();
    (await app.modules()).prefetchedRequests.removeAll();

    expect(groups).toEqual([{ default: ["stats"] }, { default: ["stats"] }]);
  });

  it("are left alone by a write that carries them along for another tier", async () => {
    const { app, base, groups, stop } = await listening((request) =>
      request.headers["X-Inertia-Partial-Data"] !== undefined
        ? new Promise(() => {})
        : edit,
    );

    await base.set(full({ deferredProps: { default: ["stats"] } }) as never);
    app.router.visit("/users/5/edit");
    await settled();

    stop();

    expect(app.layers().map((layer) => layer.component)).toEqual([
      "Users/Edit",
    ]);
    expect(groups).toEqual([{ default: ["stats"] }]);
  });
});

describe("a layer response's errors", () => {
  const rejected = {
    ...edit,
    props: { errors: { note: "The note is required." }, user: { id: 5 } },
  };

  const observing = () => {
    const seen = { events: [] as string[], errors: undefined as unknown };

    return {
      seen,
      callbacks: {
        onError: (errors: unknown) => {
          seen.errors = errors;
          seen.events.push("error");
        },
        onSuccess: () => seen.events.push("success"),
      },
    };
  };

  it("announces a layer response's errors through the layer's bag, not the page's", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": rejected }));
    const { seen, callbacks } = observing();

    app.router.visit("/users/5/edit", callbacks);
    await settled();

    expect(seen.events).toEqual(["error"]);
    expect(seen.errors).toEqual({ note: "The note is required." });
    expect(app.views()[0].page.props.errors).toEqual({
      note: "The note is required.",
    });
    expect((await app.basePage()).props.errors).toEqual({});
  });

  it("announces the errors a rewrite of an open layer brings through that layer", async () => {
    let answers = [edit, rejected];
    const app = await bench(users, () => answers.shift()!);

    app.router.visit("/users/5/edit");
    await settled();

    const [open] = app.layers();
    const { seen, callbacks } = observing();

    app.router.visit("/users", { method: "post", ...callbacks });
    await settled();

    expect(seen.errors).toEqual({ note: "The note is required." });
    expect(seen.events).toEqual(["error"]);
    expect(app.layers()).toEqual([open]);
    expect(app.views()[0].page.props.errors).toEqual({
      note: "The note is required.",
    });
  });

  it("announces a rewrite of a non-top layer through that layer, not the top", async () => {
    const bare = { ...teamsShow, props: { team: { id: 9 } } };
    const answers = [edit, bare, rejected];
    const app = await bench(users, () => answers.shift()!);

    app.router.visit("/users/5/edit");
    await settled();
    app.router.visit("/teams/9");
    await settled();

    const [beneath] = app.layers();
    const top = app.views()[1].page;
    const { seen, callbacks } = observing();

    expect(app.layers()).toHaveLength(2);

    app.router.visit("/users", { method: "post", ...callbacks });
    await settled();
    exitShells(app);
    await settled();

    expect(seen.errors).toEqual({ note: "The note is required." });
    expect(seen.events).toEqual(["error"]);
    expect(app.layers()).toEqual([beneath]);
    expect(app.views()[0].page.props.errors).toEqual({
      note: "The note is required.",
    });
    expect(top.props).not.toHaveProperty("errors");
  });

  it("a page response's errors announce exactly as they always have", async () => {
    const app = await bench(
      users,
      byPath({
        "/users": {
          ...users,
          props: { errors: { name: "The name is required." }, users: [] },
        },
      }),
    );
    const { seen, callbacks } = observing();

    app.router.visit("/users", callbacks);
    await settled();

    expect(seen.events).toEqual(["error"]);
    expect(seen.errors).toEqual({ name: "The name is required." });
  });
});

describe("a layer response's flash", () => {
  const saved = { ...edit, flash: { message: "Saved." } };

  it("announces a layer response's flash through the layer, whose own page carries it", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": saved }));
    const announced: unknown[] = [];

    app.router.visit("/users/5/edit", {
      onFlash: (flash) => announced.push(flash),
    });
    await settled();

    expect(announced).toEqual([{ message: "Saved." }]);
    expect(app.views()[0].page.flash).toEqual({ message: "Saved." });
    expect((await app.basePage()).flash).toEqual({});
  });

  it("strips a layer's flash from the history entry it leaves", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": saved }));

    app.router.visit("/users/5/edit");
    await settled();

    expect(app.written().at(-1)).toEqual(["push", "/users/5/edit"]);
    expect(app.entry().layers![0].flash).toBeUndefined();
    expect(app.entry().flash).toEqual({});
    expect(JSON.stringify(window.history.state)).not.toContain("Saved.");
  });

  it("a layer's live flash survives a history merge that does not touch it", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": saved }));

    app.router.visit("/users/5/edit");
    await settled();
    app.router.layerHandle()!.router.remember("typed", "note");

    expect(app.views()[0].page.flash).toEqual({ message: "Saved." });

    await settled();

    expect(app.views()[0].page.flash).toEqual({ message: "Saved." });
    expect(app.entry().layers![0].rememberedState).toEqual({ note: "typed" });
  });

  it("router.flash with no layer open fires onFlash with the page's flash", async () => {
    const baseFlashes: unknown[] = [];
    const app = await bench(users, byPath({}), {
      onFlash: (flash) => baseFlashes.push(flash),
    });

    app.router.flash("message", "Saved.");

    expect((await app.basePage()).flash).toEqual({ message: "Saved." });
    expect(baseFlashes).toEqual([{ message: "Saved." }]);
  });

  it("a flash written to a layer never reaches the page's own flash", async () => {
    const baseFlashes: unknown[] = [];
    const app = await bench(users, byPath({ "/users/5/edit": edit }), {
      onFlash: (flash) => baseFlashes.push(flash),
    });

    app.router.visit("/users/5/edit");
    await settled();
    app.router.layerHandle()!.router.flash("message", "Saved.");

    expect(app.views()[0].page.flash).toEqual({ message: "Saved." });
    expect((await app.basePage()).flash).toEqual({});
    expect(baseFlashes).toEqual([]);
  });

  it("re-renders the layer a flash was written to, since no callback carries it", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": edit }));

    app.router.visit("/users/5/edit");
    await settled();

    const painted: unknown[] = [];

    app.core.layerSlot.subscribe(() => {
      painted.push(app.views().map((view) => view.page.flash));
    });
    app.router.layerHandle()!.router.flash("message", "Saved.");
    await settled();

    expect(painted).toEqual([[{ message: "Saved." }]]);
  });

  it("router.flash from inside a layer targets the layer's flash", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": edit }));

    app.router.visit("/users/5/edit");
    await settled();

    const [open] = app.layers();

    app.router.layerHandle(open.id)!.router.flash("message", "Saved.");

    expect(app.views()[0].page.flash).toEqual({ message: "Saved." });
    expect((await app.basePage()).flash).toEqual({});
  });

  it("a layer's deferred response keeps the flash the layer already had", async () => {
    const follow = gate();
    const app = await bench(users, (request) =>
      request.headers["X-Inertia-Partial-Data"] === undefined
        ? {
            ...saved,
            deferredProps: { slow: ["stats"] },
            rescuedProps: ["stats"],
          }
        : follow.opened.then(() => ({
            ...edit,
            props: { errors: {}, user: { id: 5 }, stats: [1, 2, 3] },
            rescuedProps: [],
          })),
    );

    app.router.visit("/users/5/edit");
    await settled();
    follow.open();
    await settled();

    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      stats: [1, 2, 3],
    });
    expect(app.views()[0].page.flash).toEqual({ message: "Saved." });
  });
});

describe("remembered state per layer", () => {
  const opened = async (
    options: Parameters<Bench["router"]["visit"]>[1] = {},
  ) => {
    const app = await bench(
      users,
      byPath({ "/users/5/edit": edit, "/users": users }),
    );

    app.router.visit("/users/5/edit", options);
    await settled();

    return { app, layer: app.router.layerHandle()! };
  };

  it("namespaces a layer's remember/restore under its id, leaving the page's bag alone", async () => {
    const { app, layer } = await opened();

    layer.router.remember("typed", "note");
    await settled();

    expect(layer.router.restore("note")).toBe("typed");
    expect(app.router.restore("note")).toBeUndefined();
    expect(app.entry().layers![0].rememberedState).toEqual({ note: "typed" });
    expect(app.entry().rememberedState).toEqual({});
    expect((await app.basePage()).rememberedState).toEqual({});
  });

  it("a remember/restore with no layer open keeps the top-level bag it always used", async () => {
    const app = await bench(users, byPath({}));

    app.router.remember("typed", "note");

    expect(app.router.restore("note")).toBe("typed");
    expect((await app.basePage()).rememberedState).toEqual({ note: "typed" });
  });

  it("drops a closed layer's bag once its removal has settled", async () => {
    const { app, layer } = await opened({ preserveUrl: true });
    const id = layer.id;

    layer.router.remember("typed", "note");
    expect(layer.router.restore("note")).toBe("typed");

    const closing = layer.close();

    exitShells(app);
    await closing;
    await settled();

    expect(app.router.layerHandle(id)).toBeUndefined();
    expect(app.layers()).toEqual([]);
    expect((await app.basePage()).rememberedState).toEqual({});
    expect(app.router.restore("note")).toBeUndefined();
    expect(app.entry()).not.toHaveProperty("layers");
    expect(JSON.stringify(window.history.state)).not.toContain("typed");
  });

  it("holds a remember raised mid-unwind until the browser has answered the step back", async () => {
    const { app, layer } = await opened({ preserveUrl: true });
    const log: {
      kind: "go" | "replace" | "push" | "answered";
      state?: { page: { layers?: unknown[] } };
    }[] = [];
    const { go, replaceState, pushState } = window.history;

    window.history.go = (delta: number) => {
      log.push({ kind: "go" });
      go.call(window.history, delta);
    };
    window.history.replaceState = (
      state: unknown,
      title: string,
      url: string,
    ) => {
      log.push({ kind: "replace", state: state as never });
      replaceState.call(window.history, state, title, url);
    };
    window.history.pushState = (state: unknown, title: string, url: string) => {
      log.push({ kind: "push", state: state as never });
      pushState.call(window.history, state, title, url);
    };
    window.addEventListener("popstate", () => log.push({ kind: "answered" }));

    const closing = layer.close();

    exitShells(app);
    await vi.waitFor(() =>
      expect(log.some((entry) => entry.kind === "go")).toBe(true),
    );
    app.router.remember("during", "note");
    await closing;
    await settled();

    const afterStepBack = log.slice(
      log.findIndex((entry) => entry.kind === "go"),
    );

    expect(log.filter((entry) => entry.kind === "answered")).toHaveLength(1);
    expect(
      afterStepBack.flatMap((entry) => entry.state?.page.layers ?? []),
    ).toEqual([]);
    expect(app.router.restore("note")).toBe("during");
    expect(app.layers()).toEqual([]);
    expect(app.entry()).not.toHaveProperty("layers");
    expect(app.entry().rememberedState).toEqual({ note: "during" });
  });

  it("a restored page keeps the layer's bag, so reopening it finds the state", async () => {
    const { app, layer } = await opened();
    const id = layer.id;

    layer.router.remember("typed", "note");
    await settled();
    window.history.back();
    await settled();
    exitShells(app);
    await settled();
    expect(app.layers()).toEqual([]);

    window.history.go(1);
    await settled();

    expect(app.layers().map((open) => open.id)).toEqual([id]);
    expect(app.router.layerHandle(id)!.router.restore("note")).toBe("typed");
    expect(app.router.restore("note")).toBeUndefined();
  });
});

describe("once props per layer", () => {
  const baseOnce = page("Users/Index", "/users", {
    props: { errors: {}, baseProp: "base value" },
    onceProps: { baseKey: { prop: "baseProp" } },
  });
  const layerOnce = {
    ...edit,
    onceProps: { layerKey: { prop: "layerProp" } },
    props: { errors: {}, user: { id: 5 }, layerProp: "layer value" },
  };
  const cached = (app: Awaited<ReturnType<Bench["modules"]>>) =>
    (
      app.prefetchedRequests as unknown as {
        cached: { response: Promise<{ getPageResponse(): Promise<any> }> }[];
      }
    ).cached;
  const except = (request: { headers: Record<string, string> }) =>
    request.headers["X-Inertia-Except-Once-Props"];

  it("names no once keys at all on the visit that opens a layer", async () => {
    const app = await bench(baseOnce, byPath({ "/users/5/edit": edit }));

    app.router.layer("/users/5/edit");
    await settled();

    expect(app.layers().map((layer) => layer.component)).toEqual([
      "Users/Edit",
    ]);
    expect(app.requests.map(except)).toEqual(["baseKey"]);
  });

  it("a layer-targeted partial names the layer's once keys in the except header", async () => {
    const app = await bench(baseOnce, byPath({ "/users/5/edit": layerOnce }));

    app.router.visit("/users/5/edit");
    await settled();
    app.router.layerHandle()!.router.reload({ only: ["user"] });
    await settled();

    expect(app.requests.map(except)).toEqual(["baseKey", "layerKey"]);
  });

  it("a layer response's once props back-fill into the layer, never with the page's value", async () => {
    const answers = [
      layerOnce,
      {
        ...edit,
        onceProps: { layerKey: { prop: "layerProp" } },
        props: { errors: {}, user: { id: 9 } },
      },
    ];
    const app = await bench(baseOnce, () => answers.shift()!);

    app.router.visit("/users/5/edit");
    await settled();
    app.router.visit("/users/5/edit");
    await settled();

    expect(app.layers()).toHaveLength(1);
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 9 },
      layerProp: "layer value",
    });
    expect(app.views()[0].page.props).not.toHaveProperty("baseProp");
  });

  it("re-syncs a cached prefetch when the once props on screen are only a layer's", async () => {
    const live = {
      ...edit,
      onceProps: { token: { prop: "token" } },
      props: { errors: {}, user: { id: 5 }, token: "live" },
    };
    const app = await bench(users, (request) =>
      request.path === "/users/5/notes"
        ? {
            ...edit,
            url: "/users/5/notes",
            onceProps: { token: { prop: "token" } },
          }
        : live,
    );
    const modules = await app.modules();

    app.router.prefetch("/users/5/notes", {}, { cacheFor: "30s" });
    await vi.waitFor(() => expect(cached(modules)).toHaveLength(1));

    app.router.visit("/users/5/edit");
    await settled();
    expect(app.requests.map((request) => request.path)).toEqual([
      "/users/5/notes",
      "/users/5/edit",
    ]);

    app.router.layerHandle()!.router.visit("/users/5/notes");
    await settled();

    expect(app.requests.map((request) => request.path)).toEqual([
      "/users/5/notes",
      "/users/5/edit",
    ]);
    expect(app.layers()).toEqual([
      expect.objectContaining({
        component: "Users/Edit",
        url: "/users/5/notes",
      }),
    ]);
    expect(app.views()[0].page.props).toEqual({
      errors: {},
      user: { id: 5 },
      token: "live",
    });
    modules.prefetchedRequests.removeAll();
  });

  it("flushes the cached prefetch of the layer a fresh response landed on", async () => {
    const app = await bench(users, (request) =>
      request.method === "post"
        ? { ...edit, props: { errors: {}, user: { id: 9 } } }
        : edit,
    );
    const modules = await app.modules();

    app.router.visit("/users/5/edit", { preserveUrl: true });
    await settled();
    app.router.prefetch("/users/5/edit", {}, { cacheFor: "30s" });
    await vi.waitFor(() => expect(cached(modules)).toHaveLength(1));

    app.router.layerHandle()!.router.visit("/users/5/edit", { method: "post" });
    await settled();

    expect(cached(modules)).toHaveLength(0);
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 9 } });
  });
});

describe("an infinite scroll's url sync", () => {
  const item = (pageNumber: string): HTMLElement =>
    ({
      dataset: { infiniteScrollPage: pageNumber },
      offsetParent: {},
      getBoundingClientRect: () => ({ top: 0, bottom: 10, left: 0, right: 10 }),
    }) as unknown as HTMLElement;

  const scene = async () => {
    const app = await bench(users, byPath({ "/users/5/edit": edit }));

    app.router.visit("/users/5/edit");
    await settled();

    const layer = app.router.layerHandle()!;
    const { page: base } = await app.modules();
    const { useInfiniteScrollQueryString } =
      await import("../../../src/infiniteScroll/queryString");
    const replaced: { router: string; params: unknown }[] = [];

    vi.spyOn(app.router, "replace").mockImplementation((params) => {
      replaced.push({ router: "page", params });
    });
    vi.spyOn(layer.router, "replace").mockImplementation((params) => {
      replaced.push({ router: "layer", params });
    });

    const items = [item("2"), item("2")];
    const scrollIn = (target: "page" | "layer") =>
      useInfiniteScrollQueryString({
        scope:
          target === "layer"
            ? { router: layer.router, page: { get: () => app.views()[0].page } }
            : { router: app.router, page: { get: () => base.get() } },
        getPageName: () => "page",
        getItemsElement: () => ({ children: items }) as unknown as HTMLElement,
        shouldPreserveUrl: () => false,
      });

    return { app, replaced, items, scrollIn };
  };

  it("writes the page number onto the layer's own url, and aims the visit at the layer", async () => {
    const { replaced, items, scrollIn } = await scene();

    scrollIn("layer").onItemIntersected(items[1]);
    await vi.waitFor(() => expect(replaced).toHaveLength(1));

    expect(replaced).toEqual([
      {
        router: "layer",
        params: {
          url: "/users/5/edit?page=2",
          preserveScroll: true,
          preserveState: true,
        },
      },
    ]);
  });

  it("writes the page number onto the page's own url when the scroll is not in a layer", async () => {
    const { replaced, items, scrollIn } = await scene();

    scrollIn("page").onItemIntersected(items[1]);
    await vi.waitFor(() => expect(replaced).toHaveLength(1));

    expect(replaced).toEqual([
      {
        router: "page",
        params: {
          url: "/users?page=2",
          preserveScroll: true,
          preserveState: true,
        },
      },
    ]);
  });
});
