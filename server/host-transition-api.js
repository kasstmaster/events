import { ensureHostRoster } from "./host-roster.js";
import { createHash } from "node:crypto";
import { fail } from "./model.js";
import { confirmAdministrator, auditAccount } from "./account-management.js";
import {
  addressBookCheckpoint,
  isolateAddressBook,
} from "./recipient-isolation.js";
import {
  publicEventReference,
  recipientHouseholdID,
} from "./public-invitations.js";
import { hostSignupEnabled } from "./host-signup.js";
import { revokeUserSessions } from "./device-sessions.js";
const P = "platform";
export function hostTransitionPlan(store) {
  const households = store
    .all("SELECT id,household FROM records WHERE kind='household'")
    .map((row) => store.household(row.household))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((house) => {
      const users = store.all(
        "SELECT id,email,role FROM users WHERE household=? AND role='host' ORDER BY id",
        house.id,
      );
      const owner =
        store.one("SELECT owner FROM family_owners WHERE household=?", house.id)
          ?.owner ||
        store.one(
          "SELECT id FROM users WHERE household=? AND role='host'",
          house.id,
        )?.id;
      const checkpoint = addressBookCheckpoint(store, house.id);
      return {
        id: house.id,
        name: house.name,
        owner,
        users,
        contacts: checkpoint.snapshot.guests.length,
        fingerprint: checkpoint.fingerprint,
        events: store
          .list("event", house.id)
          .map(({ id, version }) => ({ id, version }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    });
  return {
    households,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(households))
      .digest("hex"),
  };
}
export async function hostTransitionAPI(ctx) {
  const { path, method, req, res, store, env, session, body, json } = ctx;
  if (path !== "/api/admin/host-transition") return false;
  if (!hostSignupEnabled(env)) fail(404, "Page not found.");
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  await confirmAdministrator(store, session, input.password);
  if (input.operation !== "prepare") {
    json(res, hostTransitionPlan(store));
    return true;
  }
  if (
    input.confirm !== "PREPARE HOST-ONLY TRANSITION" ||
    !Array.isArray(input.approvedAdults)
  )
    fail(400, "Confirm the reviewed host transition and adult accounts.");
  const result = store.transaction(() => {
    const plan = hostTransitionPlan(store);
    if (plan.fingerprint !== input.fingerprint)
      fail(409, "Household data changed. Review the transition again.");
    const allowed = new Set(
      plan.households.flatMap((house) => house.users.map((u) => u.id)),
    );
    if (
      input.approvedAdults.some((key) => !allowed.has(key)) ||
      plan.households.some(
        (house) => house.owner && !input.approvedAdults.includes(house.owner),
      )
    )
      fail(
        400,
        "Approve each existing owner and only reviewed adult host accounts.",
      );
    if (
      input.approvedAdults.some(
        (user) =>
          store.one("SELECT role FROM family_members WHERE id=?", user)
            ?.role === "kid",
      )
    )
      fail(
        400,
        "Child accounts require a separately reviewed adulthood transition.",
      );
    const existing = store.get(
      "host-transition-checkpoint",
      plan.fingerprint,
      P,
    );
    if (!existing)
      store.put("host-transition-checkpoint", plan.fingerprint, P, {
        plan,
        actor: session.user,
        at: Date.now(),
      });
    for (const house of plan.households) {
      isolateAddressBook(store, house.id, house.fingerprint, session.user);
      ensureHostRoster(store, house.id);
      for (const user of house.users) {
        const previous = store.get("host-membership", user.id, house.id),
          enabled = input.approvedAdults.includes(user.id);
        store.put(
          "host-membership",
          user.id,
          house.id,
          {
            ...(previous || {}),
            enabled,
            adult: true,
            approvedBy: session.user,
          },
          previous?.version,
        );
        if (!enabled) revokeUserSessions(store, user.id);
      }
      for (const person of store
        .list("guest", house.id)
        .filter((p) => !p.parent))
        recipientHouseholdID(store, house.id, person.id);
      for (const event of house.events)
        publicEventReference(store, house.id, event.id);
    }
    auditAccount(store, session.user, "host-model", "transition-prepared", [
      "host-owned-address-books",
      "printed-id-reissuance-required",
    ]);
    return {
      prepared: true,
      fingerprint: plan.fingerprint,
      households: plan.households.length,
      requiresPrintedIDReissuance: true,
    };
  });
  json(res, result);
  return true;
}
