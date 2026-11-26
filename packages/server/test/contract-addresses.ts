import { afterEach, expect, setSystemTime, test } from "bun:test";
import { MAX_PROJECT_ADDRESSES } from "@critiqs/core";
import * as ops from "../src/operations.ts";
import { findProjectsForOrigin, getProjectAddresses, MAX_LOOKUP_CHOICES, recordProjectOpened, setProjectAddresses } from "../src/project-addresses.ts";
import type { Identity } from "../src/store.ts";
import { anchor, type ContractBackend, reviewer } from "./contract.ts";

/**
 * Address lists and the browser extension's project lookup, on every
 * backend: who may change a list, what it accepts, and that the lookup finds
 * only projects the person can already reach.
 */
export function defineAddressContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");
  const lee = reviewer("Lee");
  const kim = reviewer("Kim");

  afterEach(() => setSystemTime());

  const create = (backend: ContractBackend, who: Identity, projectName: string) =>
    backend.run((store) => ops.createProject(store, who, { name: projectName }));
  const setList = (backend: ContractBackend, who: Identity, projectId: string, addresses: string[]) =>
    backend.run((store) => setProjectAddresses(store, who, { projectId, addresses }));
  const lookup = (backend: ContractBackend, who: Identity | null, origin: string) =>
    backend.run((store) => findProjectsForOrigin(store, who, { origin }));
  const opened = (backend: ContractBackend, who: Identity, projectId: string) =>
    backend.run((store) => recordProjectOpened(store, who, { projectId }));
  const found = async (backend: ContractBackend, who: Identity, origin: string) => {
    const result = await lookup(backend, who, origin);
    if (result.status === "found") return { status: result.status, names: [result.project.name] };
    if (result.status === "choose") return { status: result.status, names: result.projects.map((project) => project.name) };
    return { status: result.status, names: [] };
  };
  async function join(backend: ContractBackend, who: Identity, projectId: string, role: "admin" | "member") {
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    await backend.run(async (store) => {
      const user = await ops.requireUser(store, who);
      await store.memberships.insert({ organizationId, userId: user._id, role, createdAt: Date.now() });
    });
  }

  test(`${name}: an address list is normalized, and refuses paths, credentials, public http, and loose wildcards`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    expect(
      await setList(backend, dana, projectId, [
        "HTTPS://Acme-Proto.Vercel.APP:443/",
        "https://acme-proto.vercel.app",
        "https://*-Acme.vercel.app",
        "http://localhost:5173/",
        "http://192.168.1.4:3000",
        "http://[::1]:80",
        "https://staging.acme.com:8443",
        "https://preview.acme.com./",
      ]),
    ).toEqual([
      "https://acme-proto.vercel.app",
      "https://*-acme.vercel.app",
      "http://localhost:5173",
      "http://192.168.1.4:3000",
      "http://[::1]",
      "https://staging.acme.com:8443",
      "https://preview.acme.com",
    ]);
    expect(await backend.run((store) => getProjectAddresses(store, dana, { projectId }))).toEqual([
      "https://acme-proto.vercel.app",
      "https://*-acme.vercel.app",
      "http://localhost:5173",
      "http://192.168.1.4:3000",
      "http://[::1]",
      "https://staging.acme.com:8443",
      "https://preview.acme.com",
    ]);
    // A host written with its final dot is the same site.
    expect(await found(backend, dana, "https://preview.acme.com.")).toEqual({ status: "found", names: ["Acme"] });

    const refused: [string, string][] = [
      ["https://acme.com/app", "without a path"],
      ["https://acme.com?ref=1", "without a path"],
      ["https://acme.com#top", "without a path"],
      ["https://dana:secret@acme.com", "username or password"],
      ["http://acme.com", "Plain http:// works only on this computer or a private network"],
      ["ftp://acme.com", "must start with https://"],
      ["acme.com", "isn't an address"],
      ["https://*.*.acme.com", "only one *"],
      ["https://pr.*.acme.com", "leftmost part"],
      ["https://*.com", "matches too much"],
      ["https://*-ü.acme.com", "letters a to z"],
      ["https://acme..com", "host name that isn't valid"],
      ["https://acme.com\\settings", "without a path"],
      ["https://acme.com\\", "without a path"],
      [`https://${"a".repeat(200)}.com`, "longer than 200"],
      // Measured once normalized: each letter such as `ü` grows in its `xn--` form.
      [`https://${Array(6).fill("äöüéèêàçñåøœßîïôûëÿ").join(".")}.com`, "longer than 200"],
      ["https://acme\n.com", "space or line break"],
      ["https://acme .com", "space or line break"],
    ];
    for (const [address, message] of refused) {
      await expect(setList(backend, dana, projectId, [address])).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(message) });
    }
    const tooMany = Array.from({ length: MAX_PROJECT_ADDRESSES + 1 }, (_, index) => `https://pr-${index}.acme.com`);
    await expect(setList(backend, dana, projectId, tooMany)).rejects.toThrow(`up to ${MAX_PROJECT_ADDRESSES} addresses`);
    // A refused list changes nothing.
    expect(await backend.run((store) => getProjectAddresses(store, dana, { projectId }))).toHaveLength(7);
    expect(await setList(backend, dana, projectId, tooMany.slice(0, MAX_PROJECT_ADDRESSES))).toHaveLength(MAX_PROJECT_ADDRESSES);
    // Separate from the review address.
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId }))).reviewUrl).toBeNull();
  });

  test(`${name}: only the project's owners change or see its address list`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    await join(backend, lee, projectId, "member");
    await join(backend, kim, projectId, "admin");
    for (const who of [lee, reviewer("Riley")]) {
      await expect(setList(backend, who, projectId, ["https://acme.com"])).rejects.toMatchObject({ code: "forbidden" });
      await expect(backend.run((store) => getProjectAddresses(store, who, { projectId }))).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(setList(backend, null as unknown as Identity, projectId, ["https://acme.com"])).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await setList(backend, kim, projectId, ["https://acme.com"])).toEqual(["https://acme.com"]);
    expect(await backend.run((store) => getProjectAddresses(store, dana, { projectId }))).toEqual(["https://acme.com"]);
  });

  test(`${name}: the lookup searches only organizations the person belongs to, and never reveals another team's project`, async () => {
    const backend = fresh();
    const acme = await create(backend, dana, "Acme");
    const rival = await create(backend, lee, "Rival");
    await setList(backend, dana, acme, ["https://shared.example.com"]);
    // Lists aren't unique: another team may list the same origin, and saving it says nothing about the first.
    expect(await setList(backend, lee, rival, ["https://shared.example.com", "https://rival.example.com"])).toEqual([
      "https://shared.example.com",
      "https://rival.example.com",
    ]);

    const forDana = await lookup(backend, dana, "https://shared.example.com");
    expect(forDana).toMatchObject({ status: "found", project: { _id: acme, name: "Acme", isOwner: true } });
    expect(await found(backend, lee, "https://shared.example.com")).toEqual({ status: "found", names: ["Rival"] });

    // Another team's project answers exactly as an origin no project lists.
    const unlisted = await lookup(backend, dana, "https://nobody.example.com");
    expect(unlisted).toEqual({ status: "none" });
    expect(await lookup(backend, dana, "https://rival.example.com")).toEqual(unlisted);
    expect(await lookup(backend, kim, "https://shared.example.com")).toEqual(unlisted);
    // A malformed origin, or one no project could list, answers the same too.
    expect(await lookup(backend, dana, "not an origin")).toEqual(unlisted);
    expect(await lookup(backend, dana, "http://shared.example.com")).toEqual(unlisted);

    // Members of the organization find its projects; leaving it ends that.
    await join(backend, kim, acme, "member");
    expect(await found(backend, kim, "https://shared.example.com")).toEqual({ status: "found", names: ["Acme"] });
    await backend.run(async (store) => {
      const kimId = (await store.users.byToken(kim.tokenIdentifier))!._id;
      const organizationId = (await store.projects.get(acme))!.organizationId!;
      await store.memberships.delete((await store.memberships.find(organizationId, kimId))!._id);
    });
    expect(await lookup(backend, kim, "https://shared.example.com")).toEqual(unlisted);
  });

  test(`${name}: the lookup requires sign-in`, async () => {
    const backend = fresh();
    await expect(lookup(backend, null, "https://acme.com")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(lookup(backend, { ...kim, emailVerified: false }, "https://acme.com")).rejects.toMatchObject({ code: "email-unverified" });
  });

  test(`${name}: a project opened through an install is found; reading its threads by link isn't enough`, async () => {
    const backend = fresh();
    const acme = await create(backend, dana, "Acme");
    const rival = await create(backend, lee, "Rival");
    await setList(backend, dana, acme, ["https://acme.example.com"]);
    await setList(backend, lee, rival, ["https://rival.example.com"]);
    const threadId = await backend.run((store) =>
      ops.createThread(store, lee, { projectId: rival, anchor, body: "Spacing", tags: [], capture: { status: "failed", failureReason: "Blocked" } }),
    );

    // A thread page's link can be forwarded to people who never reached the prototype.
    await backend.run((store) => ops.getThread(store, kim, { threadId }, { numItems: 40, cursor: null }));
    expect(await lookup(backend, kim, "https://rival.example.com")).toEqual({ status: "none" });

    await opened(backend, kim, acme);
    expect(await found(backend, kim, "https://acme.example.com")).toEqual({ status: "found", names: ["Acme"] });
    expect(await lookup(backend, kim, "https://rival.example.com")).toEqual({ status: "none" });
    await expect(opened(backend, kim, "not-a-project")).rejects.toMatchObject({ code: "not-found" });
    await expect(opened(backend, null as unknown as Identity, acme)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test(`${name}: recording an opened project again keeps one record and usually writes nothing`, async () => {
    const backend = fresh();
    const acme = await create(backend, dana, "Acme");
    const start = Date.UTC(2026, 10, 1, 12);
    const records = () =>
      backend.run(async (store) => {
        const kimId = (await store.users.byToken(kim.tokenIdentifier))!._id;
        return (await store.openedProjects.recent(kimId, 10)).map((row) => ({ projectId: row.projectId, openedAt: row.openedAt }));
      });
    setSystemTime(new Date(start));
    await opened(backend, kim, acme);
    setSystemTime(new Date(start + 60 * 60 * 1000));
    await opened(backend, kim, acme);
    expect(await records()).toEqual([{ projectId: acme, openedAt: start }]);
    const later = start + 25 * 60 * 60 * 1000;
    setSystemTime(new Date(later));
    await opened(backend, kim, acme);
    expect(await records()).toEqual([{ projectId: acme, openedAt: later }]);
  });

  test(`${name}: an exact origin wins over a pattern, and a pattern covers part of one label`, async () => {
    const backend = fresh();
    const previews = await create(backend, dana, "Previews");
    const pr1 = await create(backend, dana, "PR 1");
    await setList(backend, dana, previews, ["https://*-acme.vercel.app"]);
    await setList(backend, dana, pr1, ["https://pr-1-acme.vercel.app"]);
    expect(await found(backend, dana, "https://pr-1-acme.vercel.app")).toEqual({ status: "found", names: ["PR 1"] });
    expect(await found(backend, dana, "HTTPS://PR-2-Acme.Vercel.App:443/")).toEqual({ status: "found", names: ["Previews"] });
    for (const origin of ["https://acme.vercel.app", "https://-acme.vercel.app", "https://a.pr-2-acme.vercel.app", "https://pr-2-acme.vercel.app.evil.com", "https://pr-2-acme.vercel.app:8443"]) {
      expect(await lookup(backend, dana, origin)).toEqual({ status: "none" });
    }
    // Replacing a list replaces what it matches.
    await setList(backend, dana, previews, ["https://*.acme.dev"]);
    expect(await lookup(backend, dana, "https://pr-2-acme.vercel.app")).toEqual({ status: "none" });
    expect(await found(backend, dana, "https://preview.acme.dev")).toEqual({ status: "found", names: ["Previews"] });
  });

  test(`${name}: several matches in scope ask which project, as two patterns do`, async () => {
    const backend = fresh();
    const web = await create(backend, dana, "Web");
    const admin = await create(backend, dana, "Admin");
    const docs = await create(backend, dana, "Docs");
    await setList(backend, dana, web, ["https://staging.acme.com"]);
    await setList(backend, dana, admin, ["https://staging.acme.com"]);
    await setList(backend, dana, docs, ["https://*.acme.com"]);
    expect(await found(backend, dana, "https://staging.acme.com")).toEqual({ status: "choose", names: ["Admin", "Web"] });
    await setList(backend, dana, web, ["https://*-app.acme.com"]);
    await setList(backend, dana, admin, []);
    expect(await found(backend, dana, "https://beta-app.acme.com")).toEqual({ status: "choose", names: ["Docs", "Web"] });
  });

  test(`${name}: an ambiguous origin always asks, even with one match`, async () => {
    const backend = fresh();
    const acme = await create(backend, dana, "Acme");
    await setList(backend, dana, acme, ["http://localhost:5173", "http://127.0.0.1:5173", "http://10.0.0.8:3000", "https://devbox.local"]);
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://10.0.0.8:3000", "https://devbox.local"]) {
      expect(await found(backend, dana, origin)).toEqual({ status: "choose", names: ["Acme"] });
    }
    // Another team's project on the same localhost address stays out of scope.
    const rival = await create(backend, lee, "Rival");
    await setList(backend, lee, rival, ["http://localhost:5173"]);
    expect(await found(backend, dana, "http://localhost:5173")).toEqual({ status: "choose", names: ["Acme"] });
    expect(await lookup(backend, kim, "http://localhost:5173")).toEqual({ status: "none" });
    // On a local name, an exact address doesn't hide a pattern's project: either may be the app on this network.
    const team = await create(backend, dana, "Team");
    await setList(backend, dana, acme, ["http://app.team.local"]);
    await setList(backend, dana, team, ["http://*.team.local"]);
    expect(await found(backend, dana, "http://app.team.local")).toEqual({ status: "choose", names: ["Acme", "Team"] });
  });

  test(`${name}: an origin many projects list offers at most ${MAX_LOOKUP_CHOICES} of them`, async () => {
    const backend = fresh();
    for (let index = 0; index < MAX_LOOKUP_CHOICES + 5; index++) {
      const projectId = await create(backend, dana, `Prototype ${String(index).padStart(2, "0")}`);
      await setList(backend, dana, projectId, ["http://localhost:3000"]);
    }
    const result = await found(backend, dana, "http://localhost:3000");
    expect(result.status).toBe("choose");
    expect(result.names).toHaveLength(MAX_LOOKUP_CHOICES);
  });

  test(`${name}: when an organization has more patterns than one lookup reads, a single visible match still asks`, async () => {
    const backend = fresh();
    const first = await create(backend, dana, "First");
    await setList(backend, dana, first, ["https://*-app.acme.com", ...Array.from({ length: 19 }, (_, index) => `https://*-x${index}.acme.com`)]);
    for (let project = 0; project < 4; project++) {
      const projectId = await create(backend, dana, `Filler ${project}`);
      await setList(backend, dana, projectId, Array.from({ length: 20 }, (_, index) => `https://*-y${project}-${index}.acme.com`));
    }
    const last = await create(backend, dana, "Last");
    await setList(backend, dana, last, ["https://*-app.acme.com"]);
    expect((await lookup(backend, dana, "https://beta-app.acme.com")).status).toBe("choose");
  });

  test(`${name}: a pattern finds an origin longer than an address may be`, async () => {
    const backend = fresh();
    const acme = await create(backend, dana, "Acme");
    const rest = `${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(40)}.com`;
    await setList(backend, dana, acme, [`https://*.${rest}`]);
    const origin = `https://${"a".repeat(63)}.${rest}`;
    expect(origin.length).toBeGreaterThan(200);
    expect(await found(backend, dana, origin)).toEqual({ status: "found", names: ["Acme"] });
  });

  test(`${name}: a project from before organizations moves into its creator's organization when it lists an address`, async () => {
    const backend = fresh();
    const projectId = await backend.run(async (store) => {
      const userId = await store.users.insert({ tokenIdentifier: dana.tokenIdentifier, name: "Dana", email: dana.email, imageUrl: null });
      return await store.projects.insert({ name: "From before", tags: [], createdBy: userId, createdAt: Date.now() });
    });
    await setList(backend, dana, projectId, ["https://old.acme.com"]);
    expect(await found(backend, dana, "https://old.acme.com")).toEqual({ status: "found", names: ["From before"] });
    expect((await backend.run((store) => store.projects.get(projectId)))!.organizationId).toEqual(expect.any(String));
  });
}
