import { hostOnlyMode } from "./host-model.js";
import { universalEnabled, activeEntry } from "./passwordless.js";
import { fail } from "./model.js";
export async function gatherAppAPI(ctx) {
  const { path, method, store, env, origin, selected, json, res, readAsset } =
    ctx;
  if (!path.startsWith("/api/app/")) return false;
  if (
    method !== "GET" ||
    (!hostOnlyMode(env) &&
      (!universalEnabled(env) || env.GATHER_PWA_ENABLED !== "true"))
  )
    fail(404, "Page not found.");
  if (path === "/api/app/manifest") {
    if (hostOnlyMode(env) && ctx.session?.role !== "host")
      fail(404, "Page not found.");
    const household =
      selected ||
      (hostOnlyMode(env) && ctx.session?.household
        ? store.household(ctx.session.household)
        : null);
    json(res, {
      id: "/",
      name: household?.name || "Gather",
      short_name: household?.name?.slice(0, 30) || "Gather",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: household?.design?.background || "#f3eee8",
      theme_color: household?.design?.toolbarSurface || "#294d42",
      icons: [192, 512].map((size) => ({
        src:
          "/api/app/icon?size=" +
          size +
          (hostOnlyMode(env) ? "&v=" + (household?.version || 0) : ""),
        sizes: household?.logo ? "any" : size + "x" + size,
        type:
          household?.logo?.match(/^data:(image\/(?:png|jpeg|webp));/)?.[1] ||
          "image/png",
        purpose: "any",
      })),
      description: "A place for your people",
    });
    return true;
  }
  if (path === "/api/app/icon") {
    const size =
      new URL(ctx.req.url, origin).searchParams.get("size") === "192"
        ? 192
        : 512;
    const logo = (
      selected ||
      (hostOnlyMode(env) && ctx.session?.household
        ? store.household(ctx.session.household)
        : null)
    )?.logo;
    if (
      logo &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)
    ) {
      const [head, data] = logo.split(",");
      res.writeHead(200, { "Content-Type": head.slice(5).split(";")[0] });
      res.end(Buffer.from(data, "base64"));
      return true;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(await readAsset("gather-" + size + ".png"));
    return true;
  }
  fail(404, "Page not found.");
}
