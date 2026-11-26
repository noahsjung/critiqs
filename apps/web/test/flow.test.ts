import { describe, expect, test } from "bun:test";
import {
  addressToCheck,
  canGoBack,
  clearFlow,
  clearFlowOnSignOut,
  defaultProjectName,
  developerErrors,
  type FlowAction,
  flowReducer,
  type FlowState,
  initialFlow,
  pendingCreate,
  restoreFlow,
  reviewUrlOf,
  saveFlow,
  savePendingCreate,
} from "../src/flow.ts";
import { Session } from "../src/shared.ts";

// Onboarding's flow as data: three screens, sign-in between the first two,
// one choice that creates the project, and the questions after it, through
// the reducer the page dispatches to.

const ME = "sam@acme.com";
const SAM = { id: "r1", email: ME };
const LEE = { id: "r2", email: "lee@acme.com" };
const run = (actions: FlowAction[], from: FlowState = initialFlow(null)) => actions.reduce(flowReducer, from);
const PROJECT = { id: "k57abcdefghijklmnop", name: "acme-proto", reviewUrl: "https://acme-proto.vercel.app/", stack: null };
const atWho = (text = "acme-proto.vercel.app") => run([{ type: "address-text", text }, { type: "address-continue" }], initialFlow(SAM));
const atSetup = (who: "me" | "developer" = "me") => {
  const state = flowReducer(atWho(), { type: "choose", who, key: "k1" });
  return flowReducer(state, { type: "created", key: "k1", project: PROJECT });
};

describe("the three screens", () => {
  test("the link, then who adds Critiqs, then the command or the email", () => {
    const state = initialFlow(SAM);
    expect(state.step).toBe("address");
    expect(atWho().step).toBe("who");
    expect(atSetup().step).toBe("setup");
  });

  test("someone signed out who continues stays on the first screen until sign-in finishes, keeping the link", () => {
    const waiting = run([{ type: "address-text", text: "acme-proto.vercel.app" }, { type: "address-continue" }]);
    expect(waiting.step).toBe("address");
    expect(waiting.address.url).toBe("https://acme-proto.vercel.app/");
    const signedIn = flowReducer(waiting, { type: "signed-in", reviewer: SAM });
    expect(signedIn.step).toBe("who");
    expect(signedIn.address.text).toBe("acme-proto.vercel.app");
  });

  test("signing in before continuing stays on the first screen", () => {
    expect(run([{ type: "signed-in", reviewer: SAM }]).step).toBe("address");
  });

  test("It's not online yet moves on with no address", () => {
    const state = run([{ type: "address-text", text: "half typed" }, { type: "address-none" }], initialFlow(SAM));
    expect(state.step).toBe("who");
    expect(state.address.url).toBeNull();
    expect(reviewUrlOf(state.address)).toBeNull();
    expect(defaultProjectName(state.address)).toBe("My prototype");
  });

  test("an empty or unusable link says what to do and stays", () => {
    expect(run([{ type: "address-continue" }], initialFlow(SAM)).address.error).toBe("Paste a link, or choose It's not online yet.");
    const typo = run([{ type: "address-text", text: "my prototype" }, { type: "address-continue" }], initialFlow(SAM));
    expect(typo.step).toBe("address");
    expect(typo.address.error).toBe("That doesn't look like a link. Try something like your-app.vercel.app.");
    // Typing again clears the error.
    expect(flowReducer(typo, { type: "address-text", text: "acme.com" }).address.error).toBeNull();
  });

  test("Back from the choice returns to the link, which must be confirmed again; there's no Back once the project exists", () => {
    const back = flowReducer(atWho(), { type: "back" });
    expect(back.step).toBe("address");
    expect(back.address).toEqual({ text: "acme-proto.vercel.app", error: null, url: undefined });
    expect(canGoBack(atSetup())).toBe(false);
    expect(flowReducer(atSetup(), { type: "back" }).step).toBe("setup");
  });
});

describe("choosing creates the project", () => {
  test("choosing waits for the project: a second choice and Back wait for its answer", () => {
    const creating = flowReducer(atWho(), { type: "choose", who: "developer", key: "k1" });
    expect(creating).toMatchObject({ who: "developer", create: { status: "creating", key: "k1", sent: false }, step: "who" });
    expect(flowReducer(creating, { type: "choose", who: "me", key: "k2" }).who).toBe("developer");
    expect(canGoBack(creating)).toBe(false);
    expect(flowReducer(creating, { type: "back" }).step).toBe("who");
  });

  test("a failed create stays with the server's message, and can be tried again", () => {
    const creating = flowReducer(atWho(), { type: "choose", who: "me", key: "k1" });
    const failed = flowReducer(creating, { type: "create-failed", key: "k1", message: "Your plan allows 3 projects.", limit: true });
    expect(failed).toMatchObject({ step: "who", create: { status: "failed", message: "Your plan allows 3 projects.", limit: true } });
    expect(flowReducer(failed, { type: "choose", who: "developer", key: "k2" }).create.status).toBe("creating");
  });

  test("each result names its attempt: one for an attempt that isn't pending changes nothing", () => {
    const first = flowReducer(atWho(), { type: "choose", who: "me", key: "k1" });
    const second = run([{ type: "create-cancelled", key: "k1" }, { type: "choose", who: "developer", key: "k2" }], first);
    for (const late of [
      { type: "create-sent", key: "k1" },
      { type: "created", key: "k1", project: PROJECT },
      { type: "create-failed", key: "k1", message: "x", limit: false },
      { type: "create-cancelled", key: "k1" },
    ] satisfies FlowAction[]) {
      expect(flowReducer(second, late)).toEqual(second);
    }
    expect(flowReducer(second, { type: "create-sent", key: "k2" }).create).toEqual({ status: "creating", key: "k2", sent: true });
  });

  test("the setup screen can switch between the command and the email", () => {
    expect(flowReducer(atSetup("me"), { type: "switch-who" }).who).toBe("developer");
    expect(flowReducer(atSetup("developer"), { type: "switch-who" }).who).toBe("me");
  });

  test("the project's name is the first part of the link's host, never a web address", () => {
    expect(defaultProjectName(atWho().address)).toBe("acme-proto");
    expect(defaultProjectName(atWho("www.acme.com/app").address)).toBe("acme");
    expect(defaultProjectName(atWho("192.168.1.4:3000").address)).toBe("My prototype");
    expect(defaultProjectName(atWho("localhost:5173").address)).toBe("localhost");
  });
});

describe("one reviewer's flow", () => {
  test("another reviewer signing in starts fresh: nothing from the first carries over", () => {
    const state = flowReducer(atSetup(), { type: "signed-in", reviewer: LEE });
    expect(state).toEqual(initialFlow(LEE, atSetup().flow + 1));
  });

  test("signing out starts over", () => {
    expect(flowReducer(atSetup(), { type: "signed-out" })).toEqual(initialFlow(null, 1));
  });

  test("a create that finishes after the reviewer changed is dropped", () => {
    const creating = flowReducer(atWho(), { type: "choose", who: "me", key: "k1" });
    const lee = flowReducer(creating, { type: "signed-in", reviewer: LEE });
    expect(flowReducer(lee, { type: "created", key: "k1", project: PROJECT })).toEqual(lee);
    expect(flowReducer(lee, { type: "create-failed", key: "k1", message: "x", limit: false })).toEqual(lee);
  });
});

describe("while you're here", () => {
  test("shown only after the setup screen's action, then team size, then role, each answered or skipped, then done", () => {
    let state = atSetup();
    expect(state.about).toEqual({ asking: "team-size", shown: false });
    expect(flowReducer(atWho(), { type: "setup-done", flow: 0 }).about.shown).toBe(false);
    // An earlier flow's setup, finishing late, shows nothing.
    expect(flowReducer(state, { type: "setup-done", flow: state.flow - 1 }).about.shown).toBe(false);
    state = flowReducer(state, { type: "setup-done", flow: state.flow });
    expect(state.about).toEqual({ asking: "team-size", shown: true });
    state = flowReducer(state, { type: "about-answered" });
    expect(state.about.asking).toBe("role");
    state = flowReducer(state, { type: "about-skip" });
    expect(state.about.asking).toBeNull();
    expect(flowReducer(state, { type: "about-skip" })).toEqual(state);
  });
});

describe("addresses", () => {
  test("https:// is added to a bare host, http:// to one on this computer or a private network", () => {
    expect(addressToCheck("acme-proto.vercel.app")?.href).toBe("https://acme-proto.vercel.app/");
    expect(addressToCheck("  acme.com/app?x=1 ")?.href).toBe("https://acme.com/app?x=1");
    expect(addressToCheck("localhost:5173")?.href).toBe("http://localhost:5173/");
    // Tailscale's *.ts.net names serve HTTPS, so a bare one gets https://, as public hosts do.
    expect(addressToCheck("my-box.tail1234.ts.net:8443/app")?.href).toBe("https://my-box.tail1234.ts.net:8443/app");
    expect(addressToCheck("192.168.1.4:3000")?.href).toBe("http://192.168.1.4:3000/");
    expect(addressToCheck("http://staging.acme.com")?.href).toBe("http://staging.acme.com/");
    expect(addressToCheck("[::1]:3000")?.href).toBe("http://[::1]:3000/");
  });

  test("anything else isn't a link: another scheme, a sign-in in the address, or a host with spaces or symbols", () => {
    for (const text of ["", "ftp://acme.com", "https://user:pass@acme.com", "my prototype", "acme .com", "https://acme_proto.com"]) expect(addressToCheck(text)).toBeNull();
  });

  test("only HTTPS, or HTTP on this computer, becomes the review address", () => {
    expect(reviewUrlOf(atWho("localhost:5173").address)).toBe("http://localhost:5173/");
    expect(reviewUrlOf(atWho("http://acme.com").address)).toBeNull();
    expect(reviewUrlOf(atWho().address)).toBe("https://acme-proto.vercel.app/");
  });
});

describe("developer emails", () => {
  test("an invalid, repeated, or own address has an error; empty fields are fine", () => {
    expect(developerErrors(["dev@acme", "dev@acme.com", "DEV@acme.com ", "", ME], ME)).toEqual([
      "Enter a valid email address.",
      null,
      "You already entered DEV@acme.com.",
      null,
      "That's your own address. Enter your developer's.",
    ]);
  });

  test("the server's address rules: no trailing dot, double dot, or dot before the @", () => {
    expect(developerErrors(["a@acme.com.", "a..b@acme.com", "a.@acme.com", "a b@acme.com", "ok.name+tag@acme.co"], null)).toEqual([
      "Enter a valid email address.",
      "Enter a valid email address.",
      "Enter a valid email address.",
      "Enter a valid email address.",
      null,
    ]);
  });

  test("addresses are compared by inbox, as the server counts them: a +tag or Gmail's dots are the same inbox", () => {
    expect(developerErrors(["dev+a@acme.com", "dev+b@acme.com", "dev@acme.com"], null)).toEqual([null, "You already entered dev+b@acme.com.", "You already entered dev@acme.com."]);
    expect(developerErrors(["s.a.m+work@gmail.com"], "sam@gmail.com")).toEqual(["That's your own address. Enter your developer's."]);
  });

  test("at most three fields", () => {
    expect(flowReducer(atSetup("developer"), { type: "developers", developers: ["a@x.co", "b@x.co", "c@x.co", "d@x.co"] }).developers).toEqual(["a@x.co", "b@x.co", "c@x.co"]);
  });
});

describe("keeping the flow across a reload", () => {
  const memory = (): Storage => {
    const items = new Map<string, string>();
    return {
      get length() {
        return items.size;
      },
      clear: () => items.clear(),
      getItem: (key) => items.get(key) ?? null,
      key: (index) => [...items.keys()][index] ?? null,
      removeItem: (key) => void items.delete(key),
      setItem: (key, value) => void items.set(key, value),
    };
  };

  test("restores the same person's screen and project", () => {
    const storage = memory();
    const state = flowReducer(atSetup("developer"), { type: "developers", developers: ["dev@acme.com"] });
    saveFlow(storage, state);
    expect(restoreFlow(storage, SAM)).toEqual(state);
  });

  test("another reviewer, or nobody signed in, starts fresh, and the draft is removed", () => {
    const storage = memory();
    saveFlow(storage, atSetup());
    expect(restoreFlow(storage, { id: "r3", email: ME })).toEqual(initialFlow({ id: "r3", email: ME }));
    expect(storage.length).toBe(0);
    saveFlow(storage, atSetup());
    expect(restoreFlow(storage, null)).toEqual(initialFlow(null));
    expect(storage.length).toBe(0);
    // A flow with nobody signed in saves nothing and removes the draft.
    saveFlow(storage, atSetup());
    saveFlow(storage, flowReducer(atSetup(), { type: "signed-out" }));
    expect(storage.length).toBe(0);
    saveFlow(storage, atSetup());
    clearFlow(storage);
    expect(storage.length).toBe(0);
  });

  test("signing out of the session, on any page, removes the draft; a sign-in doesn't", async () => {
    const SIGN_IN = "https://signin.example";
    const claims = btoa(JSON.stringify({ sub: "r1", name: "Sam", email: ME })).replace(/=+$/, "");
    const sessions = memory();
    sessions.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `x.${claims}.y`, refreshToken: "r", expiresAt: Date.now() + 3_600_000 }));
    const session = new Session(SIGN_IN, sessions, async () => new Response(null, { status: 204 }));
    const drafts = memory();
    saveFlow(drafts, atWho());
    const stop = clearFlowOnSignOut(session, drafts);
    expect(restoreFlow(drafts, SAM).step).toBe("who");
    await session.signOut();
    expect(drafts.length).toBe(0);
    stop();
  });

  test("a create pending at a reload stays pending only when its request went out under a key kept for this reviewer", () => {
    const storage = memory();
    const sent = run([{ type: "choose", who: "me", key: "k1" }, { type: "create-sent", key: "k1" }], atWho());
    const request = { name: "acme-proto", reviewUrl: PROJECT.reviewUrl, organizationId: null, answers: { codeAccess: "self" as const }, stack: null };
    // Not sent yet, or sent without a key (a backend without create keys): back at the choice.
    saveFlow(storage, flowReducer(atWho(), { type: "choose", who: "me", key: "k1" }));
    expect(restoreFlow(storage, SAM)).toMatchObject({ step: "who", create: { status: "idle" } });
    saveFlow(storage, sent);
    expect(restoreFlow(storage, SAM)).toMatchObject({ step: "who", create: { status: "idle" } });
    // Sent under its key: still pending, to send again.
    savePendingCreate(storage, { reviewerId: SAM.id, key: "k1", project: request });
    expect(restoreFlow(storage, SAM)).toMatchObject({ step: "who", create: { status: "creating", key: "k1", sent: true } });
    expect(pendingCreate(storage, SAM.id, "k1")?.project).toEqual(request);
    // Another attempt's key, or another reviewer's, doesn't count.
    expect(pendingCreate(storage, SAM.id, "k2")).toBeNull();
    expect(pendingCreate(storage, LEE.id, "k1")).toBeNull();
    // Saving the flow with nothing pending drops the key; so does clearing the draft.
    saveFlow(storage, flowReducer(sent, { type: "created", key: "k1", project: PROJECT }));
    expect(pendingCreate(storage, SAM.id, "k1")).toBeNull();
    savePendingCreate(storage, { reviewerId: SAM.id, key: "k1", project: request });
    clearFlow(storage);
    expect(storage.length).toBe(0);
  });
});
