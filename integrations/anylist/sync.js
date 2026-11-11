import { readAddressBook } from "./reader.js";
const origin = "https://events.kassandraraudman.workers.dev";
const syncId = process.env.SYNC_ID;
async function report(data) {
  const response = await fetch(origin + "/api/integrations/anylist/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Events-Import-Secret": process.env.ANYLIST_IMPORT_SECRET,
    },
    body: JSON.stringify({ syncId, ...data }),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error("Import rejected.");
  const status = await response.json();
  if (status.state !== "complete" && !data.failed)
    throw Error("Import did not complete.");
}
async function run() {
  for (const key of [
    "ANYLIST_EMAIL",
    "ANYLIST_PASSWORD",
    "ANYLIST_IMPORT_SECRET",
    "SYNC_ID",
  ])
    if (!process.env[key]) throw Error("Configuration missing.");
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(syncId)) throw Error("Invalid sync ID.");
  const addresses = await readAddressBook({
    email: process.env.ANYLIST_EMAIL,
    password: process.env.ANYLIST_PASSWORD,
    listName: process.env.ANYLIST_LIST_NAME || "Address Book",
  });
  await report({ addresses });
  console.log("Contact sync completed.");
}
// Never print provider errors, names, addresses, passwords or raw request diagnostics.
run().catch(async () => {
  try {
    await report({ failed: true });
  } catch {}
  console.error(
    "Contact sync failed. Check configuration or start a fresh sync after resolving a conflict.",
  );
  process.exitCode = 1;
});
