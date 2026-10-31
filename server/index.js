import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Store } from "./node-store.js";
import { createApp } from "./app.js";
const port = Number(process.env.PORT || 3000),
  host = process.env.HOST || "127.0.0.1";
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
if (process.env.NODE_ENV === "production" && !origin.startsWith("https://"))
  throw new Error("Production requires an HTTPS APP_ORIGIN.");
const dbPath = resolve(process.env.DATABASE_PATH || "var/events.sqlite");
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new Store(dbPath);
const app = createApp({ store, origin });
app.listen(port, host, () => console.log(`Events listening on ${origin}`));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    app.close(() => {
      store.db.close();
      process.exit(0);
    }),
  );
