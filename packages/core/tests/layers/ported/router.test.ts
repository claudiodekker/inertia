import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseGen,
  cached,
  exitShells,
  keysHeld,
  page,
  requestsOf,
  seedKeys,
  settled,
  start,
} from "./f-support";

const users = page("Users/Index", "/users", {
  props: { errors: {}, users: [] },
});
const archive = page("Users/Archive", "/users/archive");
const show = page("Users/Show", "/users/5");
const hold = () => new Promise<never>(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the base a visit is dispatched from", () => {
  it("is the page on screen", async () => {
    const app = await start(users, {
      "/users/archive": archive,
      "/users/5": hold,
    });

    app.router.visit("/users/archive");
    await settled();
    expect(app.basePage().component).toBe("Users/Archive");
    expect(baseGen(app)).toBe(1);

    app.router.visit("/users/5");
    await vi.waitFor(() => expect(requestsOf(app.router)).toHaveLength(1));

    expect(requestsOf(app.router)[0].origin).toEqual({
      kind: "base",
      top: null,
      gen: 1,
      instantGen: null,
    });
  });

  it("is the base before an instant swap replaces it", async () => {
    const app = await start(users, { "/users/5": hold });

    app.router.visit("/users/5", { component: "Users/Show" });
    await vi.waitFor(() => expect(requestsOf(app.router)).toHaveLength(1));

    expect(app.basePage().component).toBe("Users/Show");
    expect(baseGen(app)).toBe(1);
    expect(requestsOf(app.router)[0].origin).toEqual({
      kind: "base",
      top: null,
      gen: 0,
      instantGen: 1,
    });
  });

  it("is the page on screen when a prefetched response is replayed, not the one it was prefetched from", async () => {
    const app = await start(users, {
      "/users/5": show,
      "/users/archive": archive,
    });

    app.router.prefetch("/users/5", {}, { cacheFor: "30s" });
    await vi.waitFor(() => expect(cached(app)).toHaveLength(1));

    const prefetched = await cached(app)[0].response;

    expect(prefetched.origin).toEqual({
      kind: "base",
      top: null,
      gen: 0,
      instantGen: null,
    });

    app.router.visit("/users/archive");
    await settled();
    expect(baseGen(app)).toBe(1);

    app.router.visit("/users/5");

    await vi.waitFor(() =>
      expect(prefetched.origin).toEqual({
        kind: "base",
        top: null,
        gen: 1,
        instantGen: null,
      }),
    );
  });

  it("is the base before an instant swap when the response was prefetched", async () => {
    const app = await start(users, {
      "/users/5": show,
      "/users/archive": archive,
    });

    app.router.prefetch("/users/5", {}, { cacheFor: "30s" });
    await vi.waitFor(() => expect(cached(app)).toHaveLength(1));

    const prefetched = await cached(app)[0].response;

    app.router.visit("/users/archive");
    await settled();
    expect(baseGen(app)).toBe(1);

    app.router.visit("/users/5", { component: "Users/Show" });

    await vi.waitFor(() =>
      expect(prefetched.origin).toEqual({
        kind: "base",
        top: null,
        gen: 1,
        instantGen: 2,
      }),
    );
    expect(baseGen(app)).toBe(2);
  });
});

describe("clearing history", () => {
  const logout = page("Auth/Logout", "/logout", { clearHistory: true });

  it("discards the keys when the page asks", async () => {
    const app = await start(users, { "/logout": logout });

    seedKeys(app);
    app.router.visit("/logout");
    await settled();

    expect(app.basePage().component).toBe("Auth/Logout");
    expect(keysHeld(app)).toBe(false);
  });

  it("keeps them when the page does not ask", async () => {
    const app = await start(users, { "/users/5": show });

    seedKeys(app);
    app.router.visit("/users/5");
    await settled();

    expect(app.basePage().component).toBe("Users/Show");
    expect(keysHeld(app)).toBe(true);
  });

  it("leaves no pending request on the entry it writes", async () => {
    const app = await start(users, { "/logout": logout });

    app.router.visit("/logout");
    await settled();

    expect(app.written().at(-1)).toEqual(["push", "/logout"]);
    expect(app.entry().clearHistory).toBe(true);
  });

  it("does not discard them again when a client visit rewrites the page", async () => {
    const app = await start(users, { "/logout": logout });

    app.router.visit("/logout");
    await settled();
    seedKeys(app);

    await new Promise<void>((resolve) => {
      app.router.replace({
        props: { users: [{ id: 1 }] },
        onSuccess: () => resolve(),
      });
    });
    await settled();

    expect(keysHeld(app)).toBe(false);
  });

  it("still asks on a second visit, after the first one flushed its prefetch", async () => {
    const app = await start(users, { "/logout": logout });

    app.router.prefetch("/logout", {}, { cacheFor: "30s" });
    await vi.waitFor(() => expect(app.sent).toEqual(["get /logout"]));

    const visit = () =>
      new Promise<void>((resolve) =>
        app.router.visit("/logout", { onSuccess: () => resolve() }),
      );

    await visit();
    expect(cached(app)).toHaveLength(0);
    seedKeys(app);
    await visit();

    expect(app.sent).toEqual(["get /logout", "get /logout"]);
    expect(keysHeld(app)).toBe(false);
  });
});

describe("methods that never read `this` before layers", () => {
  it("still work unbound, and address the base", async () => {
    const edit = page("Users/Edit", "/users/5/edit", {
      layer: { key: "Users/Edit", base: "/users" },
    });
    const app = await start(users, { "/users/5/edit": edit });
    const handle = app.router.layer("/users/5/edit");

    await settled();

    const { remember, restore, flash } = app.router.layerHandle(
      handle.id,
    )!.router;

    expect(() => remember({ note: "x" }, "note")).not.toThrow();
    expect(restore("note")).toEqual({ note: "x" });
    expect(() => flash("message", "Saved.")).not.toThrow();
    expect(app.basePage().flash).toEqual({ message: "Saved." });
    expect(app.basePage().rememberedState).toEqual({ note: { note: "x" } });
    expect(app.views()[0].page.flash).toEqual({});
    expect(app.views()[0].page.rememberedState).toEqual({});
  });
});

describe("a pending optimistic callback", () => {
  it("is consumed by the instance it was chained on, never by a visit from another", async () => {
    const edit = page("Users/Edit", "/users/5/edit", {
      layer: { key: "Users/Edit", base: "/users" },
    });
    const app = await start(
      page("Users/Index", "/users", { props: { errors: {}, likes: 0 } }),
      {
        "/users/5/edit": edit,
        "/users": hold,
      },
    );
    const handle = app.router.layer("/users/5/edit");

    await settled();

    const first = new app.Router();
    const other = app.router.layerHandle(handle.id)!.router;

    first.optimistic((props) => ({ likes: (props.likes as number) + 1 }));
    other.visit("/users");
    await settled();

    expect(app.basePage().props.likes).toBe(0);

    first.visit("/users");
    await settled();

    expect(app.basePage().props.likes).toBe(1);
  });
});
