import { existingGuestSession } from "./guest-session.js";
import { once } from "node:events";
import { Store } from "../../server/node-store.js";
import { createApp } from "../../server/app.js";
export const password = "Isolated-family-test-passphrase";
export async function application(t, env = {}, options = {}) {
  const store = new Store(),
    server = createApp({
      store,
      origin: options.origin || "http://127.0.0.1:3000",
      env,
      logger: { error: () => {} },
      ...options,
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.db.close();
  });
  const request = async (
    path,
    { method = "GET", data, cookie, version, headers = {} } = {},
  ) => {
    const r = await fetch("http://127.0.0.1:" + server.address().port + path, {
      method,
      headers: {
        Origin: options.origin || "http://127.0.0.1:3000",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(version !== undefined ? { "If-Match": String(version) } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: r.status,
      headers: r.headers,
      body: r.headers.get("content-type")?.includes("application/json")
        ? await r.json()
        : await r.text(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  };
  await store.createAdmin("admin@example.test", password);
  const admin = (
    await request("/api/login", {
      method: "POST",
      data: { email: "admin@example.test", password },
    })
  ).cookie;
  const host = async (name) => {
    store.run(
      "INSERT INTO approvals VALUES(?,?)",
      name.toLowerCase() + "@example.test",
      "synthetic",
    );
    const account = await store.register({
      email: name.toLowerCase() + "@example.test",
      password,
      name,
    });
    const household = store.household(account.household);
    const cookie = (
      await request("/api/login", {
        method: "POST",
        data: { email: name.toLowerCase() + "@example.test", password },
      })
    ).cookie;
    return { cookie, household, user: account.user };
  };
  const member = async (host, role, name) => {
    const r = await request("/api/family/members", {
      method: "POST",
      cookie: host.cookie,
      data: { name, login: name.toLowerCase(), role, password },
    });
    if (r.status !== 201)
      throw Error("Creating fixture member failed: " + r.body.error);
    const cookie = (
      await request(
        "/api/public/households/" + host.household.slug + "/members/login",
        { method: "POST", data: { login: name.toLowerCase(), password } },
      )
    ).cookie;
    return { ...r.body, cookie };
  };
  const guest = async (host, input = {}) => {
    const r = await request("/api/host/guests", {
      method: "POST",
      cookie: host.cookie,
      data: { first: "Casey", last: "Example", suffix: "", ...input },
    });
    if (r.status !== 201)
      throw Error("Creating fixture guest failed: " + r.body.error);
    return r.body;
  };
  const event = async (host, guests, input = {}) => {
    const r = await request("/api/host/events", {
      method: "POST",
      cookie: host.cookie,
      data: {
        title: "Synthetic event",
        description: "Private test",
        invited: guests.map((g) => g.id),
        menu: [],
        registries: [],
        ...input,
      },
    });
    if (r.status !== 201)
      throw Error("Creating fixture event failed: " + r.body.error);
    return r.body;
  };
  const guestLogin = async (host, guest, extra = {}) =>
    existingGuestSession(
      store,
      host.household,
      guest,
      options.origin || "http://127.0.0.1:3000",
      extra,
    );
  const record = async (host, type, input = {}) => {
    const r = await request("/api/family/records", {
      method: "POST",
      cookie: host.cookie,
      data: { type, title: "Synthetic " + type, ...input },
    });
    if (r.status !== 201)
      throw Error("Creating fixture record failed: " + r.body.error);
    return r.body;
  };
  return {
    url: "http://127.0.0.1:" + server.address().port,
    store,
    request,
    admin,
    host,
    member,
    guest,
    event,
    guestLogin,
    record,
  };
}
