import { expect, test } from "bun:test";
import { isAmbiguousOrigin, originLookupKeys, parseProjectAddress, patternMatches } from "../src/project-addresses.ts";

test("a pattern is searched by its address with the whole leftmost label as *", () => {
  expect(parseProjectAddress("https://*-Acme.vercel.app:443/")).toEqual({ address: "https://*-acme.vercel.app", exact: false, key: "https://*.vercel.app" });
  expect(parseProjectAddress("https://*.acme.com:8443")).toEqual({ address: "https://*.acme.com:8443", exact: false, key: "https://*.acme.com:8443" });
  expect(originLookupKeys("https://PR-12-acme.vercel.app/")).toEqual({ origin: "https://pr-12-acme.vercel.app", patternKey: "https://*.vercel.app", ambiguous: false });
  // No pattern can cover a name with two labels or an IP address.
  expect(originLookupKeys("https://vercel.app")?.patternKey).toBeNull();
  expect(originLookupKeys("https://203.0.113.9")?.patternKey).toBeNull();
  expect(originLookupKeys("https://*.acme.com")).toBeNull();
  expect(originLookupKeys("https://acme.com/path")).toBeNull();
});

test("a wildcard covers one or more characters of one label", () => {
  expect(patternMatches("https://*-acme.vercel.app", "https://pr-1-acme.vercel.app")).toBe(true);
  expect(patternMatches("https://*-acme.vercel.app", "https://-acme.vercel.app")).toBe(false);
  expect(patternMatches("https://*-acme.vercel.app", "https://a.b-acme.vercel.app")).toBe(false);
  expect(patternMatches("https://pr-*.acme.com", "https://pr-7.acme.com")).toBe(true);
  expect(patternMatches("https://pr-*.acme.com", "https://pr-7.acme.com:8443")).toBe(false);
});

test("origins on this computer, a private network, or a local name are ambiguous", () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:3000", "http://10.0.0.8", "http://192.168.1.4:3000", "https://devbox.local", "http://devbox:3000"]) {
    expect(isAmbiguousOrigin(origin)).toBe(true);
  }
  for (const origin of ["https://acme-proto.vercel.app", "https://203.0.113.9"]) expect(isAmbiguousOrigin(origin)).toBe(false);
});

test("a pattern reads the same where the browser writes * in a host as %2A, as Chrome does", () => {
  const Real = globalThis.URL;
  // Chrome's URL parser keeps `*` in a host only percent-encoded; Node and Bun keep it as typed.
  class ChromeURL extends Real {
    override get hostname() {
      return super.hostname.replace(/\*/g, "%2A");
    }
    override get origin() {
      return super.origin.replace(/\*/g, "%2A");
    }
  }
  const read = () => ["https://*-acme.vercel.app", "https://*.acme.com", "https://acme-*.vercel.app/", "https://acme.example", "https://*-acme.vercel.app/path"].map((value) => parseProjectAddress(value));
  const here = read();
  globalThis.URL = ChromeURL as typeof URL;
  try {
    expect(read()).toEqual(here);
  } finally {
    globalThis.URL = Real;
  }
  expect(here.slice(0, 3)).toEqual([
    { address: "https://*-acme.vercel.app", exact: false, key: "https://*.vercel.app" },
    { address: "https://*.acme.com", exact: false, key: "https://*.acme.com" },
    { address: "https://acme-*.vercel.app", exact: false, key: "https://*.vercel.app" },
  ]);
  // The stand-in for the wildcard is never an address of its own.
  expect(parseProjectAddress("https://*-critiqswildcard.vercel.app")).toHaveProperty("error");
});
