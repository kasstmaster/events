import { Buffer } from "node:buffer";
import { fail, text } from "./model.js";
export function publicRecipeURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(400, "Enter a public HTTPS recipe URL.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
    /^\[|^[\d.]+$/.test(host)
  )
    fail(
      400,
      "Use a public HTTPS recipe website, without credentials or IP addresses.",
    );
  url.hash = "";
  return url;
}
const plain = (value) =>
  (typeof value === "string" ? value : "")
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:nbsp|amp|lt|gt|quot);/g,
      (v) =>
        ({
          "&nbsp;": " ",
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
        })[v],
    )
    .trim();
export async function importRecipe(value, transport) {
  if (!transport)
    fail(503, "Recipe import is unavailable here. Enter the recipe manually.");
  let url = publicRecipeURL(value),
    response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await transport(url.href);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || attempt === 3)
        fail(400, "The recipe redirected too many times. Use manual entry.");
      url = publicRecipeURL(new URL(location, url).href);
      continue;
    }
    break;
  }
  if (
    !response.ok ||
    !/text\/html|application\/ld\+json/i.test(
      response.headers.get("content-type") || "",
    )
  )
    fail(400, "This site cannot be imported. Use manual entry.");
  if (Number(response.headers.get("content-length") || 0) > 1000000)
    fail(413, "Recipe page is too large.");
  let size = 0,
    chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1000000) {
      await response.body.cancel?.().catch(() => {});
      fail(413, "Recipe page is too large.");
    }
    chunks.push(chunk);
  }
  const source = new TextDecoder().decode(Buffer.concat(chunks)),
    objects = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    if ([value["@type"]].flat().includes("Recipe")) objects.push(value);
    if (value["@graph"]) walk(value["@graph"]);
  };
  for (const match of source.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      walk(JSON.parse(match[1]));
    } catch {}
  }
  if (
    !objects.length &&
    /application\/ld\+json/i.test(response.headers.get("content-type") || "")
  ) {
    try {
      walk(JSON.parse(source));
    } catch {}
  }
  const recipe = objects[0];
  if (!recipe)
    fail(422, "No supported structured recipe was found. Use manual entry.");
  const instructions = (value) =>
    Array.isArray(value)
      ? value.flatMap(instructions)
      : typeof value === "string"
        ? [plain(value)]
        : value?.itemListElement
          ? instructions(value.itemListElement)
          : value?.text
            ? [plain(value.text)]
            : [];
  return {
    title: text(plain(recipe.name), 200, true),
    ingredients: (Array.isArray(recipe.recipeIngredient)
      ? recipe.recipeIngredient
      : []
    )
      .filter((value) => typeof value === "string")
      .map(plain)
      .join("\n")
      .slice(0, 20000),
    instructions: instructions(recipe.recipeInstructions)
      .join("\n")
      .slice(0, 30000),
    source: url.href,
    notes: "",
    reviewRequired: true,
  };
}
