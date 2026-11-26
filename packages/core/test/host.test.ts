import { describe, expect, test } from "bun:test";
import { canonicalHost, isIdentityProvider, isLocalAddress, isPrivateHost, siteOf } from "../src/index.ts";

// One spelling per host: every check that compares or refuses a host name
// uses `canonicalHost`, so a trailing dot, case, Unicode or a numeric IPv4
// form never makes one host two hosts.
describe("canonicalHost", () => {
  const same: [string, string][] = [
    ["Example.COM", "example.com"],
    ["example.com.", "example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["0x7f.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["127.0.0.1.", "127.0.0.1"],
    ["[::1]", "::1"],
    ["::FFFF:127.0.0.1", "::ffff:7f00:1"],
  ];
  for (const [given, expected] of same) test(`${given} is ${expected}`, () => expect(canonicalHost(given)).toBe(expected));

  for (const bad of ["", "localhost..", "example.com..", "a..b", ".example.com", "example.com:443", "user@example.com", "example.com/path", "exa mple.com"]) {
    test(`${JSON.stringify(bad)} isn't a plain host`, () => expect(canonicalHost(bad)).toBeNull());
  }
});

describe("checks that use it", () => {
  test("a name that isn't a plain host is private: never fetched", () => {
    expect(isPrivateHost("localhost..")).toBe(true);
    expect(isLocalAddress(new URL("http://printer.local../"))).toBe(true);
    expect(isPrivateHost("example.com.")).toBe(false);
  });
  test("identity providers with a trailing dot", () => {
    expect(isIdentityProvider(new URL("https://ACCOUNTS.google.com./o"))).toBe(true);
    expect(isIdentityProvider(new URL("https://github.com./login"))).toBe(true);
  });
  test("sites", () => {
    expect(siteOf("app.critiqs.app.")).toBe("critiqs.app");
    expect(siteOf("proxy.critiqs.app")).toBe(siteOf("app.critiqs.app"));
    expect(siteOf("review.localhost")).not.toBe(siteOf("web.localhost"));
    expect(siteOf("10.0.0.1")).not.toBe(siteOf("192.168.0.1"));
  });
});
