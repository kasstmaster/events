import assert from "node:assert/strict";
// Complete only synthetic accounts; no provider is configured or contacted.
export async function enrollGuest(origin, cookie, username) {
  const request = async (path, data, version) => {
    const response = await fetch(origin + path, {
      method: data ? "PUT" : "GET",
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(data
          ? { "Content-Type": "application/json", "If-Match": String(version) }
          : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    assert.ok(response.ok, `Synthetic account enrollment: ${response.status}`);
    return response.json();
  };
  const data = await request("/api/personal");
  if (!data.account.needsUsername) return;
  await request(
    "/api/personal/account",
    { username, recoveryPhone: "+15005550123" },
    data.account.version,
  );
}
export async function completeGuestSetup(
  page,
  username,
  phone = "+15005550123",
) {
  // Existing authorized migration sessions no longer require username enrollment.
  await page.locator(".home-invitations,.empty").waitFor();
}
