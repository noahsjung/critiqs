import { expect, test } from "bun:test";
import { type Deployment, HOSTED_BACKEND_URL, madeWithArg, resolveDeployment, siteUrlOf } from "../src/deployment.ts";

test("pairs a deployment URL with its HTTP address", () => {
  expect(siteUrlOf("https://happy-otter-123.convex.cloud")).toBe("https://happy-otter-123.convex.site");
  expect(siteUrlOf("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3211");
});

test("reads the sign-in service the deployment trusts, checking it is current too", async () => {
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    asked.push(url);
    // Sign-in hasn't changed since protocol 4, so a protocol 4 sign-in service is current.
    return Response.json({ signInUrl: "https://critiqs-hosted.convex.site", protocol: url.startsWith("https://team") ? 5 : 4 });
  }) as unknown as typeof fetch;
  expect(await resolveDeployment("https://team.convex.cloud/", fetchFn)).toEqual({
    backendUrl: "https://team.convex.cloud",
    siteUrl: "https://team.convex.site",
    signInUrl: "https://critiqs-hosted.convex.site",
    transport: "convex",
    signIn: null,
    mockups: false,
    personalAi: false,
    modelLists: false,
    organizations: false,
    organizationMembers: false,
    overageCap: false,
    billing: false,
    addressLists: false,
    addressEdits: false,
    addressNotes: false,
    createKeys: false,
    presetTags: false,
    connections: false,
    threadMadeWith: false,
  });
  expect(asked).toEqual(["https://team.convex.site/critiqs/config", "https://critiqs-hosted.convex.site/critiqs/config"]);
});

test("refuses a current backend that trusts an older sign-in service", async () => {
  const fetchFn = (async (url: string) =>
    url.startsWith("https://team.convex.site")
      ? Response.json({ signInUrl: "https://old.convex.site", protocol: 5 })
      : Response.json({ signInUrl: "https://old.convex.site", protocol: 3 })) as unknown as typeof fetch;
  await expect(resolveDeployment("https://team.convex.cloud", fetchFn)).rejects.toThrow(
    "Critiqs's sign-in service at https://old.convex.site isn't ready for this version of Critiqs yet.",
  );
});

test("Critiqs Cloud is the default backend, served from its paired site address", () => {
  expect(HOSTED_BACKEND_URL).toMatch(/^https:\/\/[a-z0-9-]+\.convex\.cloud$/);
  expect(siteUrlOf(HOSTED_BACKEND_URL)).toBe(HOSTED_BACKEND_URL.replace(".convex.cloud", ".convex.site"));
});

test("refuses a backend older than this component, naming what to do", async () => {
  const older = (async () => Response.json({ signInUrl: "https://old.convex.site", protocol: 4 })) as unknown as typeof fetch;
  await expect(resolveDeployment("https://team.convex.cloud", older)).rejects.toThrow(
    "The Critiqs backend at https://team.convex.cloud runs an older version. Deploy the current Critiqs functions to it.",
  );
  await expect(resolveDeployment(HOSTED_BACKEND_URL, older)).rejects.toThrow("Critiqs Cloud isn't ready for this version of Critiqs yet.");
});

test("reports a backend it can't reach", async () => {
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  await expect(resolveDeployment("https://team.convex.cloud", offline)).rejects.toThrow("Critiqs can't reach its backend at https://team.convex.cloud.");
  const missing = (async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch;
  await expect(resolveDeployment("https://team.convex.cloud", missing)).rejects.toThrow("Critiqs can't reach its backend at https://team.convex.cloud (404).");
});

test("a server in the host app answers at its path, with its own sign-in", async () => {
  expect(siteUrlOf("https://app.example/critiqs/")).toBe("https://app.example/critiqs");
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    asked.push(url);
    return Response.json({ signInUrl: "https://app.example/critiqs", protocol: 5, transport: "http", signIn: "email" });
  }) as unknown as typeof fetch;
  expect(await resolveDeployment("https://app.example/critiqs", fetchFn)).toEqual({
    backendUrl: "https://app.example/critiqs",
    siteUrl: "https://app.example/critiqs",
    signInUrl: "https://app.example/critiqs",
    transport: "http",
    signIn: "email",
    mockups: false,
    personalAi: false,
    modelLists: false,
    organizations: false,
    organizationMembers: false,
    overageCap: false,
    billing: false,
    addressLists: false,
    addressEdits: false,
    addressNotes: false,
    createKeys: false,
    presetTags: false,
    connections: false,
    threadMadeWith: false,
  });
  expect(asked).toEqual(["https://app.example/critiqs/critiqs/config"]);
});

test("offers Mockup mode only where the backend reports it stores mockups", async () => {
  const config = (mockups: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, mockups })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).mockups).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).mockups).toBe(false);
  expect((await resolveDeployment("https://team.convex.cloud", config("yes"))).mockups).toBe(false);
});

test("offers Your AI only where the backend reports it keeps each person's own AI settings", async () => {
  const config = (personalAi: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, personalAi })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).personalAi).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).personalAi).toBe(false);
  expect((await resolveDeployment("https://team.convex.cloud", config("yes"))).personalAi).toBe(false);
});

test("offers model lists and model choices only where the backend reports them", async () => {
  const config = (modelLists: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, modelLists })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).modelLists).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).modelLists).toBe(false);
  expect((await resolveDeployment("https://team.convex.cloud", config("yes"))).modelLists).toBe(false);
});

test("knows about organizations only where the backend reports them", async () => {
  const config = (organizations: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, organizations })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).organizations).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).organizations).toBe(false);
  expect((await resolveDeployment("https://team.convex.cloud", config("yes"))).organizations).toBe(false);
});

test("offers organization members only where the backend reports them", async () => {
  const config = (organizationMembers: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, organizationMembers })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).organizationMembers).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).organizationMembers).toBe(false);
});

test("records opened projects only where the backend reports address lists", async () => {
  const config = (addressLists: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, addressLists })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).addressLists).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).addressLists).toBe(false);
  expect((await resolveDeployment("https://team.convex.cloud", config("yes"))).addressLists).toBe(false);
});

test("reads single-address edits, keyed creates, preset tag edits, connections, and how threads were left only where the backend reports them", async () => {
  const config = (value: unknown) =>
    (async () =>
      Response.json({ signInUrl: "https://team.convex.site", protocol: 5, addressEdits: value, addressNotes: value, createKeys: value, presetTags: value, connections: value, threadMadeWith: value })) as unknown as typeof fetch;
  expect(await resolveDeployment("https://team.convex.cloud", config(true))).toMatchObject({ addressEdits: true, addressNotes: true, createKeys: true, presetTags: true, connections: true, threadMadeWith: true });
  const off = { addressEdits: false, addressNotes: false, createKeys: false, presetTags: false, connections: false, threadMadeWith: false };
  expect(await resolveDeployment("https://team.convex.cloud", config(undefined))).toMatchObject(off);
  expect(await resolveDeployment("https://team.convex.cloud", config("yes"))).toMatchObject(off);
});

test("a new thread says it was left with the extension only from the extension's own page, and only to backends that record it", async () => {
  const records = { threadMadeWith: true } as Deployment;
  expect(madeWithArg(records, { protocol: "chrome-extension:" })).toEqual({ madeWith: "extension" });
  expect(madeWithArg(records, { protocol: "https:" })).toEqual({});
  expect(madeWithArg(records, { protocol: "http:" })).toEqual({});
  // An older backend would refuse an argument it doesn't know.
  expect(madeWithArg({ threadMadeWith: false } as Deployment, { protocol: "chrome-extension:" })).toEqual({});
  expect(madeWithArg(records, undefined)).toEqual({});
});

test("offers the cap on extra Critiqs AI credits only where the backend reports it", async () => {
  const config = (overageCap: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, overageCap })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).overageCap).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).overageCap).toBe(false);
  expect((await resolveDeployment("https://team.convex.cloud", config("yes"))).overageCap).toBe(false);
});

test("offers paying for plans only where the backend reports it", async () => {
  const config = (billing: unknown) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, billing })) as unknown as typeof fetch;
  expect((await resolveDeployment("https://team.convex.cloud", config(true))).billing).toBe(true);
  expect((await resolveDeployment("https://team.convex.cloud", config(undefined))).billing).toBe(false);
});

test("links Share to thread pages only where the backend reports them and the website that serves them", async () => {
  const config = (extra: Record<string, unknown>) =>
    (async () => Response.json({ signInUrl: "https://team.convex.site", protocol: 5, ...extra })) as unknown as typeof fetch;
  const website = async (extra: Record<string, unknown>) => (await resolveDeployment("https://team.convex.cloud", config(extra))).website;
  expect(await website({ threadPages: true, website: "https://critiqs.example" })).toBe("https://critiqs.example");
  expect(await website({ threadPages: true, website: "https://critiqs.example/app/" })).toBe("https://critiqs.example/app/");
  expect(await website({ threadPages: true })).toBeUndefined();
  expect(await website({ website: "https://critiqs.example" })).toBeUndefined();
  for (const odd of ["javascript:alert(1)", "not a url", 42, "ftp://critiqs.example"]) expect(await website({ threadPages: true, website: odd })).toBeUndefined();
});
