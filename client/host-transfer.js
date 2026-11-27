// Thin orchestration only. All authority/browser binding remains in the existing API.
export async function hostTransfer(
  fragment,
  { post, home, navigate, replace, origin },
) {
  const values = new URLSearchParams(fragment.replace(/^#/, ""));
  const source = values.get("host-transfer-start"),
    request = values.get("host-transfer-request"),
    credential = values.get("host-transfer");
  if (values.get("host") === "complete" && home) {
    const response = await home();
    if (!response.ok) return { handled: false };
    const target = new URL(response.body.home),
      local = (u) => /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(u);
    if (
      (target.protocol !== "https:" &&
        !(local(origin) && local(target.origin))) ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    )
      throw Error("Household destination is unavailable.");
    if (target.origin === origin) {
      replace("/");
      return { handled: false, completed: true };
    }
    navigate(
      target.origin +
        "/signin#host-transfer-start=" +
        encodeURIComponent(origin),
    );
    return { handled: true };
  }
  if (!source && !request && !credential) return { handled: false };
  const send = async (action, data) => {
    const result = await post("/api/host-auth/handoff/" + action, data);
    if (!result.ok) {
      if (action === "authorize" && result.status === 401) return null;
      throw Error("Household transfer is unavailable.");
    }
    return result.body;
  };
  const go = (body) => {
    const url = new URL(body.url);
    const local = (u) =>
      /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(u);
    if (
      (url.protocol !== "https:" && !(local(origin) && local(url.origin))) ||
      url.username ||
      url.password ||
      url.pathname !== "/signin" ||
      url.search ||
      !/^#host-transfer(?:-request=[A-Za-z0-9_-]{43}|=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43})$/.test(
        url.hash,
      )
    )
      throw Error("Household transfer destination is unavailable.");
    navigate(url.href);
    return { handled: true };
  };
  if (source) return go(await send("prepare", { source }));
  if (request) {
    const response = await send("authorize", { request });
    return response ? go(response) : { handled: false };
  }
  const parts = credential.split(".");
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_-]{43}$/.test(p)))
    throw Error("Household transfer expired.");
  const response = await send("redeem", { request: parts[0], token: parts[1] });
  replace(response.next === "account" ? "/?account=1" : "/");
  return { handled: false, redeemed: true };
}
