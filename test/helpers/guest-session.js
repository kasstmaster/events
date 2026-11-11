import { authenticateGuest } from "../../server/guest-identities.js";
// Model an already authorized pre-migration browser, never a public login bypass.
// New-browser authentication is exercised through the real OTP API in guest-auth.test.js.
export function existingGuestSession(
  store,
  household,
  guest,
  origin,
  extra = {},
) {
  let result;
  try {
    result = authenticateGuest(store, {
      first: guest.first,
      last: guest.last,
      suffix: guest.suffix,
      inviteCode: guest.inviteCode,
      ...extra,
    });
  } catch (error) {
    if (error.status === 401) return { status: 401 };
    throw error;
  }
  if (!result?.relation) return { status: 401 };
  const session = store.newSession(
    {
      household: result.relation.household,
      guest: result.relation.guest,
      identity: result.identity.id,
      entryHousehold: household.id,
      role: "guest",
    },
    origin,
  );
  const secure = origin.startsWith("https:");
  const cookie = `${secure ? "__Host-events_session" : "events_session"}=${session.token}`;
  return {
    status: 200,
    cookie,
    body: { ok: true },
    headers: new Headers({
      "set-cookie":
        cookie +
        `; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`,
    }),
  };
}
export async function existingGuestBrowser(
  page,
  store,
  household,
  guest,
  origin,
) {
  const { identityFor } = await import("../../server/guest-identities.js");
  const identity = identityFor(store, guest, household.id).id;
  const session = store.newSession(
    { role: "guest", guest: guest.id, household: household.id, identity },
    origin,
  );
  await page
    .context()
    .addCookies([
      { name: "events_session", value: session.token, url: origin },
    ]);
  await page.goto(origin);
  await page.locator(".home-invitations,.empty").waitFor();
}
