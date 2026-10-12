import { describe, expect, it, vi } from "vitest";
import {
  exitShells,
  held,
  page,
  raw,
  scenario,
  settled,
  type App,
  type Route,
} from "./a-support";

const index = (extra: Record<string, unknown> = {}) =>
  page("Users/Index", "/users", { props: { users: [], errors: {} }, ...extra });

const edit = (extra: Record<string, unknown> = {}) =>
  page("Users/Edit", "/users/5/edit", {
    layer: { key: "Users/Edit" },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  });

const open = async (
  initial: Record<string, unknown>,
  routes: Record<string, Route>,
  url = "/users/5/edit",
) => {
  const app = await scenario(initial, routes);

  app.router.visit(url);
  await settled();

  return app;
};

const scopeOf = (app: App, index = 0) =>
  app.router.layerHandle(app.layers()[index].id)!;

describe("per-layer optimistic updates", () => {
  const base = () => index({ props: { users: [], todos: [10], errors: {} } });
  const layer = (todos: number[]) =>
    edit({ props: { user: { id: 5 }, todos, errors: {} } });

  it("passes the layer props to a layer-targeted optimistic callback and writes the layer", async () => {
    const app = await open(base(), { "/users/5/edit": layer([1]) });
    const received: unknown[] = [];

    const pending = held();
    app.core.http.setClient({
      request: () =>
        pending
          .answer()
          .then((answer) => ({
            status: 200,
            headers: { "x-inertia": "true" },
            data: JSON.stringify(answer),
          })),
    });
    scopeOf(app)
      .router.optimistic((props) => {
        received.push(props.todos);
        return { todos: [...(props.todos as number[]), 9] };
      })
      .visit("/users/5/edit");
    await settled();

    expect(received).toEqual([[1]]);
    expect(app.views()[0].page.props.todos).toEqual([1, 9]);

    pending.release(layer([2]));
    await settled();

    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      todos: [2],
      errors: {},
    });
    expect((await app.basePage()).props).toEqual({
      users: [],
      todos: [10],
      errors: {},
    });
  });

  it("rolls a failed layer optimistic back into the layer, never the base", async () => {
    const app = await open(base(), { "/users/5/edit": layer([1]) });
    const pending = held();

    app.core.http.setClient({
      request: () =>
        pending
          .answer()
          .then(() => ({ status: 500, data: "boom", headers: {} })),
    });
    scopeOf(app)
      .router.optimistic((props) => ({
        todos: [...(props.todos as number[]), 9],
      }))
      .visit("/users/5/edit", {
        onHttpException: () => false,
        onError: () => {},
        onSuccess: () => {},
      });
    await settled();

    expect(app.views()[0].page.props.todos).toEqual([1, 9]);
    expect((await app.basePage()).props.todos).toEqual([10]);

    pending.release({});
    await settled();

    expect(app.views()[0].page.props.todos).toEqual([1]);
    expect((await app.basePage()).props.todos).toEqual([10]);
  });

  it("never injects a pending base optimistic into a landing layer response", async () => {
    const app = await open(base(), { "/users/5/edit": layer([1]) });
    const pending = held();

    app.core.http.setClient({
      request: async (config) => {
        if (config.url.includes("/users/5/edit")) {
          return {
            status: 200,
            data: JSON.stringify(layer([2])),
            headers: { "x-inertia": "true" },
          };
        }

        await pending.answer();

        return {
          status: 200,
          data: JSON.stringify(
            index({ props: { users: [], todos: [10, 9], errors: {} } }),
          ),
          headers: { "x-inertia": "true" },
        };
      },
    });

    app.router
      .optimistic((props) => ({ todos: [...(props.todos as number[]), 9] }))
      .reload();
    await settled();
    expect((await app.basePage()).props.todos).toEqual([10, 9]);

    scopeOf(app).router.visit("/users/5/edit", { only: ["todos"] });
    await settled();

    expect(app.views()[0].page.props.todos).toEqual([2]);
    expect((await app.basePage()).props.todos).toEqual([10, 9]);

    pending.release({});
  });

  it("drops a closed layer optimistic state instead of rolling it into the base", async () => {
    const app = await scenario(base(), {
      "/users/5/edit": edit({
        layer: { key: "Users/Edit", base: "/users" },
        props: { user: { id: 5 }, todos: [1], errors: {} },
      }),
      "/users": base(),
    });
    const handle = app.router.layer("/users/5/edit");

    await settled();

    const pending = held();
    app.core.http.setClient({
      request: (config) =>
        config.url.endsWith("/users")
          ? Promise.resolve({
              status: 200,
              data: JSON.stringify(base()),
              headers: { "x-inertia": "true" },
            })
          : pending
              .answer()
              .then(() => ({
                status: 200,
                data: JSON.stringify(edit()),
                headers: { "x-inertia": "true" },
              })),
    });
    scopeOf(app)
      .router.optimistic((props) => ({
        todos: [...(props.todos as number[]), 9],
      }))
      .visit("/users/5/edit", { onError: () => {}, onSuccess: () => {} });
    await settled();

    expect(app.views()[0].page.props.todos).toEqual([1, 9]);

    const closing = handle.close();
    exitShells(app);
    await closing;
    await settled();

    expect(app.layers()).toEqual([]);
    expect((await app.basePage()).props).toEqual({
      users: [],
      todos: [10],
      errors: {},
    });

    pending.release({});
    await settled();

    expect((await app.basePage()).props).toEqual({
      users: [],
      todos: [10],
      errors: {},
    });
  });
});

const inertia = (answer: Record<string, unknown>) => ({
  status: 200,
  data: JSON.stringify(answer),
  headers: { "x-inertia": "true" },
});

describe("a reload or partial issued from inside a layer", () => {
  it("re-asks for the layer's own url when the reload carries the layer's id", async () => {
    const app = await open(index(), { "/users/5/edit": edit() });

    scopeOf(app).router.reload({ only: ["user"] });
    await settled();

    expect(app.sent()).toEqual(["get /users/5/edit", "get /users/5/edit"]);
  });

  it("discards a reload the layer moved on from while it was in flight", async () => {
    const stale = held();
    let calls = 0;
    const app = await open(index(), {
      "/users/5/edit": () =>
        ++calls === 1 ? Promise.resolve(edit()) : stale.answer(),
      "/users/6/edit": edit({
        url: "/users/6/edit",
        props: { user: { id: 6 }, errors: {} },
      }),
    });

    scopeOf(app).router.reload();
    await settled();

    app.router.visit("/users/6/edit");
    await settled();

    stale.release(edit({ props: { user: { id: 5 }, errors: {} } }));
    await settled();

    expect(app.layers().map((layer) => layer.url)).toEqual(["/users/6/edit"]);
    expect(app.views()[0].page.props.user).toEqual({ id: 6 });
  });

  it("keeps a reload of a layer that stayed where it was while it was in flight", async () => {
    const pending = held();
    let calls = 0;
    const app = await open(index(), {
      "/users/5/edit": () =>
        ++calls === 1 ? Promise.resolve(edit()) : pending.answer(),
    });

    scopeOf(app).router.reload();
    await settled();

    pending.release(edit({ props: { user: { id: 5, seen: 1 }, errors: {} } }));
    await settled();

    expect(app.views()[0].page.props.user).toEqual({ id: 5, seen: 1 });
  });

  it("keeps the identity of the props a response left untouched, reading them off the layer", async () => {
    const app = await open(index(), { "/users/5/edit": edit() });
    const untouched = app.views()[0].page.props.user;

    app.router.visit("/users/5/edit");
    await settled();

    expect(app.views()[0].page.props.user).toBe(untouched);
  });

  it("keeps the identity of the props a base response left untouched", async () => {
    const app = await scenario(
      index({ props: { users: [{ id: 1 }], team: { id: 7 }, errors: {} } }),
      {
        "/users": index({
          props: { users: [{ id: 2 }], team: { id: 7 }, errors: {} },
        }),
      },
    );
    const untouched = (await app.basePage()).props.team;

    app.router.visit("/users");
    await settled();

    expect((await app.basePage()).props.team).toBe(untouched);
    expect((await app.basePage()).props.users).toEqual([{ id: 2 }]);
  });

  it("never takes the identity of a base prop that happens to equal the layer prop", async () => {
    const app = await scenario(
      page("Users/Edit", "/users", { props: { user: { id: 5 }, errors: {} } }),
      {
        "/users/5/edit": edit(),
      },
    );

    app.router.visit("/users/5/edit");
    await settled();

    expect(app.views()[0].page.props.user).not.toBe(
      (await app.basePage()).props.user,
    );
    expect(app.views()[0].page.props.user).toEqual({ id: 5 });
  });

  it("a bare reload re-asks for the base beneath the stack, not the address", async () => {
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "/users": index({ props: { users: [{ id: 9 }], errors: {} } }),
    });
    const [layer] = app.layers();

    expect(window.location.pathname).toBe("/users/5/edit");

    app.router.reload();
    await settled();

    expect(app.sent().at(-1)).toBe("get /users");
    expect((await app.basePage()).props.users).toEqual([{ id: 9 }]);
    expect(app.layers()).toEqual([layer]);
  });

  it("names the layer in X-Inertia-Partial-Component when the reload carries the layer id", async () => {
    const app = await open(index(), { "/users/5/edit": edit() });

    scopeOf(app).router.reload({ only: ["user"] });
    await settled();

    expect(app.requests.at(-1)!.headers["X-Inertia-Partial-Component"]).toBe(
      "Users/Edit",
    );
  });

  it("strips the layer target from the request a 409 redirect re-issues", async () => {
    const app = await open(index(), { "/users/5/edit": edit() });
    const requested: string[] = [];
    const components: (string | undefined)[] = [];

    app.core.http.setClient({
      request: async ({ url, headers }) => {
        requested.push(new URL(url).pathname);
        components.push((headers ?? {})["X-Inertia-Partial-Component"]);

        return requested.length === 1
          ? {
              status: 409,
              data: "",
              headers: {
                "x-inertia-location": "http://localhost/users",
                "x-inertia-redirect": "http://localhost/users",
              },
            }
          : inertia(index({ props: { users: [{ id: 9 }], errors: {} } }));
      },
    });

    const [layer] = app.layers();

    scopeOf(app).router.reload({ only: ["users"] });
    await settled();

    expect(requested).toEqual(["/users/5/edit", "/users"]);
    expect(components[1]).toBe("Users/Edit");
    expect(app.layers()).toEqual([layer]);
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, errors: {} });
  });
});

describe("requests aimed at a layer and the page", () => {
  it("a visit to the page does not cancel an in-flight request aimed at a layer", async () => {
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "/dashboard": page("Dashboard", "/dashboard"),
    });
    let cancelled = false;
    const never = held();
    const answer = app.core.http.getClient();

    app.core.http.setClient({
      request: (config) =>
        config.url.endsWith("/users/5/edit")
          ? never.answer().then(inertia)
          : answer.request(config),
    });
    scopeOf(app).router.visit("/users/5/edit", {
      only: ["user"],
      async: true,
      onCancel: () => (cancelled = true),
    });
    await settled();

    app.router.visit("/dashboard");
    await settled();

    expect(cancelled).toBe(false);
    expect((await app.basePage()).component).toBe("Dashboard");
  });

  it("a reload aimed at a layer does not cancel the page's pending load", async () => {
    const pending = held();
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "/users": () => pending.answer(),
    });
    let cancelled = false;

    app.router.reload({ only: ["users"], onCancel: () => (cancelled = true) });
    await settled();
    expect(app.sent().at(-1)).toBe("get /users");

    scopeOf(app).router.reload({ only: ["user"] });
    await settled();

    expect(app.sent().at(-1)).toBe("get /users/5/edit");
    expect(cancelled).toBe(false);
  });

  it("discards a layer response whose layer closed while the request was in flight", async () => {
    const pending = held();
    let calls = 0;
    const app = await open(index(), {
      "/users/5/edit": () =>
        ++calls === 1 ? Promise.resolve(edit()) : pending.answer(),
      "/users": index(),
    });

    scopeOf(app).router.reload({ only: ["user"] });
    await settled();

    const closing = app.router.close();
    exitShells(app);
    await closing;
    await settled();

    pending.release(edit());
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.layers()).toEqual([]);
    expect(app.views()).toEqual([]);
  });

  it("discards a response whose standalone layer closed, rather than reopening it over the page", async () => {
    const pending = held();
    let calls = 0;
    const cold = edit({ layer: { key: "Users/Edit", base: "/users" } });
    const app = await scenario(index(), {
      "/users/5/edit": () =>
        ++calls === 1 ? Promise.resolve(cold) : pending.answer(),
      "/users": index(),
    });

    app.router.layer("/users/5/edit");
    await settled();

    scopeOf(app).router.reload({ only: ["user"] });
    await settled();

    const closing = app.router.close();
    exitShells(app);
    await closing;
    await settled();
    expect(app.layers()).toEqual([]);

    pending.release(cold);
    await settled();

    expect(app.layers()).toEqual([]);
    expect((await app.basePage()).component).toBe("Users/Index");
  });

  it("installs a page response for a visit whose layer closed, since it is a navigation", async () => {
    const pending = held();
    let calls = 0;
    const app = await open(index(), {
      "/users/5/edit": () =>
        ++calls === 1 ? Promise.resolve(edit()) : pending.answer(),
      "/users": index(),
    });

    scopeOf(app).router.visit("/users/5/edit");
    await settled();

    const closing = app.router.close();
    exitShells(app);
    await closing;
    await settled();

    pending.release(page("Dashboard", "/dashboard"));
    await settled();

    expect((await app.basePage()).component).toBe("Dashboard");
  });
});

describe("an instant visit that opens a layer or is made from one", () => {
  const instant = { component: "Users/Edit" };

  const stood = async (layer: Record<string, unknown> = {}) => {
    const next = held();
    let loads = 0;
    const app = await open(index(), {
      "/users/5/edit": () =>
        ++loads === 1 ? Promise.resolve(edit(layer)) : new Promise(() => {}),
      "/users/9/edit": () => next.answer(),
      "/users": index(),
    });

    return { app, next };
  };

  it("rewrites the layer where it stands rather than fabricating a page over the stack", async () => {
    const { app } = await stood();
    const [layer] = app.layers();

    scopeOf(app).router.visit("/users/9/edit", instant);
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      props: { users: [], errors: {} },
    });
    expect(app.layers()).toEqual([
      {
        id: layer.id,
        key: "Users/Edit",
        component: "Users/Edit",
        url: "/users/9/edit",
        type: "routed",
      },
    ]);
  });

  it("leaves the base its identity, so the response it fetched still composes onto the stack", async () => {
    const { app, next } = await stood();
    const before = await app.basePage();

    scopeOf(app).router.visit("/users/9/edit", instant);
    await settled();

    expect(await app.basePage()).toBe(before);

    next.release(
      edit({ url: "/users/9/edit", props: { user: { id: 9 }, errors: {} } }),
    );
    await settled();

    expect(await app.basePage()).toBe(before);
    expect(app.views()[0].page.props).toEqual({ user: { id: 9 }, errors: {} });
  });

  it("does not fire the onClose of the layer it is swapping", async () => {
    const { app } = await stood();
    let closed = false;

    scopeOf(app).onClose(() => (closed = true));
    scopeOf(app).router.visit("/users/9/edit", instant);
    await settled();

    expect(closed).toBe(false);
  });

  it("drops the record the layer was showing rather than carrying it into the placeholder", async () => {
    const { app } = await stood({
      props: { user: { id: 5 }, errors: {} },
      deferredProps: { default: ["history"] },
      onceProps: { token: { prop: "token" } },
      scrollProps: { items: { pageName: "page" } },
      rescuedProps: ["history"],
      flash: { message: "Saved" },
    });

    scopeOf(app).router.visit("/users/9/edit", instant);
    await settled();

    const swapped = app.views()[0].page;

    expect(swapped.props).toEqual({ errors: {} });
    expect(swapped.deferredProps).toEqual({});
    expect(swapped.onceProps).toEqual({});
    expect(swapped.scrollProps).toEqual({});
    expect(swapped.rescuedProps).toEqual([]);
    expect(swapped.flash).toEqual({});
  });

  it("remakes the layer component for the record it is heading to", async () => {
    const { app } = await stood();
    const before = app.views()[0].renderKey;

    scopeOf(app).router.visit("/users/9/edit", instant);
    await settled();

    expect(app.views()[0].renderKey).toBe(before + 1);
  });

  it("stacks a response under a different key as a new layer when no placeholder was fabricated", async () => {
    const { app } = await stood({ layer: { key: "panel:first" } });
    const [first] = app.layers();
    const second = page("Layers/Panel", "/layers/panel/second", {
      layer: { key: "panel:second" },
      props: { name: "second", errors: {} },
    });

    app.core.http.setClient({ request: async () => inertia(second) });
    scopeOf(app).router.visit("/layers/panel/second");
    await settled();

    expect(app.layers().map((layer) => layer.key)).toEqual([
      "panel:first",
      "panel:second",
    ]);
    expect(app.layers()[0].id).toBe(first.id);
  });

  it("lands the response on the layer it fabricated, keeping its component instance", async () => {
    const { app, next } = await stood();
    const [layer] = app.layers();

    scopeOf(app).router.visit("/users/9/edit", instant);
    await settled();

    const fabricated = app.views()[0].renderKey;

    next.release(
      edit({ url: "/users/9/edit", props: { user: { id: 9 }, errors: {} } }),
    );
    await settled();

    expect(app.views()[0].page.props).toEqual({ user: { id: 9 }, errors: {} });
    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.layers().map((open) => open.id)).toEqual([layer.id]);
    expect(app.views()[0].renderKey).toBe(fabricated);
  });

  it("leaves the scroll of the page beneath alone", async () => {
    const { app } = await stood();
    const { Scroll } = await import("../../../src/scroll");
    const reset = vi.spyOn(Scroll, "reset");

    scopeOf(app).router.visit("/users/9/edit", instant);
    await settled();

    expect(reset).not.toHaveBeenCalled();
  });

  it("still resets the scroll when it fabricates a page", async () => {
    const { app } = await stood();
    const { Scroll } = await import("../../../src/scroll");
    const reset = vi.spyOn(Scroll, "reset");

    app.router.visit("/users/9/edit", instant);
    await settled();

    expect(reset).toHaveBeenCalled();
  });

  it("still fabricates a page when the visit names no layer", async () => {
    const { app } = await stood();

    app.router.visit("/users/9/edit", instant);
    await settled();

    expect((await app.basePage()).component).toBe("Users/Edit");
    expect(app.layers()).toEqual([]);
  });

  it("lands a response keyed differently on the placeholder rather than beside it", async () => {
    const { app, next } = await stood({ layer: { key: "panel:first" } });
    const [layer] = app.layers();

    scopeOf(app).router.visit("/layers/panel/second", {
      component: "Layers/Panel",
    });
    app.core.http.setClient({
      request: () => next.answer().then(inertia),
    });
    await settled();

    next.release(
      page("Layers/Panel", "/layers/panel/second", {
        layer: { key: "panel:second" },
        props: { name: "second", errors: {} },
      }),
    );
    await settled();

    expect(app.layers()).toEqual([
      {
        id: layer.id,
        key: "panel:second",
        component: "Layers/Panel",
        url: "/layers/panel/second",
        type: "routed",
      },
    ]);
    expect(app.views()[0].page.props).toEqual({ name: "second", errors: {} });
  });

  it("puts the placeholder up as a layer, leaving the page it opens on where it is", async () => {
    const next = held();
    const app = await scenario(index(), {
      "/users/5/edit": () => next.answer(),
    });

    app.router.layer("/users/5/edit", { component: "Users/Edit" });
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(app.layers().map((layer) => [layer.component, layer.url])).toEqual([
      ["Users/Edit", "/users/5/edit"],
    ]);
    expect(app.entry().layers!.map((layer) => layer.owner)).toEqual([null]);
  });

  it("lands the response on the placeholder an open put up, under the id it created", async () => {
    const next = held();
    const app = await scenario(index(), {
      "/users/5/edit": () => next.answer(),
    });

    const handle = app.router.layer("/users/5/edit", {
      component: "Users/Edit",
    });
    await settled();

    const fabricated = app.layers()[0];

    next.release(edit());
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.layers()).toEqual([
      {
        id: fabricated.id,
        key: "Users/Edit",
        component: "Users/Edit",
        url: "/users/5/edit",
        type: "routed",
      },
    ]);
    expect(fabricated.id).toBe(handle.id);
    expect(handle.state).toBe("open");
    expect(app.views()[0].page.props).toEqual({ user: { id: 5 }, errors: {} });
  });

  it("falls back to fabricating a page when the layer it names has already closed", async () => {
    const { app } = await stood();
    const gone = scopeOf(app);
    const closing = gone.close();

    exitShells(app);
    await closing;
    await settled();
    app.core.http.setClient({ request: () => new Promise(() => {}) });

    gone.router.visit("/users/9/edit", instant);
    await settled();

    expect((await app.basePage()).component).toBe("Users/Edit");
    expect(app.layers()).toEqual([]);
  });
});

describe("a close: true response runs the close flow instead of installing", () => {
  const notes = page("Users/Notes", "/users/5/notes", {
    layer: { key: "Users/Notes" },
    props: { errors: {} },
  });

  it("runs the top-layer close flow when close: true arrives over an open layer, installing nothing", async () => {
    const refreshed = index({ props: { users: [{ id: 9 }], errors: {} } });
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "post /users/5/edit": index({ close: true, url: "/users/5/edit" }),
      "/users": refreshed,
    });
    const [layer] = app.layers();

    app.router.post("/users/5/edit");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
      props: { users: [], errors: {} },
    });
    expect(await app.basePage()).not.toHaveProperty("close");
    expect(app.layers()).toEqual([layer]);
    expect(app.views().map((view) => view.shell.open)).toEqual([false]);
    expect(app.sent()).toEqual(["get /users/5/edit", "post /users/5/edit"]);

    exitShells(app);
    await settled();

    expect(app.sent()).toEqual([
      "get /users/5/edit",
      "post /users/5/edit",
      "get /users",
    ]);
    expect(window.location.pathname).toBe("/users");
    expect((await app.basePage()).props.users).toEqual([{ id: 9 }]);
    expect(app.layers()).toEqual([]);
  });

  it("reports the submit as a success, since nothing about it failed", async () => {
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "post /users/5/edit": index({ close: true, url: "/users/5/edit" }),
      "/users": index(),
    });
    let succeeded = false;
    let errored = false;

    app.router.post(
      "/users/5/edit",
      {},
      { onSuccess: () => (succeeded = true), onError: () => (errored = true) },
    );
    await settled();

    expect(succeeded).toBe(true);
    expect(errored).toBe(false);
  });

  it("hands the success callbacks the page as the close leaves it, not the one still showing the layer", async () => {
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "/users/5/notes": notes,
      "post /users/5/notes": index({ close: true, url: "/users/5/notes" }),
      "/users": index(),
    });

    app.router.layer("/users/5/notes");
    await settled();

    let received: Record<string, unknown> | null = null;

    app.router
      .layerHandle(app.layers()[1].id)!
      .router.post(
        "/users/5/notes",
        {},
        { onSuccess: (page) => (received = page) },
      );
    await settled();

    expect(received).toMatchObject({
      component: "Users/Edit",
      url: "/users/5/edit",
      props: { user: { id: 5 }, errors: {} },
    });
    expect(received).not.toHaveProperty("layers");
  });

  it("closes the layer the visit was made from, and every layer above it", async () => {
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "/users/5/notes": notes,
      "post /users/5/edit": index({ close: true, url: "/users/5/edit" }),
      "/users": index(),
    });

    app.router.layer("/users/5/notes");
    await settled();
    expect(app.layers().map((layer) => layer.key)).toEqual([
      "Users/Edit",
      "Users/Notes",
    ]);

    scopeOf(app, 0).router.post("/users/5/edit");
    await settled();

    expect(app.views().map((view) => view.shell.open)).toEqual([false, false]);

    exitShells(app);
    await settled();

    expect(app.layers()).toEqual([]);
    expect(window.location.pathname).toBe("/users");
  });

  it("closes nothing when the layer the visit was made from has gone since", async () => {
    const answer = held();
    const app = await open(index(), {
      "/users/5/edit": edit(),
      "/users/5/notes": notes,
      "post /users/5": () => answer.answer(),
      "/users": index(),
    });
    const gone = scopeOf(app);

    gone.router.post("/users/5");
    await settled();

    const closing = gone.close();
    exitShells(app);
    await closing;
    await settled();

    app.router.layer("/users/5/notes");
    await settled();
    const written = app.written().length;

    answer.release(index({ close: true }));
    await settled();

    expect(app.written().length).toBe(written);
    expect(app.layers().map((layer) => layer.key)).toEqual(["Users/Notes"]);
    expect(app.views().map((view) => view.shell.open)).toEqual([true]);
  });

  it("refreshes the current page when close: true arrives with no layer open", async () => {
    const app = await scenario(index({ props: { stats: [1], errors: {} } }), {
      "post /users": index({
        close: true,
        props: { stats: [9, 9, 9], errors: {} },
      }),
    });

    app.router.post("/users");
    await settled();

    expect(app.sent()).toEqual(["post /users"]);
    expect((await app.basePage()).props).toEqual({
      stats: [9, 9, 9],
      errors: {},
    });
    expect(app.layers()).toEqual([]);
  });
});

describe("a submit answered by the tier the layer stands on", () => {
  const openLocal = async (routes: Record<string, Route>) => {
    const app = await scenario(index(), routes);
    const handle = app.router.layer({
      component: "Users/Confirm",
      props: { user: 5 },
    });

    await settled();

    return { app, handle };
  };

  const openLocalOverALayer = async (routes: Record<string, Route>) => {
    const app = await scenario(index(), { "/users/5/edit": edit(), ...routes });

    app.router.visit("/users/5/edit");
    await settled();

    const handle = app.router.layer({
      component: "Users/Confirm",
      props: { user: 5 },
    });

    await settled();

    return { app, handle, editId: app.layers()[0].id };
  };

  const submit = (app: App, id: string) =>
    new Promise<unknown>((resolve) => {
      app.router
        .layerHandle(id)!
        .router.post(
          "/users",
          {},
          { onError: resolve, onSuccess: () => resolve({}) },
        );
    });

  it("keeps a local layer up and gives it the errors the server handed back", async () => {
    const { app, handle } = await openLocal({
      "post /users": index({
        props: { users: [], errors: { name: "The name is required." } },
      }),
    });

    const announced = await submit(app, handle.id);

    expect(announced).toEqual({ name: "The name is required." });
    expect(app.layers().map((layer) => layer.id)).toEqual([handle.id]);
    expect(app.views()[0].page.props.errors).toEqual({
      name: "The name is required.",
    });
    expect((await app.basePage()).props.errors).toEqual({});
  });

  it("hands the flash back to the layer along with the errors", async () => {
    const { app, handle } = await openLocal({
      "post /users": index({
        props: { users: [], errors: { name: "Required." } },
        flash: { message: "Check the form." },
      }),
    });
    const flashes: unknown[] = [];

    await new Promise<void>((resolve) => {
      app.router.layerHandle(handle.id)!.router.post(
        "/users",
        {},
        {
          onFlash: (flash) => flashes.push(flash),
          onError: () => resolve(),
          onSuccess: () => resolve(),
        },
      );
    });

    expect(flashes).toEqual([{ message: "Check the form." }]);
    expect(app.views()[0].page.flash).toEqual({ message: "Check the form." });
    expect((await app.basePage()).flash).toEqual({});
  });

  it("clears the stack when the same submit comes back without errors", async () => {
    const { app, handle } = await openLocal({
      "post /users": index({ props: { users: [{ id: 9 }], errors: {} } }),
    });

    await submit(app, handle.id);
    exitShells(app);
    await settled();

    expect(app.layers()).toEqual([]);
    expect((await app.basePage()).props).toEqual({
      users: [{ id: 9 }],
      errors: {},
    });
  });

  it("clears the stack when the errors come back on another page altogether", async () => {
    const { app, handle } = await openLocal({
      "post /users": page("Users/Create", "/users/create", {
        props: { errors: { name: "Required." } },
      }),
    });

    await submit(app, handle.id);
    exitShells(app);
    await settled();

    expect(app.layers()).toEqual([]);
    expect((await app.basePage()).component).toBe("Users/Create");
  });

  it("keeps a local layer up when the address it was submitted from belongs to the layer beneath it", async () => {
    const { app, handle, editId } = await openLocalOverALayer({
      "post /users": edit({
        props: { user: { id: 5 }, errors: { name: "The name is required." } },
      }),
    });

    const announced = await submit(app, handle.id);

    expect(announced).toEqual({ name: "The name is required." });
    expect(app.layers().map((layer) => layer.id)).toEqual([editId, handle.id]);
    expect(app.views()[1].page.props.errors).toEqual({
      name: "The name is required.",
    });
    expect(app.views()[0].page.props.errors).toEqual({});
  });

  it("closes the local layer when the errors come back from another url of that layer", async () => {
    const { app, handle, editId } = await openLocalOverALayer({
      "post /users": edit({
        url: "/users/6/edit",
        props: { user: { id: 6 }, errors: { name: "Required." } },
      }),
    });

    await submit(app, handle.id);
    exitShells(app);
    await settled();

    expect(app.layers().map((layer) => layer.id)).toEqual([editId]);
    expect(app.views()[0].page.props.errors).toEqual({ name: "Required." });
  });
});
