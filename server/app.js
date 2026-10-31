import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Store } from "./node-store.js";
import { createHandler } from "./handler.js";
export function createApp({ store = new Store(), ...options } = {}) {
  return createServer(
    createHandler({
      store,
      readAsset: (file) =>
        readFile(new URL(`../public/${file}`, import.meta.url)),
      ...options,
    }),
  );
}
