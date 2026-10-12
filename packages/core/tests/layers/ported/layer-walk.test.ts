import { describe, expect, it, vi } from "vitest";
import { compose, planBoot } from "../../../src/layers/entry";
import { settled } from "../runtime";
import { elsewhere, errorPage, layerAt, pageWith, world } from "./walk-support";

const login = pageWith({ component: "Auth/Login", url: "/login" });

const teamsEntry = () =>
  compose(
    pageWith() as never,
    [
      {
        ...(pageWith({ component: "Teams/Edit" }) as object),
        id: "layer-9",
        key: "Teams/Edit",
        type: "routed",
        owner: null,
        entries: 1,
      },
    ] as never,
    false,
  ).data;

const from = (href = "http://localhost/login") => ({ href });

describe("the walk a cold layer sends for the base beneath it", () => {
  it("opens the layer over a base that has not arrived yet", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    const base = await w.base();

    expect(base.component).toBe("");
    expect(base.url).toBe("/users");
    expect(w.layers()).toEqual([
      {
        id: w.layers()[0].id,
        key: "Users/Edit",
        component: "Users/Edit",
        url: "/users/5/edit",
        type: "routed",
      },
    ]);
    expect(w.core.layerSlot.views()[0].page.layer).toEqual({
      key: "Users/Edit",
      base: "/users",
    });

    await w.answer("/users", pageWith());

    expect(w.entry().layers).toEqual([
      expect.objectContaining({
        key: "Users/Edit",
        url: "/users/5/edit",
        standalone: true,
      }),
    ]);
  });

  it("writes the layer's address before the base beneath it has been fetched", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    const before = w.writes.length;

    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    expect(w.writes.slice(before).map(({ mode, url }) => [mode, url])).toEqual([
      ["push", "/users/5/edit"],
    ]);
  });

  it("keeps the address on the top layer even when the visit asked to preserve the url", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    const before = w.writes.length;

    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"), {
      preserveUrl: true,
    });

    expect(w.urls()).toEqual(["/users/5/edit"]);
    expect(w.keys()).toEqual(["Users/Edit"]);
    expect(w.writes.slice(before).map(({ mode, url }) => [mode, url])).toEqual([
      ["push", "/users/5/edit"],
    ]);
  });

  it("resolves a two-deep cold open in three requests, top down", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5", "Users/Show", "/users"),
        "/users": pageWith(),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    expect(w.requested).toEqual(["/login", "/users/5", "/users"]);
    expect((await w.base()).component).toBe("Users/Index");
    expect((await w.base()).url).toBe("/users");
    expect(w.keys()).toEqual(["Users/Show", "Users/Edit"]);
  });

  it("marks every layer it resolves standalone", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5", "Users/Show", "/users"),
        "/users": pageWith(),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    expect(w.entry().layers!.map((layer) => layer.standalone)).toEqual([
      true,
      true,
    ]);
  });

  it("pushes one history entry for the whole walk, however deep it goes", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5", "Users/Show", "/users"),
        "/users": pageWith(),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    expect(
      w.writes.filter(({ mode }) => mode === "push").map(({ url }) => url),
    ).toEqual(["/users/5/edit"]);
  });

  it("does not walk for a layer that declares no base at all", async () => {
    const w = await world(from());
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit"));

    expect(w.requested).toEqual(["/login"]);
    expect((await w.base()).component).toBe("Users/Edit");
    expect(w.layers()).toEqual([]);
  });

  it("does not reload the page when a hop comes back as a location visit on a new version", async () => {
    const w = await world({ ...from(), routes: { "/users": elsewhere } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    expect(w.requested).toEqual(["/login", "/users"]);
    expect(window.location.href).toBe("http://localhost/users/5/edit");
  });

  it("does not re-announce flash the base is already holding when a hop lands", async () => {
    const w = await world({
      ...from(),
      routes: { "/users": "hold", "/users/list": "hold" },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    w.router.flash("message", "Saved.");
    const announced = w.events.length;

    await w.answer("/users", layerAt("/users", "Users/Index", "/users/list"));

    expect(w.keys()).toEqual(["Users/Index", "Users/Edit"]);
    expect((await w.base()).flash).toEqual({ message: "Saved." });
    expect(w.events.slice(announced)).not.toContain("inertia:flash");
  });

  it("sends one hop for a base while a landing on the blank it is for arrives", async () => {
    const w = await world({
      ...from(),
      routes: { "/users": "hold", "/users/5/edit": "hold" },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    w.router.layerHandle()!.router.reload({ only: ["user"] });
    await vi.waitFor(() => expect(w.held.has("/users/5/edit")).toBe(true));
    await w.answer(
      "/users/5/edit",
      layerAt("/users/5/edit", "Users/Edit", "/users"),
    );

    expect(w.requested.filter((path) => path === "/users")).toHaveLength(1);
    expect((await w.base()).component).toBe("");
  });

  it("stops when the base it is sent for is already on the stack", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5", "Users/Show", "/users/5/edit"),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    expect(w.requested).toEqual(["/login", "/users/5"]);
    expect((await w.base()).component).toBe("Users/Show");
    expect((await w.base()).url).toBe("/users/5");
    expect(w.keys()).toEqual(["Users/Edit"]);
  });

  it("stops when the base it is sent for is the same url written absolutely", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt(
          "/users/5",
          "Users/Show",
          "http://localhost/users/5/edit",
        ),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    expect(w.requested).toEqual(["/login", "/users/5"]);
    expect((await w.base()).component).toBe("Users/Show");
    expect(w.keys()).toEqual(["Users/Edit"]);
  });

  it("announces the errors the layer it promoted brought", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": {
          ...layerAt("/users/5", "Users/Show", "/users/5/edit"),
          props: { errors: { team: "The team field is required." } },
        },
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    expect((await w.base()).component).toBe("Users/Show");
    expect((await w.base()).props.errors).toEqual({
      team: "The team field is required.",
    });
    expect(w.events).toContain("inertia:error");
  });

  it("does not re-announce the flash the base was holding when the walk stops", async () => {
    const w = await world({ ...from(), routes: { "/users/5": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    w.router.flash("message", "Saved.");
    const announced = w.events.length;

    await w.answer(
      "/users/5",
      layerAt("/users/5", "Users/Show", "/users/5/edit"),
    );

    expect((await w.base()).component).toBe("Users/Show");
    expect((await w.base()).flash).toEqual({});
    expect(w.events.slice(announced)).not.toContain("inertia:flash");
  });

  it("announces the flash a layer that opened over a base of its own brought", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open({
      ...layerAt("/users/5/edit", "Users/Edit", "/users"),
      flash: { message: "Saved." },
    });

    expect(w.events).toContain("inertia:flash");
  });

  it("announces the flash once, and not again as the walk fills the stack beneath it", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users": layerAt("/users", "Users/Index", "/users/list"),
        "/users/list": pageWith({
          component: "Users/List",
          url: "/users/list",
        }),
      },
    });
    await w.begin(login);
    await w.open({
      ...layerAt("/users/5/edit", "Users/Edit", "/users"),
      flash: { message: "Saved." },
    });

    expect((await w.base()).component).toBe("Users/List");
    expect(w.events.filter((type) => type === "inertia:flash")).toHaveLength(1);
  });

  it("writes the layer onto the entry, not the base the walk is still fetching", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    const [{ state }] = w.writes.filter(({ mode }) => mode === "push");

    expect(state.page.component).toBe("Users/Edit");
    expect(state.page.url).toBe("/users/5/edit");
    expect(state.page.layers).toBeUndefined();
  });

  it("writes the whole stack onto the entry once the base beneath it has arrived", async () => {
    const w = await world({ ...from(), routes: { "/users": pageWith() } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    const { mode, state } = w.writes.at(-1)!;

    expect(mode).toBe("replace");
    expect(state.page.component).toBe("Users/Index");
    expect(state.page.layers).toEqual([
      expect.objectContaining({ key: "Users/Edit" }),
    ]);
  });

  it("writes the deepest layer it has reached onto the entry as the walk goes deeper", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users": layerAt("/users", "Users/Index", "/users/list"),
        "/users/list": "hold",
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    const { mode, state } = w.writes.at(-1)!;

    expect(w.keys()).toEqual(["Users/Index", "Users/Edit"]);
    expect(mode).toBe("replace");
    expect(state.page.component).toBe("Users/Index");
    expect(state.page.layers).toEqual([
      expect.objectContaining({ key: "Users/Edit" }),
    ]);
  });

  it("opens a warm layer on top of the stack a cold open walked to", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users": pageWith(),
        "/users/5/notes": layerAt("/users/5/notes", "Notes/Edit", "/users/5"),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    w.router.visit("/users/5/notes");
    await settled();

    expect((await w.base()).component).toBe("Users/Index");
    expect(w.keys()).toEqual(["Users/Edit", "Notes/Edit"]);
    expect(w.entry().layers!.map((layer) => layer.standalone)).toEqual([
      true,
      undefined,
    ]);
  });

  it("rewrites a cold layer in place when a warm visit brings its key back", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users": pageWith(),
        "/users/5/edit": pageWith({
          component: "Users/Edit",
          url: "/users/5/edit",
          layer: { key: "Users/Edit", base: "/users" },
          props: { user: { id: 5, name: "Renamed" } },
        }),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    const [cold] = w.layers();

    w.router.visit("/users/5/edit");
    await settled();

    expect(w.layers()).toEqual([cold]);
    expect(w.entry().layers![0].standalone).toBe(true);
    expect(w.core.layerSlot.views()[0].page.props).toEqual({
      user: { id: 5, name: "Renamed" },
    });
  });

  it("does not land the entry on a layer the user has dismissed", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    await w.dismiss();

    const { mode, state } = w.writes.at(-1)!;

    expect(mode).toBe("push");
    expect(state.page.component).toBe("");
    expect(state.page.url).toBe("/users");
    expect(state.page.layers).toBeUndefined();
    expect(w.layers()).toEqual([]);
  });

  it("restores an entry the walk never filled in by promoting its layer to the page", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    const { state } = w.writes.find(({ mode }) => mode === "push")!;

    w.popstate(state);
    await settled();

    expect((await w.base()).component).toBe("Users/Edit");
    expect(w.layers()).toEqual([]);
  });

  it("never hands the adapter a blank page when a blank entry is restored", async () => {
    const w = await world({
      href: "http://localhost/users/5/edit",
      routes: { "/users": "hold" },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.dismiss();

    const captured = w.writes
      .filter(({ mode }) => mode === "push")
      .at(-1)!.state;
    const installed = w.swaps.length;

    w.popstate(captured);
    await vi.waitFor(() =>
      expect(
        w.requested.filter((path) => path === "/users").length,
      ).toBeGreaterThanOrEqual(2),
    );

    expect(w.resolved).not.toContain("");
    expect(w.swaps.slice(installed)).toEqual([
      { component: "Blank", preserveState: false },
    ]);

    await w.answer("/users", pageWith());

    expect((await w.base()).component).toBe("Users/Index");
  });

  it("restores a composed entry as it was written, not as a re-request", async () => {
    const w = await world(from());
    await w.begin(login);

    w.popstate({ page: teamsEntry() });
    await settled();

    expect((await w.base()).component).toBe("Users/Index");
    expect(w.keys()).toEqual(["Teams/Edit"]);
    expect(w.requested).toEqual([]);
  });

  it("recovers a blank restore on an old version through missingHistoryItem, never rendering the blank", async () => {
    const w = await world({
      href: "http://localhost/users",
      routes: {
        "/users": pageWith({
          component: "Users/List",
          url: "/users",
          version: "v1",
        }),
      },
    });
    await w.begin(
      pageWith({ component: "Users/Index", url: "/users", version: "v2" }),
    );
    const visit = vi.spyOn(w.router, "visit");

    w.popstate({
      page: pageWith({ component: "", url: "/users", version: "v1" }),
    });
    await settled();

    expect(visit).toHaveBeenCalledWith("http://localhost/users", {
      preserveState: true,
      preserveScroll: true,
      replace: true,
    });
    expect(w.swaps).not.toContainEqual(
      expect.objectContaining({ component: "" }),
    );
    expect(w.resolved).not.toContain("");
    expect((await w.base()).component).toBe("Users/List");
  });

  it("drops a hop that lands after the user has navigated away", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users": "hold",
        "/dashboard": pageWith({ component: "Dashboard", url: "/dashboard" }),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    w.router.visit("/dashboard");
    await settled();
    await w.answer("/users", pageWith());

    expect((await w.base()).component).toBe("Dashboard");
    expect(w.layers()).toEqual([]);
  });

  it("drops a hop that lands after the user has gone back", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    w.popstate({ page: login });
    await settled();
    await w.answer("/users", pageWith());

    expect((await w.base()).component).toBe("Auth/Login");
    expect(w.layers()).toEqual([]);
  });

  it("asks for the base beneath it with the version the layer arrived on", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(
      pageWith({ component: "Auth/Login", url: "/login", version: "v0" }),
    );
    await w.open({
      ...layerAt("/users/5/edit", "Users/Edit", "/users"),
      version: "v1",
    });

    expect(w.headers.get("/users")!["X-Inertia-Version"]).toBe("v1");
  });

  it("lands on the layer it has when a hop comes back as an error page", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    expect((await w.base()).component).toBe("Users/Edit");
    expect((await w.base()).url).toBe("/users/5/edit");
    expect(w.layers()).toEqual([]);
    expect(w.overlay).not.toHaveBeenCalled();
  });

  it("lands on the layer it has when a hop is answered by an error page the application rendered", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError("Request failed with status code 500", {
        status: 500,
        data: JSON.stringify(
          pageWith({
            component: "Error",
            url: "/users",
            props: { status: 500 },
          }),
        ),
        headers: { "x-inertia": "true" },
      }),
    );

    expect((await w.base()).component).toBe("Users/Edit");
    expect(w.layers()).toEqual([]);
  });

  it("lands on the layer it has when a hop never answers", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.refuse(
      "/users",
      new w.errors.HttpNetworkError("Network Error", "http://localhost/users"),
    );

    expect((await w.base()).component).toBe("Users/Edit");
    expect(w.layers()).toEqual([]);
  });

  it("lands on the deepest layer it resolved when a hop further down fails", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5", "Users/Show", "/users"),
        "/users": "hold",
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    expect((await w.base()).component).toBe("Users/Show");
    expect(w.keys()).toEqual(["Users/Edit"]);
  });

  it("still composes a visit made from inside the stack when a failed hop lands", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5", "Users/Show", "/users"),
        "/users": "hold",
        "/users/5/edit": "hold",
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    w.router.visit("/users/5/edit", { method: "put" });
    await vi.waitFor(() => expect(w.held.has("/users/5/edit")).toBe(true));

    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );
    expect((await w.base()).component).toBe("Users/Show");
    await w.answer(
      "/users/5/edit",
      layerAt("/users/5/edit", "Users/Edit", "/users/5"),
    );

    expect((await w.base()).component).toBe("Users/Show");
    expect(w.keys()).toEqual(["Users/Edit"]);
  });

  it("does not land a failed hop on a stack the user went back to", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    w.popstate({ page: teamsEntry() });
    await settled();
    expect((await w.base()).component).toBe("Users/Index");
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    expect((await w.base()).component).toBe("Users/Index");
    expect(w.keys()).toEqual(["Teams/Edit"]);
  });

  it("does not land a location-answered hop on a stack the user went back to", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    w.popstate({ page: teamsEntry() });
    await settled();
    expect((await w.base()).component).toBe("Users/Index");
    await w.answer("/users", elsewhere);

    expect((await w.base()).component).toBe("Users/Index");
    expect(w.keys()).toEqual(["Teams/Edit"]);
  });

  it("lands on the entry the stack was already written to", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    const before = w.writes.length;
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    expect((await w.base()).component).toBe("Users/Edit");
    expect(
      w.writes
        .slice(before)
        .filter(({ mode }) => mode === "push")
        .map(({ url }) => url),
    ).toEqual(["/users/5/edit"]);
  });

  it("lands without remounting the stack above it or moving the scroll", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5", "Users/Show", "/users"),
        "/users": "hold",
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    const above = w.core.layerSlot.views().at(-1)!;
    const scrollTo = vi.spyOn(window, "scrollTo");
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    expect((await w.base()).component).toBe("Users/Show");
    expect(w.swaps.at(-1)).toEqual({
      component: "Users/Show",
      preserveState: false,
    });
    expect(w.core.layerSlot.views()).toEqual([
      expect.objectContaining({ id: above.id, renderKey: above.renderKey }),
    ]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("installs the base via a re-request when the stack it was walking for has been closed", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.dismiss();

    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );
    await vi.waitFor(() =>
      expect(w.requested.filter((path) => path === "/users")).toHaveLength(2),
    );
    await w.answer("/users", pageWith());

    expect(w.swaps.at(-1)).toEqual({
      component: "Users/Index",
      preserveState: true,
    });
    expect((await w.base()).component).toBe("Users/Index");
  });

  it("re-requests the blank base the closed layer was standing on, replacing its entry", async () => {
    const w = await world({
      href: "http://localhost/users/5/edit",
      routes: { "/users": "hold" },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.dismiss();

    const installed = w.swaps.length;
    const pushes = w.writes.filter(({ mode }) => mode === "push").length;
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );
    await vi.waitFor(() =>
      expect(w.requested.filter((path) => path === "/users")).toHaveLength(2),
    );
    await w.answer("/users", pageWith());

    const base = await w.base();

    expect(base.component).toBe("Users/Index");
    expect(base.props).toEqual({ users: [] });
    expect(base.url).toBe("/users");
    expect(w.swaps.slice(installed)).toEqual([
      { component: "Users/Index", preserveState: true },
    ]);
    expect(w.writes.filter(({ mode }) => mode === "push")).toHaveLength(pushes);
    expect(w.writes.at(-1)!.mode).toBe("replace");
    expect(w.writes.at(-1)!.state.page.component).toBe("Users/Index");
    expect(w.writes.at(-1)!.state.page.layers).toBeUndefined();
  });

  it("does not resurrect a layer that is mid-close when its hop fails, and re-requests the base", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    const closing = w.router.close();
    await settled();

    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    expect((await w.base()).component).toBe("");

    await vi.waitFor(() =>
      expect(w.requested.filter((path) => path === "/users")).toHaveLength(2),
    );
    await w.answer("/users", pageWith());

    const base = await w.base();

    expect(base.component).toBe("Users/Index");
    expect(base.url).toBe("/users");
    expect(w.core.layerSlot.views().map((view) => view.shell.open)).toEqual([
      false,
    ]);
    expect(w.core.layerSlot.topPage()).toBeNull();

    w.routes.set("/users", pageWith());
    w.exit();
    await closing;
    await settled();

    expect(w.layers()).toEqual([]);
    expect((await w.base()).component).toBe("Users/Index");
  });

  it("shows the error dialog when the recovery re-request itself fails", async () => {
    const w = await world({ ...from(), routes: { "/users": "hold" } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.dismiss();

    const installed = w.swaps.length;
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );
    await vi.waitFor(() =>
      expect(w.requested.filter((path) => path === "/users")).toHaveLength(2),
    );
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    await vi.waitFor(() => expect(w.overlay).toHaveBeenCalled());

    expect(w.swaps.slice(installed)).toHaveLength(0);
    expect((await w.base()).component).toBe("");
  });

  it("does not land a failed hop into a stack the user has already left", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users": "hold",
        "/dashboard": pageWith({ component: "Dashboard", url: "/dashboard" }),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    const visit = vi.spyOn(w.router, "visit");

    w.router.visit("/dashboard");
    await settled();
    await w.refuse(
      "/users",
      new w.errors.HttpResponseError(
        "Request failed with status code 500",
        errorPage,
      ),
    );

    expect((await w.base()).component).toBe("Dashboard");
    expect(w.layers()).toEqual([]);
    expect(visit).toHaveBeenCalledTimes(1);
  });

  it("records the url a redirected hop answered from on the layer it inserts", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users/5": layerAt("/users/5?tab=profile", "Users/Show", "/users"),
        "/users": pageWith(),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users/5"));

    expect((await w.base()).component).toBe("Users/Index");
    expect(w.urls()).toEqual(["/users/5?tab=profile", "/users/5/edit"]);
  });

  it("walks on from the page a hop was redirected to", async () => {
    const w = await world({
      ...from(),
      routes: {
        "/users": {
          status: 409,
          data: "",
          headers: { "x-inertia-redirect": "http://localhost/users/list" },
        },
        "/users/list": pageWith({ url: "/users/list" }),
      },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    expect(w.requested).toEqual(["/login", "/users", "/users/list"]);
    expect((await w.base()).component).toBe("Users/Index");
    expect((await w.base()).url).toBe("/users/list");
    expect(w.keys()).toEqual(["Users/Edit"]);
  });

  it("keeps walking for the base a layer closed mid-walk was standing on", async () => {
    const w = await world({
      ...from(),
      routes: { "/users": "hold", "/users/list": "hold" },
    });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));
    await w.dismiss();

    await w.answer("/users", layerAt("/users", "Users/Index", "/users/list"));
    await vi.waitFor(() => expect(w.held.has("/users/list")).toBe(true));
    await w.answer(
      "/users/list",
      pageWith({ component: "Users/List", url: "/users/list" }),
    );

    expect((await w.base()).component).toBe("Users/List");
    expect(w.keys()).toEqual(["Users/Index"]);
  });

  it("leaves an open stack alone when a background visit is answered on a new version", async () => {
    const w = await world({
      href: "http://localhost/users",
      routes: {
        "/teams/edit": layerAt("/teams/edit", "Teams/Edit", "/users"),
        "/teams": elsewhere,
      },
    });
    await w.begin(pageWith());
    w.router.layer("/teams/edit");
    await settled();
    expect(w.keys()).toEqual(["Teams/Edit"]);

    await new Promise<void>((resolve) =>
      w.router.visit("/teams", { async: true, onFinish: () => resolve() }),
    );
    await settled();

    expect((await w.base()).component).toBe("Users/Index");
    expect(w.keys()).toEqual(["Teams/Edit"]);
  });

  it("lands on the layer it has when a hop is answered on a new version", async () => {
    const w = await world({ ...from(), routes: { "/users": elsewhere } });
    await w.begin(login);
    await w.open(layerAt("/users/5/edit", "Users/Edit", "/users"));

    expect((await w.base()).component).toBe("Users/Edit");
    expect(w.layers()).toEqual([]);
    expect(window.location.href).toBe("http://localhost/users/5/edit");
  });

  describe("when the layer arrives on the initial page", () => {
    const document = "http://localhost/users/5/edit";

    it("opens the layer over a base that has not arrived yet, and sends for it", async () => {
      const w = await world({ href: document, routes: { "/users": "hold" } });
      const plan = await w.boot(
        layerAt("/users/5/edit", "Users/Edit", "/users"),
      );

      const base = await w.base();

      expect(base.component).toBe("");
      expect(base.url).toBe("/users");
      expect(w.layers()).toEqual([
        {
          id: w.layers()[0].id,
          key: "Users/Edit",
          component: "Users/Edit",
          url: "/users/5/edit",
          type: "routed",
        },
      ]);
      expect(plan.walkTo).toBe("/users");
      expect(w.requested).toEqual(["/users"]);

      await w.answer("/users", pageWith());

      expect(w.entry().layers).toEqual([
        expect.objectContaining({
          key: "Users/Edit",
          url: "/users/5/edit",
          standalone: true,
        }),
      ]);
    });

    it("walks on down to the page the chain stands on", async () => {
      const w = await world({
        href: document,
        routes: {
          "/users": layerAt("/users", "Users/Index", "/users/list"),
          "/users/list": pageWith({
            component: "Users/List",
            url: "/users/list",
          }),
        },
      });
      await w.boot(layerAt("/users/5/edit", "Users/Edit", "/users"));

      expect(w.requested).toEqual(["/users", "/users/list"]);
      expect((await w.base()).component).toBe("Users/List");
      expect(w.keys()).toEqual(["Users/Index", "Users/Edit"]);
    });

    it("writes the layer's address onto the entry the document arrived on", async () => {
      const w = await world({ href: document, routes: { "/users": "hold" } });
      await w.boot(layerAt("/users/5/edit", "Users/Edit", "/users"));

      expect(w.writes.filter(({ mode }) => mode === "push")).toEqual([]);
      expect(w.writes.map(({ mode, url }) => [mode, url])).toContainEqual([
        "replace",
        "/users/5/edit",
      ]);
    });

    it("keeps the hash the browser is on when the router is initialised without the app factory", async () => {
      const w = await world({ href: "http://localhost/users#profile" });
      await w.begin(pageWith());

      expect((await w.base()).url).toBe("/users#profile");
    });

    it("renders a layer that declares no base as an ordinary page", async () => {
      const w = await world({ href: document });
      await w.boot(layerAt("/users/5/edit", "Users/Edit"));

      const base = await w.base();

      expect(base.component).toBe("Users/Edit");
      expect(base.url).toBe("/users/5/edit");
      expect(w.layers()).toEqual([]);
      expect(base.layer).toBeUndefined();
      expect(w.requested).toEqual([]);
    });

    it("lands on the layer it opened when the base beneath it cannot be fetched", async () => {
      const w = await world({ href: document, routes: { "/users": "hold" } });
      await w.boot(layerAt("/users/5/edit", "Users/Edit", "/users"));
      await w.refuse(
        "/users",
        new w.errors.HttpNetworkError(
          "Network Error",
          "http://localhost/users",
        ),
      );

      const base = await w.base();

      expect(base.component).toBe("Users/Edit");
      expect(base.url).toBe("/users/5/edit");
      expect(w.layers()).toEqual([]);
    });

    it("opens a layer the return leg of a location visit arrived with", async () => {
      const w = await world({ href: document, routes: { "/users": "hold" } });
      w.session.set(
        "inertiaLocationVisit",
        JSON.stringify({ preserveScroll: false }),
      );
      await w.boot(layerAt("/users/5/edit", "Users/Edit", "/users"));

      await vi.waitFor(() => expect(w.layers()).toHaveLength(1));
      expect((await w.base()).component).toBe("");
      expect(w.keys()).toEqual(["Users/Edit"]);
      expect(w.requested).toEqual(["/users"]);
    });

    it("writes the layer onto the entry while the base beneath it has not arrived", async () => {
      const w = await world({ href: document, routes: { "/users": "hold" } });
      await w.boot(layerAt("/users/5/edit", "Users/Edit", "/users"));

      const { state } = w.writes.at(-1)!;

      expect(state.page.component).toBe("Users/Edit");
      expect(state.page.layers).toBeUndefined();
    });

    it("creates the same layer id on every initial page, so the server and client agree", () => {
      const first = planBoot(
        layerAt("/users/5/edit", "Users/Edit", "/users") as never,
        "",
      );
      const second = planBoot(
        layerAt("/users/5/edit", "Users/Edit", "/users") as never,
        "",
      );

      expect(first.seeds.map((seed) => seed.row.id)).toEqual([
        "layer-boot-zyavpb",
      ]);
      expect(second.seeds.map((seed) => seed.row.id)).toEqual([
        "layer-boot-zyavpb",
      ]);
    });

    it("installs an initial page that is not a layer exactly as it arrived", async () => {
      const w = await world({ href: document });
      const plan = await w.boot(pageWith());

      expect(plan.base).toEqual(
        pageWith({ flash: {}, rescuedProps: [], rememberedState: {} }),
      );
      expect(await w.base()).toEqual({
        ...pageWith(),
        flash: {},
        rescuedProps: [],
        rememberedState: {},
      });
      expect(w.requested).toEqual([]);
    });
  });
});
