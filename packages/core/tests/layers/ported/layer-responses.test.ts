import { describe, expect, it, vi } from "vitest";
import {
  exitShells,
  held,
  page,
  scenario,
  settled,
  type Answer,
  type Route,
} from "./a-support";

const users = page("Users/Index", "/users", {
  props: { users: [], errors: {} },
});
const editLayer = (extra: Answer = {}) =>
  page("Users/Edit", "/users/5/edit", {
    layer: { key: "Users/Edit" },
    props: { user: { id: 5 }, errors: {} },
    ...extra,
  });
const teams = page("Teams/Show", "/teams/9", {
  layer: { key: "Teams/Show" },
  props: { errors: {} },
});

const open = async (
  initial: Answer = users,
  routes: Record<string, Route> = {},
) => {
  const app = await scenario(initial, {
    "/users/5/edit": editLayer(),
    "/teams/9": teams,
    ...routes,
  });

  app.router.visit("/users/5/edit");
  await settled();

  return app;
};

const ids = (app: Awaited<ReturnType<typeof scenario>>) =>
  app.layers().map((layer) => layer.id);

describe("resolving a page with layers", () => {
  it("resolves every layer and hands them to the adapter in stack order", async () => {
    const app = await open();

    app.router.visit("/teams/9");
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.views().map((view) => [view.id, view.component])).toEqual([
      [app.layers()[0].id, { name: "Users/Edit" }],
      [app.layers()[1].id, { name: "Teams/Show" }],
    ]);
    expect(app.layers().map((layer) => layer.component)).toEqual([
      "Users/Edit",
      "Teams/Show",
    ]);
  });

  it("keeps the rest of the layer state beside the resolved component", async () => {
    const app = await scenario(users, {
      "/users/5/edit": page("Users/Edit", "/users/5/edit", {
        props: { user: { id: 5 }, errors: {} },
        layer: { key: "Users/Edit", base: "/users" },
      }),
    });

    app.router.visit("/users/5/edit");
    await settled();

    const [{ id }] = app.layers();

    expect(app.views()).toHaveLength(1);
    expect(app.views()[0]).toMatchObject({
      id,
      renderKey: 1,
      component: { name: "Users/Edit" },
      page: {
        component: "Users/Edit",
        url: "/users/5/edit",
        props: { user: { id: 5 }, errors: {} },
        layer: { key: "Users/Edit", base: "/users" },
      },
      attributes: {
        "data-layer-id": id,
        style: { viewTransitionName: `inertia-layer-${id}` },
      },
      shell: {
        open: true,
        index: 0,
        isTop: true,
        type: "routed",
        close: expect.any(Function),
        done: expect.any(Function),
      },
    });
    expect(app.views()[0].scope.id).toBe(id);
  });

  it("passes no layers for an ordinary page", async () => {
    const app = await scenario(users, {
      "/users/7": page("Users/Show", "/users/7"),
    });

    app.router.visit("/users/7");
    await settled();

    expect((await app.basePage()).component).toBe("Users/Show");
    expect(app.views()).toEqual([]);
    expect(app.layers()).toEqual([]);
  });
});

describe("an ordinary response", () => {
  it("is passed through untouched, with no layers key", async () => {
    const app = await scenario(users, {
      "/users/5": page("Users/Show", "/users/5"),
    });

    app.router.visit("/users/5");
    await settled();

    expect(app.layers()).toEqual([]);
    expect(await app.basePage()).not.toHaveProperty("layers");
    expect(app.entry()).not.toHaveProperty("layers");
    expect(app.entry()).toMatchObject({
      component: "Users/Show",
      url: "/users/5",
    });
  });
});

describe("base generation", () => {
  it("changes when a page response replaces the base", async () => {
    const app = await open(users, {
      "/users/5": page("Users/Show", "/users/5"),
    });

    app.router.visit("/users/5");
    await settled();

    expect((await app.basePage()).component).toBe("Users/Show");
    expect(app.layers()).toEqual([]);
  });

  it("survives a layer composed onto the base", async () => {
    const app = await open();
    const [first] = app.layers();

    app.router.visit("/teams/9");
    await settled();

    expect(app.layers().map((layer) => layer.component)).toEqual([
      "Users/Edit",
      "Teams/Show",
    ]);
    expect(app.layers()[0].id).toBe(first.id);
    expect((await app.basePage()).component).toBe("Users/Index");
  });

  it("changes when a navigation lands on the very same page", async () => {
    const app = await open(users, { "/users": users });
    const before = ids(app);

    app.router.visit("/users");
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(ids(app)).toEqual(before);
  });

  it("survives a partial reload of the same page", async () => {
    const app = await open(users, {
      "/users": page("Users/Index", "/users", {
        props: { users: [{ id: 1 }], errors: {} },
      }),
    });
    const before = ids(app);

    app.router.reload({ only: ["users"] });
    await settled();

    expect(ids(app)).toEqual(before);
    expect((await app.basePage()).props).toEqual({
      users: [{ id: 1 }],
      errors: {},
    });
  });

  it("survives a client visit that only rewrites the url", async () => {
    const app = await open();
    const before = ids(app);

    app.router.replace({ url: "http://localhost/users?page=2" });
    await settled();

    expect(ids(app)).toEqual(before);
    expect((await app.basePage()).url).toBe("http://localhost/users?page=2");
  });

  it("changes when a client visit declares another component", async () => {
    const app = await open();

    app.router.push({
      component: "Users/Create",
      url: "http://localhost/users/create",
    });
    await settled();

    expect((await app.basePage()).component).toBe("Users/Create");
    expect(app.layers()).toEqual([]);
  });

  it("changes when a client visit pushes another page state", async () => {
    const app = await open();

    app.router.push({
      url: "http://localhost/users/2",
      props: { users: [{ id: 2 }] },
    });
    await settled();

    expect((await app.basePage()).url).toBe("http://localhost/users/2");
    expect(app.layers()).toEqual([]);
  });

  it("survives the prop helpers rewriting the page in place", async () => {
    const app = await open();
    const before = ids(app);

    app.router.replaceProp("users", [{ id: 1 }]);
    expect(ids(app)).toEqual(before);
    expect((await app.basePage()).props.users).toEqual([{ id: 1 }]);

    app.router.appendToProp("users", { id: 2 });
    expect(ids(app)).toEqual(before);
    expect((await app.basePage()).props.users).toEqual([{ id: 1 }, { id: 2 }]);

    app.router.prependToProp("users", { id: 0 });
    expect(ids(app)).toEqual(before);
    expect((await app.basePage()).props.users).toEqual([
      { id: 0 },
      { id: 1 },
      { id: 2 },
    ]);
  });

  it("changes when history restores a page", async () => {
    const app = await scenario(users, {
      "/dashboard": page("Dashboard", "/dashboard"),
      "/users/5/edit": editLayer(),
    });

    app.router.visit("/dashboard");
    await settled();
    app.router.visit("/users/5/edit");
    await settled();
    expect(app.layers().map((layer) => layer.component)).toEqual([
      "Users/Edit",
    ]);

    window.history.go(-2);
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.layers()).toEqual([]);
  });

  it("survives a prop refresh of the base", async () => {
    const app = await open(users, {
      "/users": page("Users/Index", "/users", {
        props: { users: [{ id: 1 }], errors: {} },
      }),
    });
    const before = ids(app);

    app.router.reload({ only: ["users"], preserveState: true });
    await settled();

    expect(ids(app)).toEqual(before);
    expect((await app.basePage()).props.users).toEqual([{ id: 1 }]);
  });
});

describe("base id", () => {
  const ownersOf = (app: Awaited<ReturnType<typeof scenario>>) =>
    (app.entry().layers as { owner: string | null }[]).map(
      (layer) => layer.owner,
    );

  it("is created for the base it is given", async () => {
    const app = await open();

    expect(ownersOf(app)).toEqual([null]);
    expect((await app.basePage()).component).toBe("Users/Index");
  });

  it("survives a layer composed onto the base", async () => {
    const app = await open();
    const [first] = app.layers();

    app.router.visit("/teams/9");
    await settled();

    expect(app.layers()[0].id).toBe(first.id);
    expect(
      (app.entry().layers as { owner: string | null }[])[0].owner,
    ).toBeNull();
  });

  it("survives a partial reload of the same page", async () => {
    const app = await open(users, {
      "/users": page("Users/Index", "/users", {
        props: { users: [{ id: 1 }], errors: {} },
      }),
    });
    const [first] = app.layers();

    app.router.reload({ only: ["users"] });
    await settled();

    expect(app.layers()).toEqual([first]);
    expect(ownersOf(app)).toEqual([null]);
  });

  it("survives a plain reload of the same page", async () => {
    const app = await open(users, {
      "/users": page("Users/Index", "/users", {
        props: { users: [{ id: 9 }], errors: {} },
      }),
    });
    const [first] = app.layers();

    app.router.reload();
    await settled();

    expect(app.layers()).toEqual([first]);
    expect(ownersOf(app)).toEqual([null]);
  });

  it("changes when a navigation replaces the base", async () => {
    const app = await open(users, {
      "/users/5": page("Users/Show", "/users/5"),
    });
    const [first] = app.layers();

    app.router.visit("/users/5");
    await settled();
    app.router.visit("/teams/9");
    await settled();

    expect(app.layers().map((layer) => layer.component)).toEqual([
      "Teams/Show",
    ]);
    expect(app.layers()[0].id).not.toBe(first.id);
    expect(ownersOf(app)).toEqual([null]);
  });

  it("survives a preserved visit to another url of the same component", async () => {
    const app = await scenario(users, {
      "/users?filter=x": page("Users/Index", "/users?filter=x", {
        props: { users: [], errors: {} },
      }),
    });
    const swaps = await recordSwaps();

    app.router.visit("/users?filter=x", { preserveState: true });
    await settled();

    expect(swaps()).toEqual([
      { component: { name: "Users/Index" }, preserveState: true },
    ]);
  });

  it("changes when a preserved visit installs another component", async () => {
    const app = await open(users, {
      "/users/7": page("Users/Show", "/users/7"),
    });

    app.router.visit("/users/7", { preserveState: true });
    await settled();

    expect((await app.basePage()).component).toBe("Users/Show");
    expect(app.layers()).toEqual([]);
  });

  it("never changes on a history restore", async () => {
    const app = await open();
    const [first] = app.layers();

    window.history.back();
    await settled();
    exitShells(app);
    await settled();
    expect(app.layers()).toEqual([]);

    window.history.go(1);
    await settled();

    expect(app.layers()).toEqual([first]);
    expect(ownersOf(app)).toEqual([null]);
  });
});

describe("an open stack across a client visit", () => {
  it("leaves the stack behind when a client visit installs another page", async () => {
    const app = await open();

    app.router.push({
      component: "Reports/Index",
      url: "http://localhost/reports",
    });
    await settled();

    expect((await app.basePage()).component).toBe("Reports/Index");
    expect(app.layers()).toEqual([]);
    expect(app.entry()).not.toHaveProperty("layers");
  });

  it("leaves the stack behind when a client visit pushes another state of the same component", async () => {
    const app = await open();

    app.router.push({
      url: "http://localhost/users/2",
      props: { users: [{ id: 2 }] },
    });
    await settled();

    expect(app.layers()).toEqual([]);
    expect(app.entry()).not.toHaveProperty("layers");
  });

  it("keeps the stack when a client visit only rewrites the page beneath it", async () => {
    const app = await open();

    app.router.replace({ url: "http://localhost/users?page=2" });
    await settled();

    expect(app.layers().map((layer) => layer.key)).toEqual(["Users/Edit"]);
  });

  it("keeps the stack when a prop helper rewrites the page beneath it", async () => {
    const app = await open();

    app.router.replace({ props: { users: [{ id: 1 }] } });
    await settled();

    expect((await app.basePage()).props).toEqual({ users: [{ id: 1 }] });
    expect(app.layers().map((layer) => layer.key)).toEqual(["Users/Edit"]);
  });
});

describe("a client visit aimed at a layer", () => {
  const holdLayer = async () => {
    const app = await open(users, {
      "/users/5/edit": editLayer({
        props: { user: { id: 5 }, todos: [1], errors: {} },
      }),
    });

    return { app, layer: app.router.layerHandle()! };
  };

  it("replaceProp changes the layer's own props, not the page's", async () => {
    const { app, layer } = await holdLayer();

    layer.router.replaceProp("todos", [7]);
    await settled();

    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      todos: [7],
      errors: {},
    });
    expect((await app.basePage()).props).toEqual({ users: [], errors: {} });
  });

  it("leaves the scroll of the page beneath alone", async () => {
    const { app, layer } = await holdLayer();
    const { Scroll } = await import("../../../src/scroll");
    const reset = vi.spyOn(Scroll, "reset");

    layer.router.push({ props: { user: { id: 9 } } });
    await settled();

    expect(reset).not.toHaveBeenCalled();
    expect(app.views()[0].page.props).toEqual({ user: { id: 9 } });
  });

  it("still resets the scroll when it is aimed at the page", async () => {
    const { app } = await holdLayer();
    const { Scroll } = await import("../../../src/scroll");
    const reset = vi.spyOn(Scroll, "reset");

    app.router.push({ props: { users: [] } });
    await settled();

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("a push keeps the stack and the base generation", async () => {
    const { app, layer } = await holdLayer();
    const before = ids(app);

    layer.router.push({
      url: "/users/5/edit?step=2",
      props: { user: { id: 5 }, step: 2 },
    });
    await settled();

    expect(app.layers().map((open) => [open.key, open.url])).toEqual([
      ["Users/Edit", "/users/5/edit?step=2"],
    ]);
    expect(ids(app)).toEqual(before);
    expect(app.views()[0].page.props).toMatchObject({ step: 2 });
    expect((await app.basePage()).props).toEqual({ users: [], errors: {} });
    expect((await app.basePage()).url).toBe("/users");
  });

  it("a replace keeps the stack and the base generation", async () => {
    const { app, layer } = await holdLayer();
    const before = ids(app);

    layer.router.replace({ props: { user: { id: 9 } } });
    await settled();

    expect(app.layers().map((open) => open.key)).toEqual(["Users/Edit"]);
    expect(ids(app)).toEqual(before);
    expect(app.views()[0].page.props).toMatchObject({ user: { id: 9 } });
    expect((await app.basePage()).props).toEqual({ users: [], errors: {} });
  });

  it("does not write a stale layer id onto the page it installs", async () => {
    const { app } = await holdLayer();

    app.router.push({ url: "/reports", props: { users: [{ id: 9 }] } });
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(await app.basePage()).not.toHaveProperty("layerId");
  });

  it("carries the layer errors it brings into onError", async () => {
    const { layer } = await holdLayer();
    const outcome: unknown[] = [];

    layer.router.replace({
      props: (layerProps) => ({
        ...layerProps,
        errors: { note: "The note is required." },
      }),
      onError: (errors) => outcome.push(["error", errors]),
      onSuccess: () => outcome.push(["success"]),
    });
    await settled();

    expect(outcome).toEqual([["error", { note: "The note is required." }]]);
  });

  it("hands the props function the layer's onceProps", async () => {
    const app = await open(users, {
      "/users/5/edit": editLayer({
        props: { user: { id: 5 }, layerProp: "layer value", errors: {} },
        onceProps: { layerKey: { prop: "layerProp" } },
      }),
    });
    let receivedOnce: unknown;

    app.router.layerHandle()!.router.replace({
      props: (layerProps, onceProps) => {
        receivedOnce = onceProps;

        return layerProps;
      },
    });
    await settled();

    expect(receivedOnce).toEqual({ layerProp: "layer value" });
  });

  it("does not fall back to the page's errors", async () => {
    const app = await open(
      page("Users/Index", "/users", {
        props: { users: [], errors: { name: "The name is required." } },
      }),
      {
        "/users/5/edit": editLayer({
          props: { user: { id: 5 }, todos: [1], errors: {} },
        }),
      },
    );
    const outcome: unknown[] = [];

    app.router.layerHandle()!.router.replace({
      props: (layerProps) => ({ ...layerProps, todos: [7] }),
      onError: (errors) => outcome.push(["error", errors]),
      onSuccess: () => outcome.push(["success"]),
    });
    await settled();

    expect(outcome).toEqual([["success"]]);
  });

  it("applies and announces flash on the layer", async () => {
    const { app, layer } = await holdLayer();
    const announced: unknown[] = [];

    layer.router.replace({
      props: (layerProps) => ({ ...layerProps, todos: [7] }),
      flash: { message: "Saved." },
      onFlash: (flash) => announced.push(flash),
    });
    await settled();

    expect(announced).toEqual([{ message: "Saved." }]);
    expect(app.views()[0].page.flash).toEqual({ message: "Saved." });
    expect((await app.basePage()).flash).toEqual({});
  });

  it("clears the flash a layer was already showing, rather than announcing it a second time", async () => {
    const { app, layer } = await holdLayer();
    const announced: unknown[] = [];

    layer.router.replace({ flash: { message: "Saved." } });
    await settled();
    layer.router.replace({
      props: (layerProps) => ({ ...layerProps, todos: [7] }),
      onFlash: (flash) => announced.push(flash),
    });
    await settled();

    expect(announced).toEqual([]);
    expect(app.views()[0].page.flash).toEqual({});
  });
});

describe("a response that refreshes the base", () => {
  it("does not merge a plain reload into the props already held", async () => {
    const app = await scenario(
      page("Users/Index", "/users", {
        props: { users: [], stale: true, errors: {} },
      }),
      {
        "/users": page("Users/Index", "/users", {
          props: { users: [{ id: 1 }], errors: {} },
        }),
      },
    );

    app.router.reload();
    await settled();

    expect((await app.basePage()).props).toEqual({
      users: [{ id: 1 }],
      errors: {},
    });
  });
});

describe("the base a layer response composes onto", () => {
  it("composes onto the page a visit aimed at the layer was made from", async () => {
    const app = await open();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect((await app.basePage()).url).toBe("/users");
    expect(app.layers().map((layer) => [layer.key, layer.url])).toEqual([
      ["Users/Edit", "/users/5/edit"],
    ]);
    expect(app.entry().layers).toHaveLength(1);
  });

  it("composes onto the page it names as its base, when a create redirects to the record", async () => {
    const app = await scenario(users, {
      "post /users": editLayer({
        layer: { key: "Users/Edit", base: "/users" },
      }),
    });

    app.router.post("/users");
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect((await app.basePage()).url).toBe("/users");
    expect(app.layers().map((layer) => [layer.key, layer.url])).toEqual([
      ["Users/Edit", "/users/5/edit"],
    ]);
    expect(app.sent()).toEqual(["post /users"]);
  });

  it("walks a base back for a layer whose base is not the page on screen", async () => {
    const walk = held();
    const app = await scenario(page("Auth/Login", "/login"), {
      "post /login": editLayer({
        layer: { key: "Users/Edit", base: "/users" },
      }),
      "/users": () => walk.answer(),
    });

    app.router.post("/login");
    await settled();

    expect((await app.basePage()).component).toBe("");
    expect(app.layers().map((layer) => layer.key)).toEqual(["Users/Edit"]);
    expect(app.entry()).toMatchObject({
      component: "Users/Edit",
      url: "/users/5/edit",
    });
    expect(app.sent()).toEqual(["post /login", "get /users"]);

    walk.release(users);
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.layers().map((layer) => layer.key)).toEqual(["Users/Edit"]);
    expect(app.entry().layers).toMatchObject([
      { key: "Users/Edit", standalone: true },
    ]);
  });

  it("composes onto the page beneath a layer that is already open", async () => {
    const app = await open(users, {
      "post /users/5": editLayer({
        props: {
          user: { id: 5 },
          errors: { name: "The name field is required." },
        },
      }),
    });
    const before = ids(app);

    app.router.post("/users/5");
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect((await app.basePage()).url).toBe("/users");
    expect(ids(app)).toEqual(before);
    expect(app.views()[0].page.props).toEqual({
      user: { id: 5 },
      errors: { name: "The name field is required." },
    });
  });

  it("composes onto a layer that opened while the visit was in flight", async () => {
    const post = held();
    const app = await scenario(users, {
      "post /users/5": () => post.answer(),
      "/users/5/edit": editLayer(),
    });

    app.router.post("/users/5");
    await settled();
    app.router.layer("/users/5/edit");
    await settled();

    const before = ids(app);

    post.release(editLayer({ props: { user: { id: 5 }, errors: {} } }));
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.layers().map((layer) => layer.key)).toEqual(["Users/Edit"]);
    expect(ids(app)).toEqual(before);
  });

  it("composes onto the stack when a visit from inside it comes back as a different layer", async () => {
    const app = await open(users, { "post /users/5/promote": teams });

    app.router.post("/users/5/promote");
    await settled();

    expect((await app.basePage()).component).toBe("Users/Index");
    expect(app.layers().map((layer) => layer.key)).toEqual([
      "Users/Edit",
      "Teams/Show",
    ]);
  });
});

/** Records what each base swap hands the adapter. */
async function recordSwaps() {
  const { page: basePage } = await import("../../../src/page");
  const recorded: { component: unknown; preserveState: boolean }[] = [];
  const target = basePage as unknown as {
    swapComponent: (args: any) => Promise<void>;
  };

  target.swapComponent = async ({ component, preserveState }) => {
    recorded.push({ component, preserveState });
  };

  return () => recorded;
}
