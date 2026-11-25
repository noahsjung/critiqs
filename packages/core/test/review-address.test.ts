import { expect, test } from "bun:test";
import { parseLink, reviewLink } from "../src/links.ts";
import { isPrivateReviewAddress, validReviewUrl } from "../src/review-address.ts";
import { OTHER_ADDRESSES, PRIVATE_ADDRESSES } from "./review-addresses.ts";

test("private review addresses include local names, private networks, and Tailscale", () => {
  for (const address of PRIVATE_ADDRESSES) expect([address, isPrivateReviewAddress(address)]).toEqual([address, true]);
  for (const address of OTHER_ADDRESSES) expect([address, isPrivateReviewAddress(address)]).toEqual([address, false]);
});

test("a review address keeps its path, parameters, and hash route, without a copied Critiqs link", () => {
  expect(validReviewUrl("https://team.github.io/admin-prototype/?env=a%20b#/start")).toBe("https://team.github.io/admin-prototype/?env=a%20b#/start");
  expect(validReviewUrl("https://proto.example/app/?critiqs=t1.m2&tab=a#/home")).toBe("https://proto.example/app/?tab=a#/home");
  expect(validReviewUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
  // Private addresses are allowed over HTTPS; plain HTTP only on this computer.
  expect(validReviewUrl("https://devbox.tail1234.ts.net/")).toBe("https://devbox.tail1234.ts.net/");
  for (const refused of ["http://devbox.tail1234.ts.net/", "http://192.168.1.4:3000/", "javascript:alert(1)", "https://user:pass@proto.example/", "proto.example"]) {
    expect(validReviewUrl(refused)).toBeNull();
  }
  expect(validReviewUrl(`https://proto.example/?q=${"x".repeat(1_960)}`)).not.toBeNull();
  expect(validReviewUrl(`https://proto.example/?q=${"x".repeat(2_000)}`)).toBeNull();
  // Longer once encoded than the limit allows.
  expect(validReviewUrl(`https://proto.example/?q=${"é".repeat(1_000)}`)).toBeNull();
});

test("a review link is the review page exactly, with the message parameter", () => {
  const target = { threadId: "t1", messageId: "m2" };
  expect(reviewLink("https://team.github.io/admin-prototype/", target)).toBe("https://team.github.io/admin-prototype/?critiqs=t1.m2");
  // The app's own parameters keep their exact text; the hash route stays after the query.
  const link = reviewLink("https://team.github.io/admin-prototype/?env=a%20b&x=1+2#/users?tab=a", target);
  expect(link).toBe("https://team.github.io/admin-prototype/?env=a%20b&x=1+2&critiqs=t1.m2#/users?tab=a");
  expect(parseLink(link)).toEqual(target);
  expect(reviewLink("https://proto.example/app?critiqs=old", { threadId: "t1", messageId: null })).toBe("https://proto.example/app?critiqs=t1");
  expect(reviewLink("https://proto.example/app?", target)).toBe("https://proto.example/app?critiqs=t1.m2");
});
