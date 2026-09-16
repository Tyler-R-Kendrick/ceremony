import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

const excluded = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  excluded.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  excluded.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAuthAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !excluded.check(address, "ipv4");
  // Only global-unicast IPv6: excludes mapped IPv4, local, NAT64 and multicast.
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !excluded.check(address, "ipv6")
  );
}

const loopbackHost = (host: string) =>
  ["localhost", "127.0.0.1", "::1"].includes(host);
const denied = () => new Error("Auth endpoint is not public");
export type PublicAuthNetworkOptions = {
  allowLoopbackHttp?: boolean;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
};
const allowedAddress = (
  address: string,
  hostname: string,
  options: PublicAuthNetworkOptions,
) =>
  isPublicAuthAddress(address) ||
  (options.allowLoopbackHttp &&
    loopbackHost(hostname) &&
    ["127.0.0.1", "::1"].includes(address));

/** Supplies vetted addresses directly to the socket's lookup callback. */
export function createPublicAuthLookup(
  options: PublicAuthNetworkOptions = {},
): LookupFunction {
  const resolve =
    options.lookup ??
    ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  return (hostname, settings, callback) => {
    void resolve(hostname).then(
      (answers) => {
        if (
          !answers.length ||
          answers.some(
            (answer) => !allowedAddress(answer.address, hostname, options),
          )
        )
          return callback(denied(), "");
        const candidates = answers.filter(
          (answer) => !settings.family || answer.family === settings.family,
        );
        const first = candidates[0];
        if (!first) return callback(denied(), "");
        // These exact vetted addresses go to net/tls.connect: no second DNS lookup.
        if (settings.all) callback(null, candidates);
        else callback(null, first.address, first.family);
      },
      () => callback(denied(), ""),
    );
  };
}

/** Server-owned transport. DNS checks run inside socket creation, not before fetch. */
export function createPublicAuthFetch(
  options: PublicAuthNetworkOptions = {},
): typeof fetch {
  const dispatcher = new Agent({
    connect: { lookup: createPublicAuthLookup(options) },
  });
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      (url.protocol !== "https:" &&
        !(
          options.allowLoopbackHttp &&
          url.protocol === "http:" &&
          loopbackHost(hostname)
        )) ||
      (isIP(hostname) && !allowedAddress(hostname, hostname, options))
    )
      throw denied();
    return fetch(request, {
      dispatcher,
      redirect: "error",
    } as RequestInit & { dispatcher: Agent });
  };
}

export const publicAuthFetch = createPublicAuthFetch();
export const loopbackAuthFetch = createPublicAuthFetch({
  allowLoopbackHttp: true,
});
