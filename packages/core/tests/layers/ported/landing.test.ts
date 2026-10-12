import { describe, expect, it } from "vitest";
import {
  bench,
  byPath,
  exitShells,
  gate,
  page,
  settled,
  type Bench,
} from "./e-support";

const users = page("Users/Index", "/users");
const login = page("Auth/Login", "/login");
const edit = page("Users/Edit", "/users/5/edit", {
  layer: { key: "Users/Edit" },
  props: { errors: {}, user: { id: 5 } },
});
const teamsShow = page("Teams/Show", "/teams/9", {
  layer: { key: "Teams/Show" },
});
const teamsMembers = page("Teams/Members", "/teams/9/members", {
  layer: { key: "Teams/Members" },
});
const teamsIndex = page("Teams/Index", "/teams");

const components = (app: Bench) => app.layers().map((layer) => layer.component);

describe("whether a layer response composes over the captured base", () => {
  it("holds when the visit was dispatched toward the layer", async () => {
    const app = await bench(login, byPath({ "/users/5/edit": edit }));

    app.router.visit("/users/5/edit");
    await settled();

    expect((await app.basePage()).component).toBe("Auth/Login");
    expect(components(app)).toEqual(["Users/Edit"]);
  });

  it("holds when the layer is already open", async () => {
    const app = await bench(
      login,
      byPath({
        "/users/5/edit": edit,
        "/login": { ...edit, props: { errors: {}, user: { id: 6 } } },
      }),
    );

    app.router.visit("/users/5/edit");
    await settled();

    const [open] = app.layers();

    app.router.visit("/login");
    await settled();

    expect((await app.basePage()).component).toBe("Auth/Login");
    expect(app.layers()).toEqual([open]);
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 6 } });
  });

  it("holds when the layer it was dispatched from is still open", async () => {
    const app = await bench(
      login,
      byPath({ "/teams/9": teamsShow, "/login": edit }),
    );

    app.router.visit("/teams/9");
    await settled();

    const [open] = app.layers();

    app.router.visit("/login");
    await settled();

    expect((await app.basePage()).component).toBe("Auth/Login");
    expect(components(app)).toEqual(["Teams/Show", "Users/Edit"]);
    expect(app.layers()[0]).toEqual(open);
    expect(app.entry().layers!.map((layer) => layer.owner)).toEqual([
      null,
      open.id,
    ]);
  });

  it("holds when the layer declares the page on screen as its base", async () => {
    const app = await bench(
      login,
      byPath({
        "/login": { ...edit, layer: { key: "Users/Edit", base: "/login" } },
      }),
    );

    app.router.visit("/login");
    await settled();

    expect((await app.basePage()).component).toBe("Auth/Login");
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(app.requests.map((request) => request.path)).toEqual(["/login"]);
  });

  it("holds for an open, whatever the visit was dispatched toward", async () => {
    const app = await bench(login, byPath({ "/login": edit }));
    const handle = app.router.layer("/login");

    await settled();

    expect((await app.basePage()).component).toBe("Auth/Login");
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(handle.state).toBe("open");
    expect(app.layers()[0].id).toBe(handle.id);
  });

  it("fails once the layer it was dispatched from has been closed", async () => {
    const held = gate();
    const app = await bench(
      login,
      byPath({
        "/teams/9": teamsShow,
        "/other": () => held.opened.then(() => edit),
        "/login": login,
      }),
    );
    const handle = app.router.layer("/teams/9");

    await settled();
    app.router.visit("/other", { async: true });
    await settled();

    const closing = handle.close();

    exitShells(app);
    await closing;
    held.open();
    await settled();

    expect(app.layers()).toEqual([]);
    expect(await app.basePage()).toMatchObject({
      component: "Users/Edit",
      url: "/users/5/edit",
    });
    expect(await app.basePage()).not.toHaveProperty("layer");
  });

  it("fails when the layer it was dispatched from has been closed and another opened", async () => {
    const held = gate();
    const app = await bench(
      login,
      byPath({
        "/teams/9": teamsShow,
        "/teams/9/members": teamsMembers,
        "/other": () => held.opened.then(() => edit),
        "/login": login,
      }),
    );
    const first = app.router.layer("/teams/9");

    await settled();
    app.router.visit("/other", { async: true });
    await settled();

    const closing = first.close();

    exitShells(app);
    await closing;
    app.router.layer("/teams/9/members");
    await settled();
    expect(components(app)).toEqual(["Teams/Members"]);

    held.open();
    await settled();
    exitShells(app);
    await settled();

    expect(app.layers()).toEqual([]);
    expect(await app.basePage()).toMatchObject({
      component: "Users/Edit",
      url: "/users/5/edit",
    });
  });

  it("fails for a layer returned through a login page", async () => {
    const app = await bench(login, byPath({ "/login": edit }));

    app.router.visit("/login");
    await settled();

    expect(app.layers()).toEqual([]);
    expect(await app.basePage()).toMatchObject({
      component: "Users/Edit",
      url: "/users/5/edit",
    });
    expect(await app.basePage()).not.toHaveProperty("layer");
  });

  it("fails once the base it captured has been replaced, whatever else holds", async () => {
    const held = gate();
    const app = await bench(
      login,
      byPath({
        "/users/5/edit": () => held.opened.then(() => edit),
        "/teams": teamsIndex,
      }),
    );

    app.router.visit("/users/5/edit", { async: true });
    await settled();
    app.router.visit("/teams");
    await settled();
    held.open();
    await settled();

    expect(app.layers()).toEqual([]);
    expect(await app.basePage()).toMatchObject({
      component: "Teams/Index",
      url: "/teams",
    });
  });

  it("never composes a hop of a walk, which is fetching the base beneath", async () => {
    const app = await bench(
      login,
      byPath({
        "/login": { ...edit, layer: { key: "Users/Edit", base: "/users" } },
        "/users": {
          ...edit,
          component: "Users/Index",
          url: "/users",
          layer: { key: "Users/Index" },
        },
      }),
    );

    app.router.visit("/login");
    await settled();

    expect(app.requests.map((request) => request.path)).toEqual([
      "/login",
      "/users",
    ]);
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(await app.basePage()).not.toHaveProperty("layer");
  });
});

describe("a layer response landing", () => {
  const cold = { ...edit, layer: { key: "Users/Edit", base: "/users" } };

  it("opens a new layer over the base, leaving the base standing", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": edit }));
    const before = app.written().length;

    app.router.visit("/users/5/edit");
    await settled();

    const [open] = app.layers();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(app.entry()).toMatchObject({
      component: "Users/Index",
      url: "/users",
      layers: [
        {
          id: open.id,
          component: "Users/Edit",
          url: "/users/5/edit",
          entries: 1,
        },
      ],
    });
    expect(app.entry().layers![0]).not.toHaveProperty("standalone");
    expect(app.written().slice(before)).toEqual([["push", "/users/5/edit"]]);
    expect(app.requests.map((request) => request.path)).toEqual([
      "/users/5/edit",
    ]);
  });

  it("rewrites the layer already open under the same key rather than stacking a second", async () => {
    const app = await bench(
      users,
      byPath({
        "/users/5/edit": edit,
        "/users/6/edit": {
          ...edit,
          url: "/users/6/edit",
          props: { errors: {}, user: { id: 6 } },
        },
      }),
    );

    app.router.visit("/users/5/edit");
    await settled();

    const [open] = app.layers();

    app.router.layerHandle(open.id)!.router.visit("/users/6/edit");
    await settled();

    expect(app.layers()).toEqual([{ ...open, url: "/users/6/edit" }]);
    expect(app.views()[0].page.props).toEqual({ errors: {}, user: { id: 6 } });
  });

  it("opens under the id the call created, so its handle answers for it", async () => {
    const app = await bench(users, byPath({ "/users/5/edit": edit }));
    const handle = app.router.layer("/users/5/edit");
    const id = handle.id;

    await settled();

    expect(handle.state).toBe("open");
    expect(handle.id).toBe(id);
    expect(app.layers()[0].id).toBe(id);
    expect(app.router.layerHandle(id)!.component).toBe("Users/Edit");
    expect(app.entry().layers![0].owner).toBeNull();
  });

  it("closes the stack down to the layer a deeper link named before landing", async () => {
    const app = await bench(
      users,
      byPath({ "/users/5/edit": edit, "/teams/9": teamsShow }),
    );

    app.router.visit("/users/5/edit");
    await settled();

    const [first] = app.layers();
    const second = app.router.layerHandle(first.id)!.router.layer("/teams/9");

    await settled();
    expect(components(app)).toEqual(["Users/Edit", "Teams/Show"]);

    app.router.layerHandle(first.id)!.router.visit("/users/5/edit");
    await settled();
    exitShells(app);
    await settled();

    expect(app.layers()).toEqual([first]);
    expect(second.state).toBe("closed");
  });

  it("leaves the stack alone when a refresh in place answers a layer beneath the top", async () => {
    const app = await bench(
      users,
      byPath({ "/users/5/edit": edit, "/teams/9": teamsShow }),
    );

    app.router.visit("/users/5/edit");
    await settled();

    const [first] = app.layers();
    const second = app.router.layerHandle(first.id)!.router.layer("/teams/9");

    await settled();

    const stacked = app.layers();

    app.router.layerHandle(first.id)!.router.reload({ only: ["user"] });
    await settled();
    exitShells(app);
    await settled();

    expect(app.layers()).toEqual(stacked);
    expect(second.state).toBe("open");
  });

  it("stands a layer with nowhere valid to sit on a cold base and walks to fetch it", async () => {
    const walk = gate();
    const app = await bench(
      login,
      byPath({ "/login": cold, "/users": () => walk.opened.then(() => users) }),
    );

    app.router.visit("/login");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "",
      url: "/users",
    });
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(app.entry()).toMatchObject({
      component: "Users/Edit",
      url: "/users/5/edit",
    });
    expect(app.entry()).not.toHaveProperty("layers");
    expect(app.requests.map((request) => request.path)).toEqual([
      "/login",
      "/users",
    ]);
    expect(window.location.pathname).toBe("/users/5/edit");

    walk.open();
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(app.entry().layers![0]).toMatchObject({
      component: "Users/Edit",
      standalone: true,
    });
  });

  it("promotes a layer that declares no base and cannot compose to the page", async () => {
    const app = await bench(login, byPath({ "/login": edit }));

    app.router.visit("/login");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Edit",
      url: "/users/5/edit",
    });
    expect(await app.basePage()).not.toHaveProperty("layer");
    expect(app.layers()).toEqual([]);
    expect(app.entry()).not.toHaveProperty("layers");
    expect(app.requests.map((request) => request.path)).toEqual(["/login"]);
  });
});

describe("a walk hop landing", () => {
  const cold = { ...edit, layer: { key: "Users/Edit", base: "/users" } };

  it("fills in the blank base beneath the stack", async () => {
    const walk = gate();
    const app = await bench(
      login,
      byPath({ "/login": cold, "/users": () => walk.opened.then(() => users) }),
    );

    app.router.visit("/login");
    await settled();

    const [open] = app.layers();

    expect(await app.basePage()).toMatchObject({ component: "" });

    walk.open();
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(app.layers()).toEqual([open]);
    expect(app.entry()).toMatchObject({
      component: "Users/Index",
      layers: [{ id: open.id }],
    });
  });

  it("inserts a base that is itself a layer beneath the stack and keeps walking", async () => {
    const walk = gate();
    const app = await bench(
      login,
      byPath({
        "/login": cold,
        "/users": { ...users, layer: { key: "Users/Index", base: "/" } },
        "/": () => walk.opened.then(() => page("Home", "/")),
      }),
    );

    app.router.visit("/login");
    await settled();

    expect(components(app)).toEqual(["Users/Index", "Users/Edit"]);
    expect(await app.basePage()).toMatchObject({ component: "" });
    expect(app.requests.map((request) => request.path)).toEqual([
      "/login",
      "/users",
      "/",
    ]);

    walk.open();
    await settled();

    expect(components(app)).toEqual(["Users/Index", "Users/Edit"]);
    expect(await app.basePage()).toMatchObject({ component: "Home", url: "/" });
  });
});

describe("a page response landing", () => {
  const openOver = async (routes: Parameters<typeof byPath>[0]) => {
    const app = await bench(
      users,
      byPath({ "/users/5/edit": edit, ...routes }),
    );

    app.router.visit("/users/5/edit");
    await settled();

    return app;
  };

  it("replaces the page and takes the stack with it", async () => {
    const app = await openOver({ "/teams": teamsIndex });
    const handle = app.layers()[0];

    expect(handle.component).toBe("Users/Edit");

    app.router.visit("/teams");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Teams/Index",
      url: "/teams",
    });
    expect(await app.basePage()).not.toHaveProperty("layers");
    expect(app.layers()).toEqual([]);
    expect(app.entry()).not.toHaveProperty("layers");
  });

  describe("refreshing the base", () => {
    it("a reload of the same component refreshes it", async () => {
      const app = await openOver({ "/users": users });
      const stacked = app.layers();

      app.router.reload();
      await settled();

      expect(app.requests.at(-1)).toMatchObject({ path: "/users" });
      expect(app.layers()).toEqual(stacked);
    });

    it("a reload redirected to another component does not", async () => {
      const app = await openOver({ "/users": login });

      app.router.reload();
      await settled();
      exitShells(app);
      await settled();

      expect(await app.basePage()).toMatchObject({
        component: "Auth/Login",
        url: "/login",
      });
      expect(app.layers()).toEqual([]);
    });

    it("a visit to another url of the same component does not", async () => {
      const app = await openOver({
        "/users?page=2": { ...users, url: "/users?page=2" },
      });

      app.router.visit("/users?page=2");
      await settled();
      exitShells(app);
      await settled();

      expect(await app.basePage()).toMatchObject({
        component: "Users/Index",
        url: "/users?page=2",
      });
      expect(app.layers()).toEqual([]);
    });

    it("a partial reload of the same component still refreshes it", async () => {
      const app = await openOver({ "/users": users });
      const stacked = app.layers();

      app.router.reload({ only: ["users"] });
      await settled();

      expect(app.requests.at(-1)).toMatchObject({ path: "/users" });
      expect(app.requests.at(-1)!.headers["X-Inertia-Partial-Data"]).toBe(
        "users",
      );
      expect(app.layers()).toEqual(stacked);
    });

    it("a partial reload of another url of the same component does not", async () => {
      const app = await openOver({
        "/users?search=x": { ...users, url: "/users?search=x" },
      });

      app.router.visit("/users?search=x", { only: ["users"] });
      await settled();
      exitShells(app);
      await settled();

      expect(await app.basePage()).toMatchObject({
        component: "Users/Index",
        url: "/users?search=x",
      });
      expect(app.layers()).toEqual([]);
    });
  });

  it("keeps the stack over a base a reload refreshes", async () => {
    const app = await openOver({
      "/users": { ...users, props: { errors: {}, users: [1] } },
    });
    const [open] = app.layers();

    app.router.reload();
    await settled();

    expect((await app.basePage()).props).toEqual({ errors: {}, users: [1] });
    expect(app.layers()).toEqual([open]);
  });

  it("hands errors back to a local layer submitted from the address beneath it", async () => {
    const app = await bench(
      users,
      byPath({
        "post /users": {
          ...users,
          props: { errors: { name: "Required" }, users: [] },
          flash: { note: "x" },
        },
      }),
    );
    const handle = app.router.layer({
      component: "Prompt",
      props: { step: 1 },
    });

    await settled();
    expect(app.layers()).toEqual([
      {
        id: handle.id,
        key: "Prompt",
        component: "Prompt",
        url: null,
        type: "local",
      },
    ]);

    app.router.layerHandle(handle.id)!.router.post("/users");
    await settled();

    expect(app.layers().map((open) => open.id)).toEqual([handle.id]);
    expect((await app.basePage()).props).toEqual({ errors: {} });
    expect((await app.basePage()).flash).toEqual({});
    expect(app.views()[0].page.props).toEqual({
      errors: { name: "Required" },
      step: 1,
    });
    expect(app.views()[0].page.flash).toEqual({ note: "x" });
    expect(handle.state).toBe("open");
  });
});

describe("a detour", () => {
  const prompt = page("Auth/Confirm", "/confirm", { interstitial: true });
  const card = page("Users/Edit", "/users/5/edit", {
    layer: { key: "Users/Edit" },
  });

  const detour = async (routes: Parameters<typeof byPath>[0] = {}) => {
    let asked = 0;
    const app = await bench(
      users,
      byPath({
        "/users/5/edit": () => (asked++ === 0 ? prompt : card),
        "post /confirm": prompt,
        "/teams": teamsIndex,
        ...routes,
      }),
    );
    const handle = app.router.layer("/users/5/edit");

    await settled();

    return { app, handle };
  };

  const wrongPassword = async (app: Bench) => {
    app.router.post("/confirm", { password: "wrong" });
    await settled();
  };

  it("pins the base the layer was dispatched from through the prompt", async () => {
    const { app, handle } = await detour();

    expect(await app.basePage()).toMatchObject({
      component: "Auth/Confirm",
      url: "/confirm",
    });
    expect(handle.state).toBe("pending");
    expect(app.layers()).toEqual([]);
    expect(app.written().at(-1)).toEqual(["push", "/confirm"]);
    expect(app.requests.map((request) => request.path)).toEqual([
      "/users/5/edit",
    ]);

    app.router.visit("/users/5/edit");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(app.requests.map((request) => request.path)).toEqual([
      "/users/5/edit",
      "/users/5/edit",
    ]);
  });

  it("composes the returning layer over the pinned base", async () => {
    const { app, handle } = await detour();

    await wrongPassword(app);
    expect(await app.basePage()).toMatchObject({ component: "Auth/Confirm" });
    expect(handle.state).toBe("pending");

    const writes = app.written().length;

    app.router.visit("/users/5/edit");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(app.layers()[0].id).toBe(handle.id);
    expect(handle.state).toBe("open");
    expect(app.written().slice(writes)).toEqual([["replace", "/users/5/edit"]]);
    expect(app.entry()).toMatchObject({
      component: "Users/Index",
      layers: [{ id: handle.id }],
    });

    app.router.visit("/teams");
    await settled();

    expect(await app.basePage()).toMatchObject({ component: "Teams/Index" });
    expect(app.layers()).toEqual([]);
  });

  it("is ended by any unmarked page that lands", async () => {
    const held = gate();
    const { app, handle } = await detour({
      "/held": () => held.opened.then(() => card),
    });

    app.router.visit("/held", { async: true });
    await settled();
    app.router.visit("/teams");
    await settled();

    expect(await app.basePage()).toMatchObject({ component: "Teams/Index" });
    expect(handle.state).toBe("closed");

    held.open();
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Teams/Index",
      url: "/teams",
    });
    expect(app.layers()).toEqual([]);

    app.router.visit("/users/5/edit");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Teams/Index",
      url: "/teams",
    });
    expect(components(app)).toEqual(["Users/Edit"]);
  });

  it("is kept by the prompt answering its own submit", async () => {
    const { app, handle } = await detour();

    await wrongPassword(app);
    await wrongPassword(app);

    expect(await app.basePage()).toMatchObject({ component: "Auth/Confirm" });
    expect(handle.state).toBe("pending");

    app.router.visit("/users/5/edit");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(components(app)).toEqual(["Users/Edit"]);
    expect(handle.state).toBe("open");
  });

  it("is left alone by a layer that is not the return", async () => {
    const { app, handle } = await detour({
      "/teams/1/edit": page("Teams/Edit", "/teams/1/edit", {
        layer: { key: "Teams/Edit" },
      }),
    });

    app.router.visit("/teams/1/edit");
    await settled();

    expect(await app.basePage()).toMatchObject({
      component: "Users/Index",
      url: "/users",
    });
    expect(components(app)).toEqual(["Teams/Edit"]);
    expect(app.layers()[0].id).toBe(handle.id);
    expect(handle.state).toBe("open");
  });
});
