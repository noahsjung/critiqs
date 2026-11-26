import { describe, expect, test } from "bun:test";
import { inCidr, isAllowedAddress, isBlockedHost, isPublicAddress, parseCidr, type PublicWebPolicy, type ResolvedAddress, resolvePublicAddress } from "../src/public-web.ts";

// The caller policy on top of the public-address rule: what the review-link
// proxy refuses beyond private addresses. The address check passes no policy,
// so its behavior is unchanged (address-check.test.ts).

const proxy: PublicWebPolicy = {
  blockedHosts: ["critiqs-review.net", "critiqs.app", "brazen-snail-591.convex.site"],
  blockedCidrs: ["203.0.113.10/32", "8.8.8.0/24", "2001:4860::/32"],
  denyTransitionIpv6: true,
};

describe("parseCidr and inCidr", () => {
  test("IPv4 and IPv6 blocks", () => {
    expect(parseCidr("8.8.8.0/24")).toEqual({ family: 4, value: 0x08080800n, bits: 24 });
    expect(parseCidr("2001:db8::/32")?.bits).toBe(32);
    expect(parseCidr("8.8.8.8")?.bits).toBe(32);
    for (const bad of ["8.8.8.0/33", "2001:db8::/129", "8.8.8/24", "x/8", "8.8.8.0/24/1", "8.8.8.0/-1", ""]) expect(parseCidr(bad)).toBeNull();
    expect(inCidr("8.8.8.200", parseCidr("8.8.8.0/24")!)).toBe(true);
    expect(inCidr("8.8.9.1", parseCidr("8.8.8.0/24")!)).toBe(false);
    expect(inCidr("2001:4860:4860::8888", parseCidr("2001:4860::/32")!)).toBe(true);
    expect(inCidr("2001:4861::1", parseCidr("2001:4860::/32")!)).toBe(false);
    // Families never match each other.
    expect(inCidr("8.8.8.8", parseCidr("::/0")!)).toBe(false);
    expect(inCidr("1.2.3.4", parseCidr("0.0.0.0/0")!)).toBe(true);
  });
});

describe("isAllowedAddress", () => {
  test("without a policy it is the public rule", () => {
    for (const address of ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c", "64:ff9b::5db8:d70e", "2002:5db8:d70e::"]) expect(isAllowedAddress(address)).toBe(isPublicAddress(address));
    for (const address of ["127.0.0.1", "::1", "10.0.0.1", "169.254.169.254", "fd7a:115c:a1e0::1"]) expect(isAllowedAddress(address)).toBe(false);
  });

  test("the proxy refuses its own egress blocks and IPv6 transition addresses", () => {
    expect(isAllowedAddress("93.184.215.14", proxy)).toBe(true);
    expect(isAllowedAddress("8.8.8.8", proxy)).toBe(false);
    expect(isAllowedAddress("2001:4860:4860::8888", proxy)).toBe(false);
    // Public IPv4 inside NAT64 and 6to4: allowed by the public rule, refused by the proxy.
    expect(isPublicAddress("64:ff9b::5db8:d70e")).toBe(true);
    expect(isAllowedAddress("64:ff9b::5db8:d70e", proxy)).toBe(false);
    expect(isPublicAddress("2002:5db8:d70e::")).toBe(true);
    expect(isAllowedAddress("2002:5db8:d70e::", proxy)).toBe(false);
  });

  test("a policy block that doesn't parse refuses everything", () => {
    expect(isAllowedAddress("93.184.215.14", { blockedCidrs: ["not a block"] })).toBe(false);
  });
});

describe("isBlockedHost", () => {
  test("a name, every name under it, without case or a trailing dot", () => {
    for (const host of ["critiqs-review.net", "v-abc.critiqs-review.net", "CRITIQS.APP", "critiqs.app.", "www.critiqs.app", "brazen-snail-591.convex.site"]) expect(isBlockedHost(host, proxy)).toBe(true);
    for (const host of ["notcritiqs.app", "critiqs.app.evil.example", "convex.site", "other-snail.convex.site"]) expect(isBlockedHost(host, proxy)).toBe(false);
    expect(isBlockedHost("critiqs.app")).toBe(false);
  });
});

describe("resolvePublicAddress with a policy", () => {
  const resolver = (answers: Record<string, readonly ResolvedAddress[]>) => {
    const asked: string[] = [];
    return { asked, resolve: async (host: string) => (asked.push(host), answers[host] ?? []) };
  };

  test("a blocked name is refused before DNS", async () => {
    const { asked, resolve } = resolver({ "critiqs.app": [{ address: "93.184.215.14", family: 4 }] });
    expect(await resolvePublicAddress(new URL("https://www.critiqs.app/"), resolve, AbortSignal.timeout(1_000), proxy)).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a name with any refused answer is refused", async () => {
    const { resolve } = resolver({ "mixed.example": [{ address: "93.184.215.14", family: 4 }, { address: "8.8.8.8", family: 4 }] });
    expect(await resolvePublicAddress(new URL("https://mixed.example/"), resolve, AbortSignal.timeout(1_000), proxy)).toBeNull();
    // Without the proxy's policy, both answers are public.
    expect(await resolvePublicAddress(new URL("https://mixed.example/"), resolve, AbortSignal.timeout(1_000))).toEqual({ address: "93.184.215.14", family: 4 });
  });

  test("IPv4 first among allowed answers; literals need no DNS", async () => {
    const { asked, resolve } = resolver({ "ok.example": [{ address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }, { address: "93.184.215.14", family: 4 }] });
    expect(await resolvePublicAddress(new URL("https://ok.example/"), resolve, AbortSignal.timeout(1_000), proxy)).toEqual({ address: "93.184.215.14", family: 4 });
    expect(await resolvePublicAddress(new URL("https://93.184.215.15/"), resolve, AbortSignal.timeout(1_000), proxy)).toEqual({ address: "93.184.215.15", family: 4 });
    expect(await resolvePublicAddress(new URL("https://[64:ff9b::5db8:d70e]/"), resolve, AbortSignal.timeout(1_000), proxy)).toBeNull();
    expect(asked).toEqual(["ok.example"]);
  });
});
