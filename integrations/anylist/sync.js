import { openAddressBook } from "./reader.js";
import { applyContactPlan } from "./writer.js";
const origin = "https://events.kassandraraudman.workers.dev",
  syncId = process.env.SYNC_ID;
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
  if (!response.ok) throw Error("Contact sync report rejected.");
  return response.json();
}
let prepared = false;
async function run() {
  for (const key of [
    "ANYLIST_EMAIL",
    "ANYLIST_PASSWORD",
    "ANYLIST_IMPORT_SECRET",
    "SYNC_ID",
  ])
    if (!process.env[key]) throw Error("Configuration missing.");
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(syncId)) throw Error("Invalid sync ID.");
  const client = await openAddressBook({
    email: process.env.ANYLIST_EMAIL,
    password: process.env.ANYLIST_PASSWORD,
    listName: process.env.ANYLIST_LIST_NAME || "Address Book",
  });
  const snapshot = await client.read(),
    plan = await report({
      prepare: true,
      groupId: snapshot.groupId,
      addresses: snapshot.addresses,
    });
  if (plan.state === "prepared") {
    prepared = true;
    const claimed = await report({ phase: "claim" });
    if (claimed.state !== "writing")
      throw Error("Contacts changed during sync.");
    const observed = await applyContactPlan(
      client,
      snapshot,
      claimed.addresses,
    );
    const complete = await report({
      phase: "ack",
      addresses: observed.addresses,
    });
    if (complete.state !== "complete") throw Error("Sync verification failed.");
  } else if (plan.state !== "complete") throw Error("Sync did not complete.");
  console.log("Contact sync completed.");
}
// Never print contact data, credentials, transport errors or raw provider responses.
run().catch(async () => {
  try {
    await report(prepared ? { phase: "fail" } : { failed: true });
  } catch {}
  console.error(
    "Contact sync failed. Check sync status before starting a fresh sync.",
  );
  process.exitCode = 1;
});
