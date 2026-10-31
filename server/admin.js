import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Store } from "./model.js";
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error(
    "Set ADMIN_EMAIL and ADMIN_PASSWORD through your secure shell environment. Password must have at least 12 characters. No emails are sent.",
  );
  process.exit(1);
}
const path = resolve(process.env.DATABASE_PATH || "var/events.sqlite");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const store = new Store(path);
try {
  await store.createAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  console.log("Administrator created. Sign in using Host Login.");
} catch (error) {
  console.error(
    error.code?.startsWith("ERR_SQLITE")
      ? "That administrator email already exists."
      : error.message,
  );
  process.exitCode = 1;
} finally {
  store.db.close();
}
