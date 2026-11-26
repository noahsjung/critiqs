import { describe, expect, test } from "bun:test";
import {
  addressCheckOf,
  addressToCheck,
  canContinue,
  canGoBack,
  clearFlow,
  clearFlowOnSignOut,
  defaultProjectName,
  developerErrors,
  filledDevelopers,
  type FlowAction,
  flowReducer,
  type FlowState,
  initialFlow,
  restoreFlow,
  reviewUrlOf,
  saveFlow,
  savedStack,
  shownCodeAccess,
  STEPS,
} from "../src/flow.ts";
import { Session } from "../src/shared.ts";

// Onboarding's flow as data: every step, Back, Skip, the engineer's default,
// and the developer emails, through the reducer the page dispatches to.

const ME = "sam@acme.com";
const SAM = { id: "r1", email: ME };
const LEE = { id: "r2", email: "lee@acme.com" };
const run = (actions: FlowAction[], from: FlowState = initialFlow(null)) => actions.reduce(flowReducer, from);
const signedIn = () => run([{ type: "signed-in", reviewer: SAM }]);
const checked = (url = "https://acme-proto.vercel.app/") =>
  run([{ type: "address-text", text: url }, { type: "address-check-started", url }, { type: "address-checked", flow: 0, url, check: { kind: "public", stack: "next" } }], signedIn());
const PROJECT = { id: "k57abcdefghijklmnop", name: "My prototype", reviewUrl: null, answers: {}, stack: null, check: { kind: "none" } as const };
/** From a signed-in start to `step`, skipping every question and creating the project on the way. */
const skipTo = (step: (typeof STEPS)[number]) => {
  let state = signedIn();
  while (state.step !== step) state = state.step === "create" ? run([{ type: "create-started" }, { type: "created", flow: state.flow, project: PROJECT }], state) : flowReducer(state, { type: "skip" });
  return state;
};

describe("steps", () => {
  test("sign-in, then one question per step, then creating the project and the recommendation", () => {
    expect(STEPS).toEqual(["sign-in", "address", "role", "team-size", "code-access", "feedback-from", "purpose", "create", "recommendation"]);
  });

  test("signing in moves on to the address; nothing else leaves the sign-in step without it", () => {
    const start = initialFlow(null);
    expect(start.step).toBe("sign-in");
    expect(run([{ type: "next" }, { type: "skip" }], start).step).toBe("sign-in");
    const state = flowReducer(start, { type: "signed-in", reviewer: SAM });
    expect(state).toMatchObject({ step: "address", reviewer: SAM });
  });

  test("someone already signed in starts at the address", () => {
    expect(initialFlow(SAM).step).toBe("address");
  });

  test("every question answered, Continue walks to the create step with every answer kept", () => {
    let state = checked();
    state = run(
      [
        { type: "stack-use" },
        { type: "answer", answer: { role: "designer" } },
        { type: "next" },
        { type: "answer", answer: { teamSize: "6-20" } },
        { type: "next" },
        { type: "answer", answer: { codeAccess: "teammate" } },
        { type: "developers", developers: ["dev@acme.com"] },
        { type: "next" },
        { type: "answer", answer: { feedbackFrom: ["team", "clients"] } },
        { type: "next" },
        { type: "answer", answer: { purpose: "qa" } },
        { type: "next" },
      ],
      state,
    );
    expect(state.step).toBe("create");
    expect(state.answers).toEqual({ role: "designer", teamSize: "6-20", codeAccess: "teammate", feedbackFrom: ["team", "clients"], purpose: "qa" });
    expect(savedStack(state.stack)).toBe("next");
    expect(reviewUrlOf(state.address)).toBe("https://acme-proto.vercel.app/");
    expect(filledDevelopers(state.developers)).toEqual(["dev@acme.com"]);
  });

  test("Continue needs an answer on each question step; Skip is the way on without one", () => {
    for (const step of ["address", "role", "team-size", "code-access", "feedback-from", "purpose"] as const) {
      const state = skipTo(step);
      expect(canContinue(state)).toBe(false);
      expect(flowReducer(state, { type: "next" }).step).toBe(step);
      expect(flowReducer(state, { type: "skip" }).step).toBe(STEPS[STEPS.indexOf(step) + 1]!);
    }
  });

  test("creating the project shows the recommendation; the create step has no Skip", () => {
    const create = skipTo("create");
    expect(flowReducer(create, { type: "skip" }).step).toBe("create");
    expect(flowReducer(create, { type: "next" }).step).toBe("create");
    const done = run([{ type: "create-started" }, { type: "created", flow: create.flow, project: PROJECT }], create);
    expect(done).toMatchObject({ step: "recommendation", project: PROJECT, create: { status: "idle" } });
    expect(flowReducer(done, { type: "skip" }).step).toBe("recommendation");
  });

  test("Start over keeps the sign-in and drops everything else", () => {
    const state = run([{ type: "answer", answer: { role: "founder" } }, { type: "next" }], skipTo("role"));
    const again = flowReducer(state, { type: "start-over" });
    expect(again).toEqual(initialFlow(SAM, state.flow + 1));
  });

  test("signing out starts over at sign-in", () => {
    expect(flowReducer(skipTo("purpose"), { type: "signed-out" })).toEqual(initialFlow(null, 1));
  });
});

describe("one reviewer's flow", () => {
  test("another reviewer signing in starts fresh: nothing from the first carries over", () => {
    const sams = run([{ type: "answer", answer: { role: "founder" } }, { type: "developers", developers: ["dev@acme.com"] }], skipTo("role"));
    const lees = flowReducer(sams, { type: "signed-in", reviewer: LEE });
    expect(lees).toEqual(initialFlow(LEE, sams.flow + 1));
    // The same reviewer signing in again keeps their flow.
    expect(flowReducer(sams, { type: "signed-in", reviewer: SAM })).toEqual(sams);
  });

  test("a result for an earlier flow is dropped: a create or check that finishes after a switch or Start over", () => {
    const creating = flowReducer(skipTo("create"), { type: "create-started" });
    const url = "https://acme.com/";
    for (const next of [
      flowReducer(creating, { type: "signed-in", reviewer: LEE }),
      flowReducer(creating, { type: "signed-out" }),
      flowReducer(creating, { type: "start-over" }),
    ]) {
      const late = run(
        [
          { type: "created", flow: creating.flow, project: PROJECT },
          { type: "create-failed", flow: creating.flow, message: "No.", limit: false },
        ],
        next,
      );
      expect(late).toEqual(next);
    }
    const checking = run([{ type: "address-text", text: "acme.com" }, { type: "address-check-started", url }], signedIn());
    const lees = flowReducer(checking, { type: "signed-in", reviewer: LEE });
    expect(run([{ type: "address-text", text: "acme.com" }, { type: "address-check-started", url }, { type: "address-checked", flow: checking.flow, url, check: { kind: "public", stack: null } }], lees).address.status).toBe("checking");
  });
});

describe("creating the project", () => {
  test("while Create is pending the step stays: Back, a second Create, and edits wait for the answer", () => {
    const create = flowReducer(skipTo("create"), { type: "project-name", name: "Acme" });
    const creating = flowReducer(create, { type: "create-started" });
    expect(creating.create).toEqual({ status: "creating" });
    expect(canGoBack(creating)).toBe(false);
    const tried = run([{ type: "back" }, { type: "create-started" }, { type: "project-name", name: "Other" }, { type: "organization", organizationId: "o2" }], creating);
    expect(tried).toEqual(creating);
    expect(flowReducer(creating, { type: "created", flow: creating.flow, project: PROJECT }).step).toBe("recommendation");
  });

  test("a failed create stays on the step with the server's message, and can be tried again", () => {
    const failed = run([{ type: "create-started" }, { type: "create-failed", flow: 0, message: "Your organization has reached the Free plan's limit of 1 project.", limit: true }], skipTo("create"));
    expect(failed).toMatchObject({ step: "create", create: { status: "failed", limit: true } });
    expect(canGoBack(failed)).toBe(true);
    expect(flowReducer(failed, { type: "create-started" }).create).toEqual({ status: "creating" });
  });

  test("once the project exists there's no Back: the answers before it can't change it", () => {
    const done = skipTo("recommendation");
    expect(canGoBack(done)).toBe(false);
    expect(flowReducer(done, { type: "back" })).toEqual(done);
  });
});

describe("Back", () => {
  test("goes back one step from every step before the project exists, keeping every answer", () => {
    let state = run([{ type: "answer", answer: { role: "founder", teamSize: "just-me", purpose: "qa" } }], skipTo("create"));
    for (let index = STEPS.indexOf("create"); index > 0; index--) {
      expect(state.step).toBe(STEPS[index]!);
      state = flowReducer(state, { type: "back" });
    }
    expect(state.step).toBe("sign-in");
    expect(state.answers).toEqual({ role: "founder", teamSize: "just-me", purpose: "qa" });
    expect(flowReducer(state, { type: "back" }).step).toBe("sign-in");
  });

  test("keeps the checked address and the confirmed stack", () => {
    const state = run([{ type: "stack-use" }, { type: "back" }, { type: "back" }, { type: "next" }], checked());
    expect(state.step).toBe("address");
    expect(state.address.status).toBe("checked");
    expect(savedStack(state.stack)).toBe("next");
  });
});

describe("Skip", () => {
  test("removes only the current step's answer, so it is absent rather than empty", () => {
    const answered = run([{ type: "answer", answer: { role: "designer", teamSize: "2-5" } }], skipTo("role"));
    const skipped = flowReducer(answered, { type: "skip" });
    expect(skipped.answers).toEqual({ teamSize: "2-5" });
    expect("role" in skipped.answers).toBe(false);
  });

  test("on who leaves feedback, removes the whole list", () => {
    const state = run([{ type: "answer", answer: { feedbackFrom: ["clients"] } }, { type: "skip" }], skipTo("feedback-from"));
    expect(state.answers).toEqual({});
  });

  test("choosing none of who leaves feedback is the same as skipping", () => {
    const state = run([{ type: "answer", answer: { feedbackFrom: ["clients"] } }, { type: "answer", answer: { feedbackFrom: [] } }], skipTo("feedback-from"));
    expect(state.answers).toEqual({});
    expect(canContinue(state)).toBe(false);
  });

  test("on the address, drops the address and its stack, which the recommendation reads as no address", () => {
    const state = flowReducer(checked(), { type: "skip" });
    expect(state.step).toBe("role");
    expect(addressCheckOf(state.address)).toEqual({ kind: "none" });
    expect(reviewUrlOf(state.address)).toBeNull();
    expect(savedStack(state.stack)).toBeNull();
  });

  test("every question skipped leaves no answers, no address, and the default project name", () => {
    const state = skipTo("create");
    expect(state.answers).toEqual({});
    expect(addressCheckOf(state.address)).toEqual({ kind: "none" });
    expect(defaultProjectName(state.address)).toBe("My prototype");
  });
});

describe("the address step", () => {
  test("a detected stack is confirmed with Use, which moves on", () => {
    const state = checked();
    expect(state.stack).toEqual({ detected: "next", chosen: null, picking: false });
    const used = flowReducer(state, { type: "stack-use" });
    expect(used.step).toBe("role");
    expect(savedStack(used.stack)).toBe("next");
  });

  test("Change opens the picker on the detected stack, so Continue keeps it", () => {
    const state = run([{ type: "stack-change" }], checked());
    expect(state.stack).toEqual({ detected: "next", chosen: "next", picking: true });
    expect(savedStack(flowReducer(state, { type: "next" }).stack)).toBe("next");
  });

  test("I'm not sure saves no stack", () => {
    const state = run([{ type: "stack-change" }, { type: "stack-pick", stack: "unsure" }, { type: "next" }], checked());
    expect(state.step).toBe("role");
    expect(state.stack.chosen).toBe("unsure");
    expect(savedStack(state.stack)).toBeNull();
  });

  test("no stack detected opens the picker at once", () => {
    const url = "https://example.com/";
    const state = run([{ type: "address-text", text: "example.com" }, { type: "address-check-started", url }, { type: "address-checked", flow: 0, url, check: { kind: "unreachable" } }], signedIn());
    expect(state.stack.picking).toBe(true);
    expect(canContinue(state)).toBe(true);
  });

  test("It's only on my computer and I don't have one yet answer without an address", () => {
    const local = flowReducer(signedIn(), { type: "address-only-local" });
    expect(addressCheckOf(local.address)).toEqual({ kind: "local" });
    expect(reviewUrlOf(local.address)).toBeNull();
    expect(local.stack.picking).toBe(true);
    const none = flowReducer(signedIn(), { type: "address-none" });
    expect(addressCheckOf(none.address)).toEqual({ kind: "none" });
    expect(defaultProjectName(none.address)).toBe("My prototype");
  });

  test("the project name starts as the first part of the address's host, never a web address", () => {
    expect(defaultProjectName(checked().address)).toBe("acme-proto");
    const named = (url: string) => defaultProjectName({ status: "checked", text: url, url, check: { kind: "public", stack: null } });
    expect(named("https://www.acme.com/app")).toBe("acme");
    expect(named("http://localhost:5173/")).toBe("localhost");
    expect(named("http://192.168.1.4:3000/")).toBe("My prototype");
    expect(named("http://[::1]:3000/")).toBe("My prototype");
  });

  test("a check's result for an address the person has since changed is ignored", () => {
    const url = "https://old.example.com/";
    const state = run(
      [{ type: "address-text", text: url }, { type: "address-check-started", url }, { type: "address-text", text: "new.example.com" }, { type: "address-checked", flow: 0, url, check: { kind: "public", stack: null } }],
      signedIn(),
    );
    expect(state.address).toEqual({ status: "editing", text: "new.example.com", error: null });
  });

  test("a failed check keeps the address and shows why", () => {
    const url = "https://acme.com/";
    const state = run([{ type: "address-text", text: "acme.com" }, { type: "address-check-started", url }, { type: "address-check-failed", flow: 0, url, error: "Too many checks." }], signedIn());
    expect(state.address).toEqual({ status: "editing", text: "acme.com", error: "Too many checks." });
  });

  test("an address that isn't one says how to write it", () => {
    const state = run([{ type: "address-text", text: "ftp://files" }, { type: "address-invalid" }], signedIn());
    expect(state.address).toMatchObject({ status: "editing", error: "Enter the full address, starting with https:// or http://." });
  });

  test("https:// is added to a bare host, http:// to one on this computer", () => {
    expect(addressToCheck("acme-proto.vercel.app")?.href).toBe("https://acme-proto.vercel.app/");
    expect(addressToCheck("  acme.com/app?x=1 ")?.href).toBe("https://acme.com/app?x=1");
    expect(addressToCheck("localhost:5173")?.href).toBe("http://localhost:5173/");
    // Tailscale's *.ts.net names serve HTTPS, so a bare one gets https://, as public hosts do.
    expect(addressToCheck("my-box.tail1234.ts.net")?.href).toBe("https://my-box.tail1234.ts.net/");
    expect(addressToCheck("my-box.tail1234.ts.net:8443/app")?.href).toBe("https://my-box.tail1234.ts.net:8443/app");
    expect(addressToCheck("192.168.1.4:3000")?.href).toBe("http://192.168.1.4:3000/");
    expect(addressToCheck("http://staging.acme.com")?.href).toBe("http://staging.acme.com/");
    expect(addressToCheck("ftp://acme.com")).toBeNull();
    expect(addressToCheck("https://user:pass@acme.com")).toBeNull();
    expect(addressToCheck("")).toBeNull();
  });

  test("only HTTPS, or HTTP on this computer, becomes the review address", () => {
    const at = (url: string) => run([{ type: "address-text", text: url }, { type: "address-check-started", url }, { type: "address-checked", flow: 0, url, check: { kind: "unreachable" } }], signedIn());
    expect(reviewUrlOf(at("http://localhost:5173/").address)).toBe("http://localhost:5173/");
    expect(reviewUrlOf(at("http://acme.com/").address)).toBeNull();
  });
});

describe("the engineer's default", () => {
  const atCodeAccess = (role?: "engineer" | "designer") => {
    let state = signedIn();
    state = flowReducer(state, { type: "skip" });
    if (role !== undefined) state = flowReducer(state, { type: "answer", answer: { role } });
    return run([role === undefined ? { type: "skip" } : { type: "next" }, { type: "skip" }], state);
  };

  test("engineers see Yes already chosen, and Continue saves it", () => {
    const state = atCodeAccess("engineer");
    expect(state.step).toBe("code-access");
    expect(state.answers.codeAccess).toBeUndefined();
    expect(shownCodeAccess(state.answers)).toBe("self");
    expect(canContinue(state)).toBe(true);
    expect(flowReducer(state, { type: "next" }).answers.codeAccess).toBe("self");
  });

  test("an engineer who skips saves no answer", () => {
    expect(flowReducer(atCodeAccess("engineer"), { type: "skip" }).answers).toEqual({ role: "engineer" });
  });

  test("an engineer can choose another answer", () => {
    const state = run([{ type: "answer", answer: { codeAccess: "nobody" } }, { type: "developers", developers: [""] }, { type: "next" }], atCodeAccess("engineer"));
    expect(state.answers.codeAccess).toBe("nobody");
  });

  test("anyone else sees nothing chosen", () => {
    expect(shownCodeAccess(atCodeAccess("designer").answers)).toBeUndefined();
    expect(shownCodeAccess(atCodeAccess().answers)).toBeUndefined();
  });
});

describe("developer emails", () => {
  const atDevelopers = (developers: string[]) =>
    run([{ type: "answer", answer: { codeAccess: "teammate" } }, { type: "developers", developers }], skipTo("code-access"));

  test("valid, different addresses continue; empty fields are ignored", () => {
    const state = flowReducer(atDevelopers(["dev@acme.com", "", " Lee@Acme.com "]), { type: "next" });
    expect(state.step).toBe("feedback-from");
    expect(filledDevelopers(state.developers)).toEqual(["dev@acme.com", "Lee@Acme.com"]);
  });

  test("an invalid, repeated, or own address keeps the step and shows each field's error", () => {
    const state = flowReducer(atDevelopers(["dev@acme", "dev@acme.com", "DEV@acme.com ", ME]), { type: "next" });
    expect(state.step).toBe("code-access");
    expect(state.showDeveloperErrors).toBe(true);
    expect(state.developers).toHaveLength(3);
    expect(developerErrors(state.developers, ME)).toEqual(["Enter a valid email address.", null, "You already entered DEV@acme.com."]);
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

  test("their own address, in any case, says to choose Yes", () => {
    expect(developerErrors([" SAM@acme.com"], ME)).toEqual(["That's your address. Choose Yes to see the install steps."]);
  });

  test("addresses are compared by inbox, as the server counts them: a +tag or Gmail's dots are the same inbox", () => {
    expect(developerErrors(["dev+a@acme.com", "dev+b@acme.com", "dev@acme.com"], null)).toEqual([null, "You already entered dev+b@acme.com.", "You already entered dev@acme.com."]);
    expect(developerErrors(["s.a.m+work@gmail.com"], "sam@gmail.com")).toEqual(["That's your address. Choose Yes to see the install steps."]);
  });

  test("each refused Continue asks the page to move focus to the first invalid field again", () => {
    const refused = run([{ type: "next" }, { type: "next" }], atDevelopers(["dev@acme"]));
    expect([refused.step, refused.developerCheck]).toEqual(["code-access", 2]);
  });

  test("at most three fields", () => {
    expect(atDevelopers(["a@x.co", "b@x.co", "c@x.co", "d@x.co"]).developers).toEqual(["a@x.co", "b@x.co", "c@x.co"]);
  });

  test("errors aren't checked when Yes is the answer, so the fields don't block", () => {
    const state = run([{ type: "developers", developers: ["not an address"] }, { type: "answer", answer: { codeAccess: "self" } }, { type: "next" }], skipTo("code-access"));
    expect(state.step).toBe("feedback-from");
  });

  test("nothing is sent at this step: the reducer only keeps the fields", () => {
    const state = flowReducer(atDevelopers(["dev@acme.com"]), { type: "next" });
    expect(state.project).toBeNull();
    expect(state.developers).toEqual(["dev@acme.com"]);
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

  test("restores the same person's answers and step", () => {
    const storage = memory();
    const state = run([{ type: "answer", answer: { role: "founder" } }, { type: "next" }], skipTo("role"));
    saveFlow(storage, state);
    expect(restoreFlow(storage, SAM)).toEqual(state);
  });

  test("another reviewer, even with the same address, or nobody signed in, starts fresh, and the draft is removed", () => {
    const storage = memory();
    saveFlow(storage, skipTo("purpose"));
    expect(restoreFlow(storage, { id: "r3", email: ME })).toEqual(initialFlow({ id: "r3", email: ME }));
    expect(storage.length).toBe(0);
    saveFlow(storage, skipTo("purpose"));
    expect(restoreFlow(storage, null)).toEqual(initialFlow(null));
    expect(storage.length).toBe(0);
    // Signing out saves nothing and removes the draft.
    saveFlow(storage, skipTo("purpose"));
    saveFlow(storage, flowReducer(skipTo("purpose"), { type: "signed-out" }));
    expect(storage.length).toBe(0);
    saveFlow(storage, skipTo("purpose"));
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
    saveFlow(drafts, run([{ type: "answer", answer: { role: "founder" } }], signedIn()));
    const stop = clearFlowOnSignOut(session, drafts);
    expect(restoreFlow(drafts, SAM).answers).toEqual({ role: "founder" });
    await session.signOut();
    expect(drafts.length).toBe(0);
    stop();
  });

  test("a create pending at a reload restores as not started; it isn't deduplicated", () => {
    const storage = memory();
    saveFlow(storage, flowReducer(skipTo("create"), { type: "create-started" }));
    expect(restoreFlow(storage, SAM)).toMatchObject({ step: "create", create: { status: "idle" } });
  });

  test("a check that was running starts over as an edit of the same address", () => {
    const storage = memory();
    const url = "https://acme.com/";
    saveFlow(storage, run([{ type: "address-text", text: "acme.com" }, { type: "address-check-started", url }], signedIn()));
    expect(restoreFlow(storage, SAM).address).toEqual({ status: "editing", text: "acme.com", error: null });
  });
});
