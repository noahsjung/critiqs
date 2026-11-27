import { afterEach, expect, setSystemTime, test } from "bun:test";
import { MAX_MANAGEABLE_PROJECTS, MAX_PROJECT_ADDRESSES } from "@critiqs/core";
import type { Plan } from "../src/limits.ts";
import * as ops from "../src/operations.ts";
import { ORGANIZATION_ONLY } from "../src/organizations.ts";
import * as projectAddresses from "../src/project-addresses.ts";
import {
  addProjectAddress,
  findProjectsForOrigin,
  getProjectAddresses,
  listManageableProjects,
  MAX_LOOKUP_CHOICES,
  recordProjectOpened,
  removeProjectAddress,
  setProjectAddresses,
} from "../src/project-addresses.ts";
import type { Identity } from "../src/store.ts";
import { anchor, type ContractBackend, reviewer } from "./contract.ts";

/**
 * Address lists and the browser extension's project lookup and setup, on
 * every backend: who may change a list, what it accepts, that the lookup finds
 * only projects the person can already reach, that adding one address keeps
 * concurrent additions, that a retried create makes one project, and which
 * projects a person may add a site to.
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

  test(`${name}: a pattern can't cover a whole shared domain or public suffix; one beside a site's own name can`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    for (const address of ["https://*.vercel.app", "https://*.co.uk", "https://*.github.io", "https://*.netlify.app", "https://*.s3.amazonaws.com", "https://*.pages.dev"]) {
      await expect(setList(backend, dana, projectId, [address])).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("shared by many sites") });
      await expect(backend.run((store) => addProjectAddress(store, dana, { projectId, address }))).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(setList(backend, dana, projectId, ["https://*"])).rejects.toMatchObject({ code: "invalid" });
    expect(await setList(backend, dana, projectId, ["https://*-acme.vercel.app", "https://*.acme.com", "https://*.acme.co.uk", "https://*.acme.github.io"])).toEqual([
      "https://*-acme.vercel.app",
      "https://*.acme.com",
      "https://*.acme.co.uk",
      "https://*.acme.github.io",
    ]);
  });

  test(`${name}: a pattern listed before the rule hands out no project, counts for nothing, and its owner can still remove it`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Attacker");
    await setList(backend, dana, projectId, ["https://acme.example.com"]);
    // As saved by a version that accepted it.
    await backend.run(async (store) => {
      const row = (await store.projectAddresses.forProject(projectId, 20))[0]!;
      await store.projectAddresses.insert({ projectId, organizationId: row.organizationId, address: "https://*.vercel.app", key: "https://*.vercel.app", position: 1 });
    });
    await opened(backend, lee, projectId);
    expect(await lookup(backend, lee, "https://lee-company-staging.vercel.app")).toEqual({ status: "none" });
    expect(await lookup(backend, dana, "https://lee-company-staging.vercel.app")).toEqual({ status: "none" });
    expect(await backend.run((store) => getProjectAddresses(store, dana, { projectId }))).toEqual(["https://acme.example.com", "https://*.vercel.app"]);
    expect(await backend.run((store) => removeProjectAddress(store, dana, { projectId, address: "https://*.vercel.app" }))).toEqual(["https://acme.example.com"]);
  });

  test(`${name}: next to a shared domain a * needs at least 4 letters or digits of the site's own name beside it`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    for (const address of ["https://*a.vercel.app", "https://a*.vercel.app", "https://*0.vercel.app", "https://*-app.vercel.app", "https://ab-*-c.vercel.app", "https://*-co.co.uk"]) {
      await expect(backend.run((store) => addProjectAddress(store, dana, { projectId, address }))).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("at least 4 letters or digits"),
      });
    }
    expect(
      await setList(backend, dana, projectId, ["https://*-acme.vercel.app", "https://acme-*.vercel.app", "https://ac-*-me.vercel.app", "https://*a.acme.com", "https://*.acme.com"]),
    ).toEqual(["https://*-acme.vercel.app", "https://acme-*.vercel.app", "https://ac-*-me.vercel.app", "https://*a.acme.com", "https://*.acme.com"]);
  });

  test(`${name}: shared hosts the Public Suffix List misses are shared domains too`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    for (const address of ["https://*.glitch.me", "https://*.koyeb.app"]) {
      await expect(backend.run((store) => addProjectAddress(store, dana, { projectId, address }))).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("shared by many sites"),
      });
    }
    expect(await setList(backend, dana, projectId, ["https://*-acme.glitch.me", "https://*-acme.koyeb.app"])).toEqual(["https://*-acme.glitch.me", "https://*-acme.koyeb.app"]);
  });

  test(`${name}: an owner's list says which patterns listed before the rule match nothing now, and what to do`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    await setList(backend, dana, projectId, ["https://acme.example.com", "https://*-acme.vercel.app"]);
    // As saved by versions that accepted them.
    await backend.run(async (store) => {
      const row = (await store.projectAddresses.forProject(projectId, 20))[0]!;
      for (const [position, address] of [[2, "https://*.vercel.app"], [3, "https://*a.vercel.app"]] as const) {
        await store.projectAddresses.insert({ projectId, organizationId: row.organizationId, address, key: "https://*.vercel.app", position });
      }
    });
    await opened(backend, lee, projectId);
    expect(await lookup(backend, dana, "https://lee-companya.vercel.app")).toEqual({ status: "none" });
    const notes = await backend.run((store) => projectAddresses.getProjectAddressNotes(store, dana, { projectId }));
    expect(notes.map((note) => note.address)).toEqual(["https://*.vercel.app", "https://*a.vercel.app"]);
    for (const note of notes) {
      expect(note.note).toContain("matches no site now");
      expect(note.note).toContain("Remove it");
      expect(note.note).toContain("https://*-acme.vercel.app");
    }
    await expect(backend.run((store) => projectAddresses.getProjectAddressNotes(store, lee, { projectId }))).rejects.toMatchObject({ code: "forbidden" });
  });

  test(`${name}: a pattern reached only through a project the person opened asks which project, never shows it at once`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Dana's");
    await setList(backend, dana, projectId, ["https://*-acme.vercel.app", "https://exact.acme.com"]);
    await opened(backend, lee, projectId);
    expect(await found(backend, lee, "https://pr-1-acme.vercel.app")).toEqual({ status: "choose", names: ["Dana's"] });
    // An exact origin, or a member of the organization, still finds it at once.
    expect(await found(backend, lee, "https://exact.acme.com")).toEqual({ status: "found", names: ["Dana's"] });
    expect(await found(backend, dana, "https://pr-1-acme.vercel.app")).toEqual({ status: "found", names: ["Dana's"] });
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

  test(`${name}: a project limited to its organization isn't found by someone who opened it, and refuses them its address operations`, async () => {
    const backend = fresh();
    const acme = await create(backend, dana, "Acme");
    await setList(backend, dana, acme, ["https://acme.example.com"]);
    await join(backend, lee, acme, "member");
    await opened(backend, kim, acme);
    expect(await found(backend, kim, "https://acme.example.com")).toEqual({ status: "found", names: ["Acme"] });

    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId: acme, reviewAccess: "organization" }));

    // Kim's earlier open no longer counts, and the lookup answers as for an origin no project lists.
    expect(await lookup(backend, kim, "https://acme.example.com")).toEqual({ status: "none" });
    const refused = { code: "forbidden", message: ORGANIZATION_ONLY };
    await expect(opened(backend, kim, acme)).rejects.toMatchObject(refused);
    await expect(backend.run((store) => getProjectAddresses(store, kim, { projectId: acme }))).rejects.toMatchObject(refused);
    await expect(setList(backend, kim, acme, ["https://kim.example.com"])).rejects.toMatchObject(refused);
    await expect(backend.run((store) => addProjectAddress(store, kim, { projectId: acme, address: "https://kim.example.com" }))).rejects.toMatchObject(refused);
    await expect(backend.run((store) => removeProjectAddress(store, kim, { projectId: acme, address: "https://acme.example.com" }))).rejects.toMatchObject(refused);

    // Members still find it, its owner still manages it, and the list is unchanged.
    expect(await found(backend, lee, "https://acme.example.com")).toEqual({ status: "found", names: ["Acme"] });
    expect(await found(backend, dana, "https://acme.example.com")).toEqual({ status: "found", names: ["Acme"] });
    expect(await backend.run((store) => getProjectAddresses(store, dana, { projectId: acme }))).toEqual(["https://acme.example.com"]);

    // Opening it to anyone again lets Kim's earlier open count again.
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId: acme, reviewAccess: "anyone" }));
    expect(await found(backend, kim, "https://acme.example.com")).toEqual({ status: "found", names: ["Acme"] });
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

  const add = (backend: ContractBackend, who: Identity, projectId: string, address: string) =>
    backend.run((store) => addProjectAddress(store, who, { projectId, address }));
  const remove = (backend: ContractBackend, who: Identity, projectId: string, address: string) =>
    backend.run((store) => removeProjectAddress(store, who, { projectId, address }));
  const listOf = (backend: ContractBackend, who: Identity, projectId: string) => backend.run((store) => getProjectAddresses(store, who, { projectId }));
  const createKeyed = (backend: ContractBackend, who: Identity, projectName: string, idempotencyKey?: string) =>
    backend.run((store) => ops.createProject(store, who, { name: projectName, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }));
  const manageable = async (backend: ContractBackend, who: Identity | null) => {
    const result = await backend.run((store) => listManageableProjects(store, who));
    return { names: result.projects.map((project) => project.name), complete: result.complete, owner: result.projects.every((project) => project.isOwner) };
  };

  test(`${name}: adding one address normalizes it, lists it last, and adding it again changes nothing`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    await setList(backend, dana, projectId, ["https://acme.com"]);
    expect(await add(backend, dana, projectId, "HTTPS://Staging.Acme.com:443/")).toEqual(["https://acme.com", "https://staging.acme.com"]);
    expect(await add(backend, dana, projectId, "https://staging.acme.com")).toEqual(["https://acme.com", "https://staging.acme.com"]);
    expect(await add(backend, dana, projectId, "https://*-Acme.vercel.app")).toEqual(["https://acme.com", "https://staging.acme.com", "https://*-acme.vercel.app"]);
    expect(await listOf(backend, dana, projectId)).toEqual(["https://acme.com", "https://staging.acme.com", "https://*-acme.vercel.app"]);
    // The lookup finds what was added, exact and by pattern.
    expect(await found(backend, dana, "https://staging.acme.com")).toEqual({ status: "found", names: ["Acme"] });
    expect(await found(backend, dana, "https://pr-7-acme.vercel.app")).toEqual({ status: "found", names: ["Acme"] });

    for (const [address, message] of [
      ["https://acme.com/app", "without a path"],
      ["http://acme.com", "Plain http://"],
      ["https://*.com", "matches too much"],
      ["https://acme .com", "space or line break"],
    ]) {
      await expect(add(backend, dana, projectId, address!)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(message!) });
    }
    expect(await listOf(backend, dana, projectId)).toHaveLength(3);
  });

  test(`${name}: adding stops at ${MAX_PROJECT_ADDRESSES} addresses, except for one already listed`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    const full = Array.from({ length: MAX_PROJECT_ADDRESSES }, (_, index) => `https://pr-${index}.acme.com`);
    await setList(backend, dana, projectId, full.slice(0, -1));
    expect(await add(backend, dana, projectId, full.at(-1)!)).toEqual(full);
    await expect(add(backend, dana, projectId, "https://one-more.acme.com")).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining(`up to ${MAX_PROJECT_ADDRESSES} addresses`),
    });
    expect(await add(backend, dana, projectId, "https://PR-3.acme.com")).toEqual(full);
    expect(await listOf(backend, dana, projectId)).toEqual(full);
  });

  test(`${name}: two panels adding at once keep both addresses, where replacing the list loses one`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    await join(backend, kim, projectId, "admin");
    await setList(backend, dana, projectId, ["https://acme.com"]);

    // Replacing the whole list from what each panel read loses one of them.
    const [readByDana, readByKim] = await Promise.all([listOf(backend, dana, projectId), listOf(backend, kim, projectId)]);
    await Promise.all([
      setList(backend, dana, projectId, [...readByDana, "https://one.acme.com"]),
      setList(backend, kim, projectId, [...readByKim, "https://two.acme.com"]),
    ]);
    expect(await listOf(backend, dana, projectId)).toHaveLength(2);

    await setList(backend, dana, projectId, ["https://acme.com"]);
    await Promise.all([add(backend, dana, projectId, "https://one.acme.com"), add(backend, kim, projectId, "https://two.acme.com")]);
    expect([...(await listOf(backend, dana, projectId))].sort()).toEqual(["https://acme.com", "https://one.acme.com", "https://two.acme.com"]);
    expect(await found(backend, dana, "https://one.acme.com")).toEqual({ status: "found", names: ["Acme"] });
    expect(await found(backend, dana, "https://two.acme.com")).toEqual({ status: "found", names: ["Acme"] });
  });

  test(`${name}: removing one address keeps the others in order, and removing one not listed changes nothing`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    await setList(backend, dana, projectId, ["https://a.acme.com", "https://b.acme.com", "https://c.acme.com"]);
    expect(await remove(backend, dana, projectId, "HTTPS://B.Acme.com/")).toEqual(["https://a.acme.com", "https://c.acme.com"]);
    expect(await remove(backend, dana, projectId, "https://b.acme.com")).toEqual(["https://a.acme.com", "https://c.acme.com"]);
    expect(await add(backend, dana, projectId, "https://d.acme.com")).toEqual(["https://a.acme.com", "https://c.acme.com", "https://d.acme.com"]);
    expect(await listOf(backend, dana, projectId)).toEqual(["https://a.acme.com", "https://c.acme.com", "https://d.acme.com"]);
    expect(await lookup(backend, dana, "https://b.acme.com")).toEqual({ status: "none" });
    await expect(remove(backend, dana, projectId, "not an address")).rejects.toMatchObject({ code: "invalid" });
  });

  test(`${name}: only the project's owners add or remove an address`, async () => {
    const backend = fresh();
    const projectId = await create(backend, dana, "Acme");
    await join(backend, lee, projectId, "member");
    await join(backend, kim, projectId, "admin");
    for (const who of [lee, reviewer("Riley")]) {
      await expect(add(backend, who, projectId, "https://acme.com")).rejects.toMatchObject({ code: "forbidden" });
      await expect(remove(backend, who, projectId, "https://acme.com")).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(add(backend, null as unknown as Identity, projectId, "https://acme.com")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(add(backend, dana, "not-a-project", "https://acme.com")).rejects.toMatchObject({ code: "not-found" });
    expect(await add(backend, kim, projectId, "https://acme.com")).toEqual(["https://acme.com"]);
    expect(await remove(backend, kim, projectId, "https://acme.com")).toEqual([]);
  });

  test(`${name}: a project from before organizations moves into its creator's organization when an address is added`, async () => {
    const backend = fresh();
    const projectId = await backend.run(async (store) => {
      const userId = await store.users.insert({ tokenIdentifier: dana.tokenIdentifier, name: "Dana", email: dana.email, imageUrl: null });
      return await store.projects.insert({ name: "From before", tags: [], createdBy: userId, createdAt: Date.now() });
    });
    expect(await add(backend, dana, projectId, "https://old.acme.com")).toEqual(["https://old.acme.com"]);
    expect(await found(backend, dana, "https://old.acme.com")).toEqual({ status: "found", names: ["From before"] });
  });

  test(`${name}: a create retried with the same key returns the same project, and a create without one makes another`, async () => {
    const backend = fresh();
    const key = "6f1c2e0a-9b7d-4c4e-8a51-2f3d4e5a6b7c";
    const first = await createKeyed(backend, dana, "acme.com", key);
    expect(await createKeyed(backend, dana, "acme.com", key)).toBe(first);
    // The key names the request, whatever else the retry says.
    expect(await createKeyed(backend, dana, "Something else", key)).toBe(first);
    const other = await createKeyed(backend, dana, "acme.com", "another-key-0001");
    expect(other).not.toBe(first);
    // Older clients send no key and get a new project each time, as before.
    const plainA = await createKeyed(backend, dana, "acme.com");
    const plainB = await createKeyed(backend, dana, "acme.com");
    expect(new Set([first, other, plainA, plainB]).size).toBe(4);
    const mine = await backend.run((store) => ops.listMyProjects(store, dana, { numItems: 40, cursor: null }));
    expect(mine.page.map((project) => project._id).sort()).toEqual([first, other, plainA, plainB].sort());

    for (const bad of ["short", "has space in it", "ü-is-not-allowed", "x".repeat(101)]) {
      await expect(createKeyed(backend, dana, "acme.com", bad)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("idempotency key") });
    }
  });

  test(`${name}: another person's identical key is a different request`, async () => {
    const backend = fresh();
    const key = "shared-key-123456";
    const danas = await createKeyed(backend, dana, "acme.com", key);
    const lees = await createKeyed(backend, lee, "acme.com", key);
    expect(lees).not.toBe(danas);
    expect(await createKeyed(backend, lee, "acme.com", key)).toBe(lees);
    expect((await backend.run((store) => ops.getProject(store, lee, { projectId: lees }))).isOwner).toBe(true);
    expect((await backend.run((store) => ops.getProject(store, lee, { projectId: danas }))).isOwner).toBe(false);
  });

  test(`${name}: a retried create uses the plan's allowance once, and a key is kept for a day`, async () => {
    const plans: Record<string, Plan> = { free: { name: "free", label: "Free", limits: [{ metric: "projects", period: "total", max: 5 }] } };
    const backend = fresh().withPlans(plans);
    const start = Date.UTC(2026, 10, 1, 12);
    setSystemTime(new Date(start));
    const first = await createKeyed(backend, dana, "acme.com", "retry-key-000001");
    setSystemTime(new Date(start + ops.CREATE_KEY_MS - 1));
    for (let attempt = 0; attempt < 3; attempt++) expect(await createKeyed(backend, dana, "acme.com", "retry-key-000001")).toBe(first);
    const usage = await backend.run((store) => ops.getUsage(store, dana, { projectId: first }));
    expect(usage?.rows).toEqual([expect.objectContaining({ metric: "projects", used: 1, max: 5 })]);

    // After a day the key is forgotten: the same key makes a new project, and is kept for that one.
    setSystemTime(new Date(start + ops.CREATE_KEY_MS));
    const second = await createKeyed(backend, dana, "acme.com", "retry-key-000001");
    expect(second).not.toBe(first);
    expect(await createKeyed(backend, dana, "acme.com", "retry-key-000001")).toBe(second);
    // Expired keys are removed as the person makes new ones.
    await createKeyed(backend, dana, "acme.com", "later-key-000002");
    const kept = await backend.run(async (store) => {
      const userId = (await store.users.byToken(dana.tokenIdentifier))!._id;
      return {
        expired: await store.projectCreations.find(userId, "retry-key-000001"),
        later: await store.projectCreations.find(userId, "later-key-000002"),
      };
    });
    expect(kept.expired).toMatchObject({ projectId: second });
    expect(kept.later).not.toBeNull();
    setSystemTime(new Date(start + 3 * ops.CREATE_KEY_MS));
    await createKeyed(backend, dana, "acme.com", "third-key-0000003");
    expect(
      await backend.run(async (store) => {
        const userId = (await store.users.byToken(dana.tokenIdentifier))!._id;
        return [await store.projectCreations.find(userId, "retry-key-000001"), await store.projectCreations.find(userId, "later-key-000002")];
      }),
    ).toEqual([null, null]);
  });

  test(`${name}: the projects a person may add a site to are those they manage, as admin or as their creator`, async () => {
    const backend = fresh();
    const alpha = await create(backend, dana, "Alpha");
    const beta = await create(backend, dana, "Beta");
    await join(backend, kim, alpha, "admin");
    await join(backend, lee, alpha, "member");
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId: alpha }))).organization!.id;
    const leesInDanas = await backend.run((store) => ops.createProject(store, lee, { name: "Gamma", organizationId }));
    await create(backend, lee, "Lee's own");

    expect(await manageable(backend, dana)).toEqual({ names: ["Alpha", "Beta", "Gamma"], complete: true, owner: true });
    // An admin manages every project in the organization, though they created none of them.
    expect(await manageable(backend, kim)).toEqual({ names: ["Alpha", "Beta", "Gamma"], complete: true, owner: true });
    // A member manages only what they created.
    expect(await manageable(backend, lee)).toEqual({ names: ["Gamma", "Lee's own"], complete: true, owner: true });
    expect(await manageable(backend, reviewer("Riley"))).toEqual({ names: [], complete: true, owner: true });
    await expect(manageable(backend, null)).rejects.toMatchObject({ code: "unauthenticated" });

    // The list matches who may change a list.
    expect(await add(backend, kim, beta, "https://beta.acme.com")).toEqual(["https://beta.acme.com"]);
    expect(await add(backend, lee, leesInDanas, "https://gamma.acme.com")).toEqual(["https://gamma.acme.com"]);
    await expect(add(backend, lee, beta, "https://beta.acme.com")).rejects.toMatchObject({ code: "forbidden" });

    // Leaving the organization ends managing what they created there.
    await backend.run(async (store) => {
      const leeId = (await store.users.byToken(lee.tokenIdentifier))!._id;
      await store.memberships.delete((await store.memberships.find(organizationId, leeId))!._id);
    });
    expect(await manageable(backend, lee)).toEqual({ names: ["Lee's own"], complete: true, owner: true });
    await expect(add(backend, lee, leesInDanas, "https://gamma2.acme.com")).rejects.toMatchObject({ code: "forbidden" });
    // Demoting an admin to member ends managing projects others created.
    await backend.run(async (store) => {
      const kimId = (await store.users.byToken(kim.tokenIdentifier))!._id;
      await store.memberships.patch((await store.memberships.find(organizationId, kimId))!._id, { role: "member" });
    });
    expect(await manageable(backend, kim)).toEqual({ names: [], complete: true, owner: true });
  });

  test(`${name}: an admin of a large organization gets at most ${MAX_MANAGEABLE_PROJECTS} projects, marked incomplete`, async () => {
    const backend = fresh();
    const first = await create(backend, dana, "Project 000");
    await join(backend, kim, first, "admin");
    await backend.run(async (store) => {
      const project = (await store.projects.get(first))!;
      for (let index = 1; index <= MAX_MANAGEABLE_PROJECTS + 5; index++) {
        await store.projects.insert({ name: `Project ${String(index).padStart(3, "0")}`, tags: [], createdBy: project.createdBy, createdAt: Date.now(), organizationId: project.organizationId! });
      }
    });
    const result = await manageable(backend, kim);
    expect(result.complete).toBe(false);
    expect(result.names).toHaveLength(MAX_MANAGEABLE_PROJECTS);
    expect(result.names[0]).toBe("Project 000");
    // The creator, who also created them all, gets the same bounded answer.
    expect((await manageable(backend, dana)).complete).toBe(false);
  });

  test(`${name}: removing an address a project doesn't list changes nothing, even on a project from before organizations`, async () => {
    const backend = fresh();
    const projectId = await backend.run(async (store) => {
      const userId = await store.users.insert({ tokenIdentifier: dana.tokenIdentifier, name: "Dana", email: dana.email, imageUrl: null });
      return await store.projects.insert({ name: "From before", tags: [], createdBy: userId, createdAt: Date.now() });
    });
    expect(await remove(backend, dana, projectId, "https://absent.acme.com")).toEqual([]);
    expect((await backend.run((store) => store.projects.get(projectId)))!.organizationId).toBeUndefined();
  });

  test(`${name}: a retry with its key returns the project even when its other arguments would be refused`, async () => {
    const backend = fresh();
    const first = await createKeyed(backend, dana, "acme.com", "retry-key-blank01");
    expect(await createKeyed(backend, dana, "   ", "retry-key-blank01")).toBe(first);
    await expect(createKeyed(backend, dana, "   ", "fresh-key-blank02")).rejects.toMatchObject({ code: "invalid" });
  });

  test(`${name}: a create without a key also removes the person's expired keys`, async () => {
    const backend = fresh();
    const start = Date.UTC(2026, 10, 1, 12);
    setSystemTime(new Date(start));
    await createKeyed(backend, dana, "acme.com", "expiring-key-0001");
    setSystemTime(new Date(start + ops.CREATE_KEY_MS + 1));
    await createKeyed(backend, dana, "plain.acme.com");
    const kept = await backend.run(async (store) => store.projectCreations.find((await store.users.byToken(dana.tokenIdentifier))!._id, "expiring-key-0001"));
    expect(kept).toBeNull();
  });

  test(`${name}: the manageable list finds a newer project behind many older ones the person no longer manages`, async () => {
    const backend = fresh();
    const theirs = await create(backend, dana, "Dana's");
    await join(backend, lee, theirs, "member");
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId: theirs }))).organization!.id;
    await backend.run(async (store) => {
      const leeId = (await ops.requireUser(store, lee))._id;
      for (let index = 0; index < 2 * MAX_MANAGEABLE_PROJECTS + 5; index++) {
        await store.projects.insert({ name: `Old ${index}`, tags: [], createdBy: leeId, createdAt: Date.now(), organizationId });
      }
      await store.memberships.delete((await store.memberships.find(organizationId, leeId))!._id);
    });
    await create(backend, lee, "Lee's newest");
    expect(await manageable(backend, lee)).toEqual({ names: ["Lee's newest"], complete: true, owner: true });
  });

  test(`${name}: many older memberships where the person manages nothing don't hide their own project`, async () => {
    const backend = fresh();
    await backend.run(async (store) => {
      const leeId = (await ops.requireUser(store, lee))._id;
      for (let index = 0; index < 150; index++) {
        const organizationId = await store.organizations.insert({ name: `Team ${index}`, createdBy: leeId, createdAt: Date.now() });
        await store.memberships.insert({ organizationId, userId: leeId, role: "member", createdAt: Date.now() });
      }
    });
    await create(backend, lee, "Lee's own");
    expect(await manageable(backend, lee)).toEqual({ names: ["Lee's own"], complete: true, owner: true });
  });
}
