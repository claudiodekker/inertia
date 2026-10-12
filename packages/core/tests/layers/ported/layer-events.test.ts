import { afterEach, describe, expect, it, vi } from "vitest";
import { exitShells, page, settled, start, type App } from "./f-support";

const users = page("Users/Index", "/users", {
  props: { errors: {}, users: [] },
});
const edit = page("Users/Edit", "/users/5/edit", {
  layer: { key: "Users/Edit", base: "/users" },
});
const teams = page("Teams/Show", "/teams/9", {
  layer: { key: "Teams/Show", base: "/users" },
});
const routes = {
  "/users": users,
  "/users/5/edit": edit,
  "/teams/9": teams,
  "/users/5/edit?page=2": { ...edit, url: "/users/5/edit?page=2" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("layer events for development tooling", () => {
  const watched = (app: App, heard: string[]) => {
    let known: string[] = app.layers().map((layer) => layer.id);

    return app.subscribe(() => {
      const now = app.layers().map((layer) => layer.id);

      heard.push(
        ...now.filter((id) => !known.includes(id)).map((id) => `opened:${id}`),
      );
      heard.push(
        ...known.filter((id) => !now.includes(id)).map((id) => `closed:${id}`),
      );
      known = now;
    });
  };

  it("announces a layer landing on the stack", async () => {
    const app = await start(users, routes);
    const heard: string[] = [];

    watched(app, heard);

    const handle = app.router.layer("/users/5/edit");
    await settled();

    expect(heard).toEqual([`opened:${handle.id}`]);
    expect(app.layers()).toEqual([
      {
        id: handle.id,
        key: "Users/Edit",
        component: "Users/Edit",
        url: "/users/5/edit",
        type: "routed",
      },
    ]);
  });

  it("announces every layer of a stack that opens at once, deepest first", async () => {
    const app = await start(users, routes);
    const first = app.router.layer("/users/5/edit");
    await settled();
    const second = app.router.layer("/teams/9");
    await settled();

    window.history.go(-2);
    await settled();
    expect(app.layers()).toEqual([]);

    const heard: string[] = [];

    watched(app, heard);
    window.history.go(2);
    await settled();

    expect(heard).toEqual([`opened:${first.id}`, `opened:${second.id}`]);
  });

  it("announces a layer leaving the stack, however it was written out", async () => {
    const app = await start(users, routes);
    const first = app.router.layer("/users/5/edit");
    await settled();
    const second = app.router.layer("/teams/9");
    await settled();
    const heard: string[] = [];

    watched(app, heard);
    app.router.layerHandle(first.id)!.close();
    await settled();
    exitShells(app);
    await settled();

    expect(heard).toEqual([`closed:${first.id}`, `closed:${second.id}`]);
  });

  it("announces a dismissed layer once the shell has run its exit", async () => {
    const app = await start(users, routes);
    app.router.layer("/users/5/edit");
    await settled();
    const second = app.router.layer("/teams/9");
    await settled();
    const heard: string[] = [];

    watched(app, heard);
    void second.close();
    await settled();

    expect(app.views().map((view) => view.shell.open)).toEqual([true, false]);
    expect(heard).toEqual([]);

    exitShells(app);
    await settled();

    expect(heard).toEqual([`closed:${second.id}`]);
  });

  it("announces a rewrite as nothing: the layer is still the layer it was", async () => {
    const app = await start(users, routes);
    const handle = app.router.layer("/users/5/edit");
    await settled();
    const heard: string[] = [];

    watched(app, heard);
    app.router.visit("/users/5/edit?page=2");
    await settled();

    expect(app.layers()).toEqual([
      {
        id: handle.id,
        key: "Users/Edit",
        component: "Users/Edit",
        url: "/users/5/edit?page=2",
        type: "routed",
      },
    ]);
    expect(heard).toEqual([]);
  });

  it("announces the whole stack of a document that opens on one", async () => {
    const heard: string[] = [];
    const known: string[] = [];
    const app = await start(
      edit,
      { "/users": users },
      {
        boot: true,
        onCore: ({ layerSlot }) => {
          layerSlot.subscribe(() => {
            const now = layerSlot.info().map((layer) => layer.id);

            heard.push(
              ...now
                .filter((id) => !known.includes(id))
                .map((id) => `opened:${id}`),
            );
            known.splice(0, known.length, ...now);
          });
        },
      },
    );

    expect(heard).toEqual([`opened:${app.layers()[0].id}`]);
    expect(app.layers()).toEqual([
      {
        id: app.layers()[0].id,
        key: "Users/Edit",
        component: "Users/Edit",
        url: "/users/5/edit",
        type: "routed",
      },
    ]);
  });

  it("announces what a layer emits, and to whom", async () => {
    const app = await start(users, routes);
    const first = app.router.layer("/users/5/edit");
    await settled();
    const second = app.router.layerHandle(first.id)!.router.layer("/teams/9");
    await settled();
    const heard: unknown[] = [];

    first.on("saved", (payload, from) =>
      heard.push({ from: from.id, name: "saved", payload }),
    );
    app.router.layerHandle(second.id)!.emit("saved", { id: 5 });

    expect(heard).toEqual([
      { from: second.id, name: "saved", payload: { id: 5 } },
    ]);
  });

  it("announces an emit from a layer nobody opened, with no recipient", async () => {
    const app = await start(users, routes);
    const handle = app.router.layer("/users/5/edit");
    await settled();
    const heard: unknown[] = [];

    handle.on("saved", (payload) => heard.push(payload));
    app.router
      .layerHandle(handle.id)!
      .on("saved", (payload) => heard.push(payload));

    expect(() =>
      app.router.layerHandle(handle.id)!.emit("saved"),
    ).not.toThrow();
    expect(heard).toEqual([]);
  });

  it("stops announcing to a handler once it is unsubscribed", async () => {
    const app = await start(users, routes);
    const heard: string[] = [];
    const stop = watched(app, heard);

    stop();
    app.router.layer("/users/5/edit");
    await settled();

    expect(heard).toEqual([]);
  });
});
