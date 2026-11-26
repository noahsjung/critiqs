import { ADDRESS_CHECKS_PER_HOUR, ADDRESS_CHECKS_PER_PERSON_PER_HOUR } from "@critiqs/server";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import { reviewer, setup } from "./harness";

// Onboarding's address check on Convex: the Node action, its sign-in
// requirement, and its hourly limits. Every address here is settled without
// the network; checkAddress's fetching is tested in @critiqs/server.

afterEach(() => {
  setSystemTime();
});

async function refusal(work: Promise<unknown>): Promise<unknown> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  return (error as { data?: unknown } | null)?.data;
}

test("checks addresses for signed-in people only, refusing invalid ones before counting them", async () => {
  setSystemTime(new Date(Date.UTC(2026, 10, 25, 9, 10)));
  const t = setup();
  expect(await refusal(t.action(api.addressCheck.check, { address: "http://localhost:3000" }))).toEqual({ code: "unauthenticated", message: "Sign in to view feedback." });

  const dana = t.withIdentity(reviewer("Dana"));
  expect(await dana.action(api.addressCheck.check, { address: "http://localhost:3000" })).toEqual({ kind: "local" });
  expect(await dana.action(api.addressCheck.check, { address: "http://169.254.169.254/latest/meta-data/" })).toEqual({ kind: "local" });
  // A literal IPv6 address carrying the metadata address is refused before connecting.
  expect(await dana.action(api.addressCheck.check, { address: "http://[64:ff9b::a9fe:a9fe]/" })).toEqual({ kind: "unreachable" });
  expect(await refusal(dana.action(api.addressCheck.check, { address: "https://dana:pw@proto.example.com" }))).toEqual({
    code: "invalid",
    message: "Leave the username and password out of the address.",
  });
  expect(await refusal(dana.action(api.addressCheck.check, { address: "ftp://proto.example.com" }))).toMatchObject({ code: "invalid" });

  for (let used = 3; used < ADDRESS_CHECKS_PER_PERSON_PER_HOUR; used++) {
    expect(await dana.action(api.addressCheck.check, { address: "http://devbox:8080" })).toEqual({ kind: "local" });
  }
  expect(await refusal(dana.action(api.addressCheck.check, { address: "http://devbox:8080" }))).toEqual({
    code: "limit",
    message: "You've checked 20 addresses this hour. Try again later, or skip this step.",
  });
  expect(await t.withIdentity(reviewer("Lee")).action(api.addressCheck.check, { address: "http://devbox:8080" })).toEqual({ kind: "local" });

  setSystemTime(new Date(Date.UTC(2026, 10, 25, 10, 0)));
  expect(await dana.action(api.addressCheck.check, { address: "http://devbox:8080" })).toEqual({ kind: "local" });
});

test("address checks stop for everyone past the deployment's hourly limit", async () => {
  setSystemTime(new Date(Date.UTC(2026, 10, 25, 9, 10)));
  const t = setup();
  const people = ADDRESS_CHECKS_PER_HOUR / ADDRESS_CHECKS_PER_PERSON_PER_HOUR;
  for (let n = 0; n < people; n++) {
    const person = t.withIdentity(reviewer(`Person${n}`));
    for (let i = 0; i < ADDRESS_CHECKS_PER_PERSON_PER_HOUR; i++) await person.mutation(internal.onboarding.claimAddressCheck, {});
  }
  expect(await refusal(t.withIdentity(reviewer("Late")).action(api.addressCheck.check, { address: "http://devbox:8080" }))).toEqual({
    code: "limit",
    message: "Critiqs is checking a lot of addresses right now. Try again in a few minutes, or skip this step.",
  });
});
