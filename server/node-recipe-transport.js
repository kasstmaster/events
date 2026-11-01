import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export function isPublicAddress(value) {
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(value) === 6)
    return (
      /^2|^3/i.test(value) &&
      !/^2001:(?:0*:|db8:|0?10:|0?20:)|^2001::|^2002:/i.test(value)
    );
  return false;
}
export async function nodeRecipeTransport(value) {
  if (
    [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "ALL_PROXY",
      "all_proxy",
    ].some((key) => process.env[key])
  )
    throw new Error(
      "Public recipe import is unavailable in this proxied Node runtime. Use manual entry.",
    );
  const url = new URL(value);
  let dnsTimer;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise((_, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error("Recipe DNS timeout.")),
        10000,
      );
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("Recipe host is not a public address.");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    let deadline;
    const request = https.get(
      url,
      {
        headers: {
          Accept: "text/html, application/ld+json",
          "User-Agent": "Gather recipe importer",
        },
        lookup: (_host, options, cb) =>
          options.all
            ? cb(null, [pinned])
            : cb(null, pinned.address, pinned.family),
      },
      (response) => {
        const stream = new ReadableStream({
          start(controller) {
            let size = 0;
            response.on("data", (chunk) => {
              size += chunk.length;
              if (size > 1000000) {
                response.destroy(new Error("Recipe page too large."));
                return;
              }
              controller.enqueue(new Uint8Array(chunk));
            });
            response.on("end", () => {
              clearTimeout(deadline);
              controller.close();
            });
            response.on("error", (error) => {
              clearTimeout(deadline);
              controller.error(error);
            });
          },
          cancel() {
            clearTimeout(deadline);
            response.destroy();
          },
        });
        resolve(
          new Response(
            [204, 205, 304].includes(response.statusCode) ? null : stream,
            {
              status: response.statusCode,
              headers: Object.fromEntries(
                Object.entries(response.headers).filter(
                  ([, v]) => typeof v === "string",
                ),
              ),
            },
          ),
        );
      },
    );
    request.setTimeout(10000, () =>
      request.destroy(new Error("Recipe import timed out.")),
    );
    deadline = setTimeout(
      () => request.destroy(new Error("Recipe request timed out.")),
      10000,
    );
    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}
