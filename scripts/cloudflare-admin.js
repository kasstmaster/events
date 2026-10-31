import { spawn } from "node:child_process";
import { hashPassword, email } from "../server/model.js";
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error(
    "Provide ADMIN_EMAIL and ADMIN_PASSWORD through your secure shell environment. No values will be printed.",
  );
  process.exit(1);
}
const values = {
  BOOTSTRAP_ADMIN_EMAIL: email(process.env.ADMIN_EMAIL),
  BOOTSTRAP_ADMIN_HASH: await hashPassword(process.env.ADMIN_PASSWORD),
};
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
delete env.ADMIN_PASSWORD;
delete env.ADMIN_EMAIL;
const child = spawn(
  process.execPath,
  [
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)
      .pathname,
    "secret",
    "bulk",
    "--config",
    "wrangler.jsonc",
  ],
  { env, stdio: ["pipe", "inherit", "inherit"] },
);
child.stdin.end(JSON.stringify(values));
child.on("error", () => {
  console.error("Could not start Wrangler.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
