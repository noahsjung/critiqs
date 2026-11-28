import { afterEach, expect, test } from "bun:test";
import type { AiSettingsView, PersonalAiSettingsView, SearchResponse } from "@critiqs/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { TagsAiDialog } from "../src/ui/TagsAiDialog.tsx";
import { YourAiDialog } from "../src/ui/YourAiDialog.tsx";
import { type AiDeployment, applyAiSettings, getAiSettings, operations, prepareSettings } from "@critiqs/server";
import { bunDriver, SqliteStore } from "@critiqs/server/sqlite";
import { reviewer } from "@critiqs/server/contract";
import { Database } from "bun:sqlite";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Your AI, a person's own AI connection, offered from the avatar menu where
// the backend keeps it; the project owner's AI settings: on or off, the
// model, who pays, and which Critiqs AI models the project's AI may use; an
// own API key, set up in steps; and "Set up your AI", offered wherever a
// request needs Your AI first. Every setting saves as soon as it changes.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";

const MODELS = [
  { id: "fast", label: "Fast", credits: 1 },
  { id: "strong", label: "Strong", credits: 5, estimated: true as const },
];
/** Nothing saved: Critiqs AI, as everyone has until they choose otherwise. */
const personal: PersonalAiSettingsView = {
  saved: false,
  enabled: true,
  mode: "managed",
  managedModel: null,
  provider: null,
  model: null,
  models: [],
  baseUrl: null,
  keyHint: null,
  deployment: { managed: true, managedModels: MODELS, defaultProvider: null, keysStorable: true, allowedEndpoints: [] },
  status: { ready: true },
  lastTest: null,
};
const project: AiSettingsView = {
  enabled: true,
  mode: "managed",
  managedModel: "fast",
  provider: null,
  model: null,
  models: [],
  baseUrl: null,
  keyHint: null,
  deployment: { managed: true, managedModels: MODELS, defaultProvider: null, keysStorable: true, allowedEndpoints: [] },
  status: { ready: true },
  lastTest: null,
  rule: "either",
  allowedModels: [],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  container?.remove();
  container = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

function backend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
    threads: [],
    personalAiSettings: personal,
    calls: [],
    ...overrides,
  };
}

/** The whole interface, signed in, in a shadow root as on a prototype. */
async function mount(data: FakeBackend, { personalAi = true, sidebar = false } = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  if (sidebar) localStorage.setItem("critiqs:sidebar-open", "true");
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const inner = document.createElement("div");
  shadow.append(inner);
  root = createRoot(inner);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, personalAi } as const;
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(data)}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={host!} shadow={host!.shadowRoot!} />
      </TransportContext.Provider>,
    ),
  );
  await settle();
  return shadow;
}

/** One component on its own, as the tags tests render dialogs. */
async function render(node: ReactNode, data: FakeBackend) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<TransportContext.Provider value={fakeTransport(data)}>{node}</TransportContext.Provider>));
  await settle();
  return container;
}

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text) ?? null;

async function click(element: Element | null | undefined) {
  if (element == null) throw new Error("Nothing to click");
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function type(field: HTMLInputElement | null, text: string) {
  if (field === null) throw new Error("No field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const dialog = (scope: ParentNode, label: string) => scope.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);

async function openYourAi(shadow: ShadowRoot) {
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
  await click(button(shadow, "Your AI…"));
  return dialog(shadow, "Your AI")!;
}

/** The select for the setting named `label`, found by the name it is labelled with. */
function select(scope: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>(".ds-select")].find((candidate) => {
      const [labelId] = candidate.getAttribute("aria-labelledby")!.split(" ");
      return scope.querySelector(`[id="${labelId}"]`)?.textContent === label;
    }) ?? null
  );
}

/** A menu item's own text, without its check mark or detail. */
const itemText = (item: Element) =>
  [...item.childNodes]
    .filter((node) => !(node instanceof Element && (node.classList.contains("check") || node.classList.contains("detail"))))
    .map((node) => node.textContent)
    .join("");

/** The options of the setting named `label`, as [name, detail, chosen], read from its open menu, which is then closed. */
async function options(scope: ParentNode, label: string) {
  await click(select(scope, label));
  const items = [...scope.querySelectorAll('[role="menuitemradio"]')].map((item) => [itemText(item), item.querySelector(".detail")?.textContent ?? null, item.getAttribute("aria-checked") === "true"]);
  await click(select(scope, label));
  return items;
}

/** Chooses `option` for the setting named `label`. */
async function choose(scope: ParentNode, label: string, option: string) {
  await click(select(scope, label));
  await click([...scope.querySelectorAll('[role="menuitemradio"]')].find((item) => itemText(item) === option));
}

/** The row named `label` that opens a page or does one thing. */
const navRow = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button.ds-nav-row")].find((row) => row.querySelector(".label")?.textContent === label) ?? null;

const heading = (scope: ParentNode) => scope.querySelector(".ds-dialog-header h3")?.textContent ?? null;
const keyField = (scope: ParentNode) => scope.querySelector<HTMLInputElement>('input[type="password"]');
const addressField = (scope: ParentNode) => scope.querySelector<HTMLInputElement>('input[placeholder="https://llm.example.com/v1"]');
const modelField = (scope: ParentNode) => scope.querySelector<HTMLInputElement>('input[placeholder="gpt-6.2-sol"]');
const meter = (scope: ParentNode) => scope.querySelector('[role="meter"]');

/** The checked models on the own key's last step. */
const ticked = (scope: ParentNode) => [...scope.querySelectorAll<HTMLInputElement>('[aria-label="Models to offer"] input:checked')].map((box) => box.closest("label")!.textContent);
const modelRow = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll('[aria-label="Models to offer"] label')].find((label) => label.textContent === name)?.querySelector("input") ?? null;

/** Your AI on its own; `modelLists` where the backend lists providers' models. */
function YourAi({ notify = () => undefined, modelLists = false }: { notify?: (message: string) => void; modelLists?: boolean }) {
  return <YourAiDialog onClose={() => undefined} notify={notify} modelLists={modelLists} />;
}

/** The project's AI settings on their own. */
const ProjectAi = ({ modelLists = false }: { modelLists?: boolean }) => (
  <TagsAiDialog projectId="project" initialTab="ai" onClose={() => undefined} notify={() => undefined} modelLists={modelLists} />
);

const lastArgs = (data: FakeBackend) => data.calls!.at(-1)!.args;

test("the avatar menu offers Your AI only where the backend keeps each person's own AI", async () => {
  let shadow = await mount(backend(), { personalAi: false });
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
  expect(button(shadow, "Change display name…")).not.toBeNull();
  expect(button(shadow, "Your AI…")).toBeNull();
  await act(async () => root?.unmount());
  host?.remove();

  shadow = await mount(backend());
  const yourAi = await openYourAi(shadow);
  expect(heading(yourAi)).toBe("Your AI");
  // Nothing saved yet: Critiqs AI's first model, with nothing to turn on, save, or remove.
  expect(select(yourAi, "Model")!.textContent).toBe("Fast");
  expect(navRow(yourAi, "Use your own API key")).not.toBeNull();
  expect(button(yourAi, "Save changes")).toBeNull();
  expect(button(yourAi, "Turn on")).toBeNull();
  await click(button(yourAi, "Close"));
  expect(dialog(shadow, "Your AI")).toBeNull();
});

test("Your AI sets up an own key in steps, sending the key once and showing only its hint", async () => {
  const saved: PersonalAiSettingsView = { ...personal, saved: true, mode: "own", provider: "openai", model: "gpt-test", models: ["gpt-test"], keyHint: "9876" };
  const notes: string[] = [];
  const data = backend({ savePersonalAiSettings: async () => saved });
  const yourAi = await render(<YourAi notify={(note) => notes.push(note)} />, data);
  await click(navRow(yourAi, "Use your own API key"));
  expect(heading(yourAi)).toBe("Choose a provider");
  // Without model lists the key's step names the model and saves: two steps.
  expect(yourAi.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Step 1 of 2");
  await click(navRow(yourAi, "OpenAI"));
  expect(heading(yourAi)).toBe("Add your OpenAI key");
  expect([...yourAi.querySelectorAll("a")].find((link) => link.textContent === "Get a key")!.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
  // OpenAI's own address needs no field where the deployment allows no others.
  expect(addressField(yourAi)).toBeNull();
  expect(button(yourAi, "Save key")!.disabled).toBe(true);
  await type(keyField(yourAi), "sk-new-9876");
  expect(button(yourAi, "Save key")!.disabled).toBe(true);
  await type(modelField(yourAi), "gpt-test");
  await click(button(yourAi, "Save key"));
  expect(data.calls!.filter((call) => call.name === "savePersonalAiSettings").map((call) => call.args)).toEqual([
    { enabled: true, mode: "own", provider: "openai", model: "gpt-test", baseUrl: null, apiKey: "sk-new-9876" },
  ]);
  expect(notes).toEqual(["Your AI saved"]);
  // Back where it started: the key shows only its hint, and its model is the one chosen.
  expect(heading(yourAi)).toBe("Your AI");
  expect(navRow(yourAi, "OpenAI key")!.textContent).toBe("OpenAI key····9876");
  expect(select(yourAi, "Model")!.textContent).toBe("gpt-test");
  expect(yourAi.textContent).not.toContain("sk-new-9876");
});

test("Your AI offers Critiqs AI's models by name, with each one's cost in the open menu, saves a choice at once, and shows why the plan refuses one", async () => {
  const data = backend({
    savePersonalAiSettings: async () => {
      const { ConvexError } = await import("convex/values");
      throw new ConvexError({ code: "limit", message: "Your plan doesn't include Critiqs AI. Connect your own key in Your AI, or choose a plan that includes it." });
    },
  });
  const yourAi = await render(<YourAi />, data);
  expect(select(yourAi, "Model")!.textContent).toBe("Fast");
  expect(await options(yourAi, "Model")).toEqual([
    ["Fast", "1 credit", true],
    ["Strong", "about 5 credits", false],
  ]);
  await choose(yourAi, "Model", "Strong");
  expect(lastArgs(data)).toEqual({ enabled: true, mode: "managed", managedModel: "strong" });
  const refusal = yourAi.querySelector('.error[role="alert"]')!;
  expect(refusal.textContent).toBe("Your plan doesn't include Critiqs AI. Connect your own key in Your AI, or choose a plan that includes it.");
  // Refused, the choice shown is still the saved one.
  expect(select(yourAi, "Model")!.textContent).toBe("Fast");
  // Choosing the chosen model again saves nothing.
  const saves = data.calls!.length;
  await choose(yourAi, "Model", "Fast");
  expect(data.calls!.length).toBe(saves);
});

test("with Critiqs AI, Your AI shows the person's own credits used against their plan, and nothing for an own key", async () => {
  const personalAiUsage = {
    plan: "Team",
    rows: [
      { period: "month" as const, used: 300, max: 10_000 },
      { period: "day" as const, used: 12, max: 500 },
    ],
  };
  let yourAi = await render(<YourAi />, backend({ personalAiUsage }));
  expect(yourAi.textContent).toContain("Team plan");
  expect(yourAi.textContent).toContain("12 of 500 credits used today · 300 of 10,000 credits used this month");
  // The bar shows the period nearest its limit: 3% of the month, against 2.4% of the day.
  expect([meter(yourAi)!.getAttribute("aria-label"), meter(yourAi)!.getAttribute("aria-valuenow"), meter(yourAi)!.getAttribute("aria-valuemax")]).toEqual(["Credits used this month", "300", "10000"]);
  await act(async () => root?.unmount());
  container?.remove();

  yourAi = await render(<YourAi />, backend({ personalAiUsage, personalAiSettings: savedOwn }));
  expect(meter(yourAi)).toBeNull();
  expect(yourAi.textContent).not.toContain("Team plan");
});

test("Upgrade links to the deployment's upgrade page, in a new tab, and shows only where it names one", async () => {
  let yourAi = await render(<YourAi />, backend({ personalAiUsage: { plan: "Free", rows: [{ period: "day", used: 3, max: 50 }], upgradeUrl: "https://critiqs.example/plans" } }));
  const link = [...yourAi.querySelectorAll("a")].find((anchor) => anchor.textContent === "Upgrade")!;
  expect([link.getAttribute("href"), link.getAttribute("target")]).toEqual(["https://critiqs.example/plans", "_blank"]);
  expect(link.getAttribute("rel")).toContain("noopener");
  await act(async () => root?.unmount());
  container?.remove();
  yourAi = await render(<YourAi />, backend({ personalAiUsage: { plan: "Free", rows: [{ period: "day", used: 3, max: 50 }] } }));
  expect(yourAi.textContent).toContain("Free plan");
  expect(yourAi.textContent).not.toContain("Upgrade");
});

test("Your AI marks a used-up allowance, and says when the plan includes no personal Critiqs AI", async () => {
  let yourAi = await render(<YourAi />, backend({ personalAiUsage: { plan: "Team", rows: [{ period: "day", used: 500, max: 500 }] } }));
  expect(meter(yourAi)!.className).toBe("ds-meter full");
  const used = [...yourAi.querySelectorAll('[role="status"]')].find((line) => line.textContent === "500 of 500 credits used today")!;
  expect(used.className).toBe("error");
  await act(async () => root?.unmount());
  container?.remove();

  yourAi = await render(<YourAi />, backend({ personalAiUsage: { plan: "Free", rows: [{ period: "day", used: 0, max: 0 }] } }));
  const none = yourAi.querySelector('.warning[role="status"]')!;
  expect(none.textContent).toBe("The Free plan doesn't include your own Critiqs AI.");
  expect(meter(yourAi)).toBeNull();
});

test("Your AI shows extra credits past what the plan includes, measured against the cap, and used up only at the cap", async () => {
  const row = { period: "month" as const, used: 2_300, max: 2_000, overage: { cap: 2_000 } };
  let yourAi = await render(<YourAi />, backend({ personalAiUsage: { plan: "Plus", rows: [row] } }));
  expect(yourAi.textContent).toContain("2,300 of 2,000 credits used this month · 300 extra, up to 2,000");
  expect([meter(yourAi)!.getAttribute("aria-valuenow"), meter(yourAi)!.getAttribute("aria-valuemax")]).toEqual(["2300", "4000"]);
  expect(yourAi.querySelector('.error[role="status"]')).toBeNull();
  await act(async () => root?.unmount());
  container?.remove();

  yourAi = await render(<YourAi />, backend({ personalAiUsage: { plan: "Plus", rows: [{ ...row, used: 4_000 }] } }));
  expect(yourAi.querySelector('.error[role="status"]')!.textContent).toBe("4,000 of 2,000 credits used this month · 2,000 extra, up to 2,000");
  await act(async () => root?.unmount());
  container?.remove();

  yourAi = await render(<YourAi />, backend({ personalAiUsage: { plan: "Plus", rows: [{ ...row, used: 9_000, overage: { cap: null } }] } }));
  expect(yourAi.textContent).toContain("9,000 of 2,000 credits used this month · 7,000 extra, no cap");
  expect(yourAi.querySelector('.error[role="status"]')).toBeNull();
});

test("Your AI shows no usage without plans, or from a backend without the call", async () => {
  for (const personalAiUsage of [null, "missing"] as const) {
    const yourAi = await render(<YourAi />, backend({ personalAiUsage }));
    expect(select(yourAi, "Model")).not.toBeNull();
    expect(meter(yourAi)).toBeNull();
    expect(yourAi.textContent).not.toContain("plan");
    expect(yourAi.querySelector(".error")).toBeNull();
    await act(async () => root?.unmount());
    container?.remove();
  }
});

const savedOwn: PersonalAiSettingsView = { ...personal, saved: true, mode: "own", provider: "openai", model: "gpt-test", models: ["gpt-test"], keyHint: "1234" };

test("Use Critiqs AI instead asks first, then removes the person's key and keeps focus in the dialog", async () => {
  const notes: string[] = [];
  const data = backend({ personalAiSettings: savedOwn, removePersonalAiSettings: async () => personal });
  const yourAi = await render(<YourAi notify={(note) => notes.push(note)} />, data);
  await click(navRow(yourAi, "Use Critiqs AI instead"));
  expect(data.calls!.some((call) => call.name === "removePersonalAiSettings")).toBe(false);
  expect(yourAi.querySelector('[role="alert"]')!.textContent).toContain("Remove your key and use Critiqs AI?");
  expect(document.activeElement).toBe(button(yourAi, "Keep key")!);
  await click(button(yourAi, "Keep key"));
  expect(data.calls!.some((call) => call.name === "removePersonalAiSettings")).toBe(false);
  await click(navRow(yourAi, "Use Critiqs AI instead"));
  await click(button(yourAi, "Remove key"));
  expect(data.calls!.filter((call) => call.name === "removePersonalAiSettings")).toHaveLength(1);
  expect(notes).toEqual(["Your key was removed. Critiqs AI is back on."]);
  // Back to the default: Critiqs AI's first model.
  expect(select(yourAi, "Model")!.textContent).toBe("Fast");
  expect(navRow(yourAi, "Use your own API key")).not.toBeNull();
  expect(document.activeElement).toBe(yourAi.querySelector('[role="dialog"]')!);
});

test("Keep key gives focus back to the row that asked", async () => {
  const yourAi = await render(<YourAi />, backend({ personalAiSettings: savedOwn }));
  await click(navRow(yourAi, "Use Critiqs AI instead"));
  await click(button(yourAi, "Keep key"));
  expect(document.activeElement).toBe(navRow(yourAi, "Use Critiqs AI instead")!);
});

test("Your AI saved off says so, and Turn on saves its connection, without fields typed meanwhile", async () => {
  const data = backend({ personalAiSettings: { ...savedOwn, enabled: false }, savePersonalAiSettings: async () => savedOwn });
  const yourAi = await render(<YourAi />, data);
  expect(yourAi.querySelector('.warning[role="status"]')!.textContent).toContain("Your AI is off.");
  await click(button(yourAi, "Turn on"));
  expect(data.calls!.at(-1)).toEqual({ name: "savePersonalAiSettings", args: { enabled: true, mode: "own", provider: "openai", model: "gpt-test", baseUrl: null } });
  expect(yourAi.textContent).not.toContain("Your AI is off.");
});

test("a saved Critiqs AI model no longer offered is fixed by saving the first offered one, with one model or several", async () => {
  const retired: PersonalAiSettingsView = { ...personal, saved: true, managedModel: "retired", status: { ready: false, reason: "The Critiqs AI model chosen in Your AI is no longer offered. Choose another." } };
  let data = backend({ personalAiSettings: retired, savePersonalAiSettings: async () => personal });
  let yourAi = await render(<YourAi />, data);
  expect(yourAi.textContent).toContain("no longer offered");
  await click(button(yourAi, "Use Fast"));
  expect(lastArgs(data)).toEqual({ enabled: true, mode: "managed", managedModel: "fast" });
  await act(async () => root?.unmount());
  container?.remove();
  // With the deployment's one model, the saved choice resets to it rather than naming it.
  const one = { ...personal.deployment, managedModels: [{ id: "default", label: "Critiqs AI", credits: 1 }] };
  data = backend({ personalAiSettings: { ...retired, deployment: one }, savePersonalAiSettings: async () => personal });
  yourAi = await render(<YourAi />, data);
  expect(select(yourAi, "Model")).toBeNull();
  await click(button(yourAi, "Use Critiqs AI"));
  expect(lastArgs(data)).toEqual({ enabled: true, mode: "managed", managedModel: null });
});

test("on a deployment without Critiqs AI, Your AI offers only an own key", async () => {
  const none: PersonalAiSettingsView = { ...personal, enabled: false, mode: "own", deployment: { ...personal.deployment, managed: false, managedModels: [] }, status: { ready: false, reason: "Set up your AI to use this." } };
  const yourAi = await render(<YourAi />, backend({ personalAiSettings: none }));
  expect(select(yourAi, "Model")).toBeNull();
  expect(yourAi.querySelector(".warning")).toBeNull();
  expect(navRow(yourAi, "Use your own API key")).not.toBeNull();
  await act(async () => root?.unmount());
  container?.remove();
  // A key saved there is removed, never swapped for Critiqs AI.
  const keyed = await render(<YourAi />, backend({ personalAiSettings: { ...savedOwn, deployment: none.deployment } }));
  expect(navRow(keyed, "Use Critiqs AI instead")).toBeNull();
  expect(navRow(keyed, "Remove key")).not.toBeNull();
});

test("a typed key is dropped when the provider changes and kept when the address does, and the saved key's hint shows only for its own provider and address", async () => {
  const data = backend({ personalAiSettings: { ...savedOwn, deployment: { ...savedOwn.deployment, allowedEndpoints: ["https://llm.example.com/v1"] } }, savePersonalAiSettings: async () => savedOwn });
  const yourAi = await render(<YourAi />, data);
  // The saved key opens at its own step.
  await click(navRow(yourAi, "OpenAI key"));
  expect(heading(yourAi)).toBe("Add your OpenAI key");
  expect(keyField(yourAi)!.placeholder).toBe("Saved key ending in 1234");
  await type(keyField(yourAi), "sk-for-openai");
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "Anthropic"));
  expect(keyField(yourAi)!.value).toBe("");
  expect(keyField(yourAi)!.placeholder).toBe("Paste the key");
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "OpenAI"));
  expect(keyField(yourAi)!.placeholder).toBe("Saved key ending in 1234");
  await type(keyField(yourAi), "sk-for-openai");
  // At another address the saved key doesn't apply; a key typed for it stays, since it is typed for this address.
  await type(addressField(yourAi), "https://llm.example.com/v1");
  expect(keyField(yourAi)!.value).toBe("sk-for-openai");
  expect(keyField(yourAi)!.placeholder).toBe("Paste the key");
  await type(addressField(yourAi), "");
  await type(keyField(yourAi), "");
  expect(keyField(yourAi)!.placeholder).toBe("Saved key ending in 1234");
  // Saved without a new key, the saved one stays: no key is sent.
  await click(button(yourAi, "Save key"));
  expect(lastArgs(data)).toEqual({ enabled: true, mode: "own", provider: "openai", model: "gpt-test", baseUrl: null });
});

test("the owner turns the project's AI off and on, sending the saved connection unchanged", async () => {
  const own: AiSettingsView = { ...project, mode: "own", provider: "openai", model: "gpt-test", models: ["gpt-test"], keyHint: "1234" };
  const data = backend({ aiSettings: own, saveAiSettings: async (input) => ({ ...own, enabled: input.enabled }) });
  const dialogs = await render(<ProjectAi />, data);
  const toggle = () => dialogs.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  await click(toggle());
  expect(lastArgs(data)).toEqual({ projectId: "project", enabled: false, mode: "own", provider: "openai", model: "gpt-test", baseUrl: null, rule: "either" });
  // Off, nothing else is offered.
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(select(dialogs, "Who pays")).toBeNull();
  expect(navRow(dialogs, "OpenAI key")).toBeNull();
  await click(toggle());
  expect(lastArgs(data)).toMatchObject({ enabled: true, mode: "own", provider: "openai", model: "gpt-test" });
  expect(lastArgs(data)).not.toHaveProperty("apiKey");
});

test("the owner chooses who pays for AI, saved at once with the project's AI", async () => {
  const data = backend({ aiSettings: project, saveAiSettings: async (input) => ({ ...project, rule: input.rule! }) });
  const dialogs = await render(<ProjectAi />, data);
  // The default first.
  expect(await options(dialogs, "Who pays")).toEqual([
    ["Project pays, personal allowed", null, true],
    ["Project pays", null, false],
    ["Each person pays", null, false],
  ]);
  await choose(dialogs, "Who pays", "Each person pays");
  expect(lastArgs(data)).toMatchObject({ projectId: "project", enabled: true, mode: "managed", managedModel: "fast", rule: "personal" });
  expect(select(dialogs, "Who pays")!.textContent).toBe("Each person pays");
});

test("the project's AI shows its organization's Critiqs AI credits, with the extra past what the plan includes", async () => {
  const usage = {
    plan: "Plus",
    rows: [
      { metric: "projects" as const, period: "total" as const, used: 3, max: 10 },
      { metric: "aiCredits" as const, period: "month" as const, used: 2_100, max: 2_000, overage: { cap: 2_000 } },
    ],
  };
  const dialogs = await render(<ProjectAi />, backend({ aiSettings: project, usage }));
  expect(dialogs.textContent).toContain("Plus plan");
  expect(dialogs.textContent).toContain("2,100 of 2,000 credits used this month · 100 extra, up to 2,000");
});

test("the project's AI shows Critiqs AI credits from a backend that names them aiRequests", async () => {
  const usage = { plan: "Team", rows: [{ metric: "aiRequests" as const, period: "day" as const, used: 12, max: 50 }] };
  const dialogs = await render(<ProjectAi />, backend({ aiSettings: project, usage }));
  expect(dialogs.textContent).toContain("Team plan");
  expect(dialogs.textContent).toContain("12 of 50 credits used today");
});

test("the owner picks the project's Critiqs AI model and the models it allows, every one at first", async () => {
  const data = backend({
    aiSettings: project,
    saveAiSettings: async (input) => ({ ...project, managedModel: input.managedModel ?? project.managedModel, allowedModels: input.allowedModels ?? project.allowedModels }),
  });
  const dialogs = await render(<ProjectAi />, data);
  expect(await options(dialogs, "Model")).toEqual([
    ["Fast", "1 credit", true],
    ["Strong", "about 5 credits", false],
  ]);
  expect(navRow(dialogs, "Allowed models")!.textContent).toBe("Allowed modelsAll");
  await click(navRow(dialogs, "Allowed models"));
  expect(heading(dialogs)).toBe("Allowed models");
  const boxes = () => [...dialogs.querySelectorAll<HTMLInputElement>('[aria-label="Allowed models"] input')];
  // The project's own model is always allowed, so at least one always is.
  expect(boxes().map((box) => [box.checked, box.disabled])).toEqual([
    [true, true],
    [true, false],
  ]);
  expect(dialogs.textContent).toContain("This project's model");
  await click(boxes()[1]);
  expect(lastArgs(data)).toMatchObject({ managedModel: "fast", allowedModels: ["fast"] });
  await click(button(dialogs, "Back"));
  expect(navRow(dialogs, "Allowed models")!.textContent).toBe("Allowed models1 of 2");
  // Choosing a model the project doesn't allow allows it; every model allowed is saved as no limit, which also allows models added later.
  await choose(dialogs, "Model", "Strong");
  expect(lastArgs(data)).toMatchObject({ managedModel: "strong", allowedModels: [] });
  await click(navRow(dialogs, "Allowed models"));
  expect(boxes().map((box) => [box.checked, box.disabled])).toEqual([
    [true, false],
    [true, true],
  ]);
  await click(boxes()[0]);
  expect(lastArgs(data)).toMatchObject({ managedModel: "strong", allowedModels: ["strong"] });
});

test("an older backend's AI settings show no usage rule or model choices, and saving sends neither", async () => {
  const { rule: _rule, allowedModels: _allowed, managedModel: _model, models: _models, ...older } = project;
  const data = backend({ aiSettings: { ...older, deployment: { managed: true, defaultProvider: null, keysStorable: true, allowedEndpoints: [] } }, saveAiSettings: async () => project });
  const dialogs = await render(<ProjectAi />, data);
  expect(select(dialogs, "Who pays")).toBeNull();
  expect(select(dialogs, "Model")).toBeNull();
  expect(navRow(dialogs, "Allowed models")).toBeNull();
  await click(dialogs.querySelector('[role="switch"]'));
  expect(lastArgs(data)).toEqual({ projectId: "project", enabled: false, mode: "managed" });
});

test("a search that needs Your AI says so above its basic results and opens Your AI", async () => {
  const response: SearchResponse = {
    mode: "basic",
    notice: "AI unavailable: basic search. Set up your AI to use this.",
    noticeCode: "setup-ai",
    query: { terms: ["save"], tags: [], groupIds: [], status: "open", screen: null, since: null, until: null },
    results: [],
    truncated: false,
    insights: [],
    insightNotice: null,
  };
  const shadow = await mount(backend({ search: async () => response }), { sidebar: true });
  await click(shadow.querySelector('[aria-label="Comment mode"]'));
  const field = shadow.querySelector<HTMLInputElement>('input[aria-label="Search feedback"]')!;
  await type(field, "save");
  await act(async () => field.form!.requestSubmit());
  await settle();
  const notice = shadow.querySelector(".search-notice")!;
  expect(notice.textContent).toContain("Set up your AI to use this.");
  expect(shadow.querySelector(".badge.basic")!.textContent).toBe("Basic search");
  await click(button(notice, "Set up your AI"));
  expect(dialog(shadow, "Your AI")).not.toBeNull();
});

const THREE = [...MODELS, { id: "max", label: "Max", credits: 20 }];

test("a project whose saved model isn't allowed or offered any more shows the model its requests use, and the models it allows", async () => {
  const data = backend({
    aiSettings: { ...project, managedModel: "retired", allowedModels: ["strong", "max"], deployment: { ...project.deployment, managedModels: THREE } },
    saveAiSettings: async () => project,
  });
  const dialogs = await render(<ProjectAi />, data);
  // As the server does: the first allowed model still offered, not the deployment's first.
  expect(select(dialogs, "Model")!.textContent).toBe("Strong");
  expect(navRow(dialogs, "Allowed models")!.textContent).toBe("Allowed models2 of 3");
  await click(navRow(dialogs, "Allowed models"));
  const boxes = () => [...dialogs.querySelectorAll<HTMLInputElement>('[aria-label="Allowed models"] input')];
  expect(boxes().map((box) => [box.checked, box.disabled])).toEqual([
    [false, false],
    [true, true],
    [true, false],
  ]);
  // Unticking every other model leaves the project's own, never an empty list that would mean every model.
  await click(boxes()[2]);
  expect(lastArgs(data)).toMatchObject({ managedModel: "strong", allowedModels: ["strong"] });
});

test("a project with no model saved uses its first allowed one, and a limit to retired models allows only the first offered", async () => {
  let dialogs = await render(<ProjectAi />, backend({ aiSettings: { ...project, managedModel: null, allowedModels: ["strong"] } }));
  expect(select(dialogs, "Model")!.textContent).toBe("Strong");
  await act(async () => root?.unmount());
  container?.remove();
  dialogs = await render(<ProjectAi />, backend({ aiSettings: { ...project, managedModel: null, allowedModels: ["gone"] } }));
  expect(select(dialogs, "Model")!.textContent).toBe("Fast");
  await click(navRow(dialogs, "Allowed models"));
  expect([...dialogs.querySelectorAll<HTMLInputElement>('[aria-label="Allowed models"] input')].map((box) => box.checked)).toEqual([true, false]);
});

test("a project's AI saved off offers only turning it on, which saves the project's model", async () => {
  const off: AiSettingsView = { ...project, enabled: false, status: { ready: false, reason: "AI is turned off for this project." } };
  const data = backend({ aiSettings: off, saveAiSettings: async () => project });
  const dialogs = await render(<ProjectAi />, data);
  expect(dialogs.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
  expect(dialogs.querySelector(".warning")).toBeNull();
  expect(select(dialogs, "Model")).toBeNull();
  await click(dialogs.querySelector('[role="switch"]'));
  expect(lastArgs(data)).toMatchObject({ projectId: "project", enabled: true, mode: "managed", managedModel: "fast", rule: "either", allowedModels: [] });
  expect(select(dialogs, "Model")!.textContent).toBe("Fast");
});

test("an AI settings load that fails says why instead of loading forever", async () => {
  const transport = fakeTransport(backend());
  const failing = { ...transport, useAiSettings: () => ({ status: "error", code: "forbidden", message: "Only the project's owner can see its AI settings." }) as const };
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={failing}>
        <TagsAiDialog projectId="project" initialTab="ai" onClose={() => undefined} notify={() => undefined} />
      </TransportContext.Provider>,
    ),
  );
  expect(container.textContent).toContain("Only the project's owner can see its AI settings.");
  expect(container.textContent).not.toContain("Loading…");
});

/** Escape pressed while focus is nowhere in Critiqs, as after a browser drops focus from a button disabled while saving. */
async function escapeFromPage(shadow: ShadowRoot) {
  await act(async () => {
    (shadow.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  });
  await settle();
}

test("in Comment mode, Escape still closes Tags and AI after a setting saves, even with focus lost to the page", async () => {
  const data = backend({ aiSettings: project, saveAiSettings: async (input) => ({ ...project, rule: input.rule! }) });
  const shadow = await mount(data, { sidebar: true });
  await click(shadow.querySelector('[aria-label="Comment mode"]'));
  await click(shadow.querySelector('button[aria-label="Tags and AI settings"]'));
  await click(button(shadow, "AI"));
  await choose(shadow, "Who pays", "Each person pays");
  expect(lastArgs(data)).toMatchObject({ rule: "personal" });
  expect(dialog(shadow, "Tags and AI")).not.toBeNull();
  await escapeFromPage(shadow);
  expect(dialog(shadow, "Tags and AI")).toBeNull();
  // Comment mode stays on.
  expect(shadow.querySelector('[aria-label="Comment mode"]')!.getAttribute("aria-pressed")).toBe("true");
});

test("in Comment mode, Escape closes an open model menu first, then Your AI", async () => {
  const shadow = await mount(backend(), { sidebar: true });
  await click(shadow.querySelector('[aria-label="Comment mode"]'));
  const yourAi = await openYourAi(shadow);
  await click(select(yourAi, "Model"));
  expect(yourAi.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => void (shadow.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true })));
  await settle();
  expect(yourAi.querySelector('[role="menu"]')).toBeNull();
  expect(dialog(shadow, "Your AI")).not.toBeNull();
  await escapeFromPage(shadow);
  expect(dialog(shadow, "Your AI")).toBeNull();
});

test("in Comment mode, Escape closes Your AI after removing a key, and focus lost to the page returns to the dialog", async () => {
  const shadow = await mount(backend({ personalAiSettings: savedOwn, removePersonalAiSettings: async () => personal }), { sidebar: true });
  await click(shadow.querySelector('[aria-label="Comment mode"]'));
  const yourAi = await openYourAi(shadow);
  await click(navRow(yourAi, "Use Critiqs AI instead"));
  expect(shadow.activeElement).toBe(button(yourAi, "Keep key"));
  await click(button(yourAi, "Remove key"));
  // Removed: the rows that held focus are gone, so the dialog holds it.
  expect(shadow.activeElement).toBe(dialog(shadow, "Your AI"));
  await act(async () => (shadow.activeElement as HTMLElement).blur());
  await settle();
  expect(shadow.activeElement).toBe(dialog(shadow, "Your AI"));
  await escapeFromPage(shadow);
  expect(dialog(shadow, "Your AI")).toBeNull();
});

test("with no Critiqs AI models to choose among, changing who pays leaves the saved model and limit as they are", async () => {
  const limited: AiSettingsView = { ...project, managedModel: "fast", allowedModels: ["fast"] };
  const save = async (managedModels: AiSettingsView["deployment"]["managedModels"], view = limited) => {
    const data = backend({ aiSettings: { ...view, deployment: { ...view.deployment, managed: managedModels!.length > 0, managedModels } }, saveAiSettings: async () => view });
    const dialogs = await render(<ProjectAi />, data);
    expect(navRow(dialogs, "Allowed models")).toBeNull();
    expect(select(dialogs, "Model")).toBeNull();
    await choose(dialogs, "Who pays", "Project pays");
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    return lastArgs(data);
  };
  // Critiqs AI turned off by the operator, or offering one model.
  expect(await save([])).toEqual({ projectId: "project", enabled: true, mode: "managed", rule: "project" });
  expect(await save([MODELS[0]!])).toEqual({ projectId: "project", enabled: true, mode: "managed", rule: "project" });
  // A saved model and limit the one model replaced narrow to it, never to every model.
  expect(await save([MODELS[0]!], { ...project, managedModel: "strong", allowedModels: ["strong"] })).toEqual({
    projectId: "project",
    enabled: true,
    mode: "managed",
    managedModel: null,
    rule: "project",
    allowedModels: ["fast"],
  });
});

test("hiding Critiqs with a dialog open leaves the page holding focus, and showing it gives focus back", async () => {
  const shadow = await mount(backend());
  const yourAi = await openYourAi(shadow);
  const focused = shadow.activeElement;
  expect(yourAi.contains(focused)).toBe(true);
  const toggle = async () => {
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "Backslash", ctrlKey: true, metaKey: true, bubbles: true, composed: true, cancelable: true })));
    await settle();
  };
  await toggle();
  expect(shadow.activeElement).toBeNull();
  await toggle();
  expect(shadow.activeElement).toBe(focused);
});

test("a project limited to models the deployment no longer offers gets out of it in one step, under the server's own rules", async () => {
  // The deployment now offers only Fast; the project was saved allowing only Strong, then retired.
  const fastOnly: AiDeployment = {
    managed: { provider: "openai", apiKey: "managed-key", models: [{ id: "fast", label: "Fast", model: "fast-model", credits: 1 }] },
    defaultProvider: null,
    encryptionKey: null,
    endpoints: { allowed: [], allowLocal: false },
  };
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const dana = reviewer("Dana");
  const projectId = await store.transaction((s) => operations.createProject(s, dana, { name: "Pilot" }));
  const userId = (await store.transaction((s) => s.users.byToken(dana.tokenIdentifier)))!._id;
  await store.transaction((s) =>
    s.aiSettings.insert({ projectId, enabled: true, mode: "managed", managedModel: "strong", allowedModels: ["strong"], epoch: 1, updatedAt: 1, updatedBy: userId }),
  );
  const view = await store.transaction((s) => getAiSettings(s, dana, { projectId }, fastOnly));
  expect(view.status).toEqual({ ready: false, reason: "None of the Critiqs AI models this project allows is offered any more. Its owner can choose others in AI settings." });
  const data = backend({
    aiSettings: view,
    saveAiSettings: async (input) => {
      const prepared = await prepareSettings(input, fastOnly);
      return await store.transaction((s) => applyAiSettings(s, dana, { projectId, prepared }, fastOnly, Date.now()));
    },
  });
  const dialogs = await render(<TagsAiDialog projectId={projectId} initialTab="ai" onClose={() => undefined} notify={() => undefined} />, data);
  expect(dialogs.querySelector('.warning[role="status"]')!.textContent).toContain("None of the Critiqs AI models this project allows is offered any more.");
  await click(button(dialogs, "Use Fast"));
  expect(dialogs.querySelector(".error")).toBeNull();
  expect(dialogs.querySelector(".warning")).toBeNull();
  expect(await store.transaction((s) => getAiSettings(s, dana, { projectId }, fastOnly))).toMatchObject({ status: { ready: true }, rule: "either", allowedModels: ["fast"] });
});

test("Your AI on a deployment with one Critiqs AI model names it without a choice, and turning a saved connection on doesn't save it as one", async () => {
  const one = { ...personal.deployment, managedModels: [{ id: "default", label: "Critiqs AI", credits: 1 }] };
  let yourAi = await render(<YourAi />, backend({ personalAiSettings: { ...personal, deployment: one } }));
  expect(select(yourAi, "Model")).toBeNull();
  expect(yourAi.querySelector(".ds-row")!.textContent).toBe("ModelCritiqs AI");
  await act(async () => root?.unmount());
  container?.remove();
  // A saved model the one model replaced resets to it.
  const data = backend({ personalAiSettings: { ...personal, saved: true, enabled: false, managedModel: "strong", deployment: one }, savePersonalAiSettings: async () => personal });
  yourAi = await render(<YourAi />, data);
  await click(button(yourAi, "Turn on"));
  expect(lastArgs(data)).toEqual({ enabled: true, mode: "managed", managedModel: null });
});

const LISTED = [
  { id: "gpt-5", label: null },
  { id: "gpt-5-mini", label: null },
  { id: "o4", label: "O Four" },
];

test("Your AI loads the provider's models with the typed key, to tick, and saves the ticked ones; the first is the model until another is chosen", async () => {
  const data = backend({
    listAiModels: async () => ({ ok: true, models: LISTED, truncated: false }),
    savePersonalAiSettings: async (input) => ({ ...personal, saved: true, mode: "own", provider: "openai", model: input.model ?? null, models: input.models ?? [], keyHint: "4321" }),
  });
  const yourAi = await render(<YourAi modelLists />, data);
  await click(navRow(yourAi, "Use your own API key"));
  expect(yourAi.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Step 1 of 3");
  await click(navRow(yourAi, "OpenAI"));
  // No model field: models come from the list on the next step.
  expect(modelField(yourAi)).toBeNull();
  expect(button(yourAi, "Continue")!.disabled).toBe(true);
  await type(keyField(yourAi), "sk-new-4321");
  await click(button(yourAi, "Continue"));
  expect(data.calls!.find((call) => call.name === "listPersonalAiModels")!.args).toEqual({ draft: { provider: "openai", baseUrl: null, apiKey: "sk-new-4321" } });
  expect(heading(yourAi)).toBe("Choose models");
  // A display name shows instead of the id.
  expect([...yourAi.querySelectorAll('[aria-label="Models to offer"] label')].map((label) => label.textContent)).toEqual(["gpt-5", "gpt-5-mini", "O Four"]);
  expect(button(yourAi, "Save key")!.disabled).toBe(true);
  await click(modelRow(yourAi, "gpt-5-mini"));
  await click(modelRow(yourAi, "gpt-5"));
  await click(button(yourAi, "Save key"));
  expect(data.calls!.find((call) => call.name === "savePersonalAiSettings")!.args).toEqual({
    enabled: true,
    mode: "own",
    provider: "openai",
    model: "gpt-5-mini",
    models: ["gpt-5-mini", "gpt-5"],
    baseUrl: null,
    apiKey: "sk-new-4321",
  });
  // The model is chosen among the ticked ones, without sending the key again.
  expect(select(yourAi, "Model")!.textContent).toBe("gpt-5-mini");
  await choose(yourAi, "Model", "gpt-5");
  expect(lastArgs(data)).toEqual({ enabled: true, mode: "own", provider: "openai", model: "gpt-5", models: ["gpt-5-mini", "gpt-5"], baseUrl: null });
});

test("a long model list can be searched", async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `model-${index}`, label: null }));
  const yourAi = await render(<YourAi modelLists />, backend({ listAiModels: async () => ({ ok: true, models: [...many, { id: "o4-mini", label: null }], truncated: false }) }));
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  await type(keyField(yourAi), "sk-1");
  await click(button(yourAi, "Continue"));
  const search = yourAi.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
  expect(search.placeholder).toBe("Search 13 models");
  await type(search, "O4");
  expect([...yourAi.querySelectorAll('[aria-label="Models to offer"] label')].map((label) => label.textContent)).toEqual(["o4-mini"]);
});

test("when the provider can't list its models, the reason shows and models can be named by hand", async () => {
  const data = backend({
    personalAiSettings: savedOwn,
    listAiModels: async () => ({ ok: false, code: "auth", message: "The provider refused the key. Check that it is correct and active." }),
    savePersonalAiSettings: async () => savedOwn,
  });
  const yourAi = await render(<YourAi modelLists />, data);
  await click(navRow(yourAi, "OpenAI key"));
  // The saved key lists without being typed again.
  expect(button(yourAi, "Continue")!.disabled).toBe(false);
  await click(button(yourAi, "Continue"));
  expect(data.calls!.find((call) => call.name === "listPersonalAiModels")!.args).toEqual({ draft: { provider: "openai", baseUrl: null } });
  expect(yourAi.querySelector('[role="status"].error')!.textContent).toBe("The provider refused the key. Check that it is correct and active.");
  expect(heading(yourAi)).toBe("Add your OpenAI key");
  await click(button(yourAi, "Name models instead"));
  // The saved models show ticked.
  expect(ticked(yourAi)).toEqual(["gpt-test"]);
  await type(yourAi.querySelector<HTMLInputElement>('input[aria-label="Model name"]'), " my-model ");
  await click(button(yourAi, "Add"));
  // Enter adds a name rather than saving.
  const field = yourAi.querySelector<HTMLInputElement>('input[aria-label="Model name"]')!;
  await type(field, "other-model");
  await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  expect(data.calls!.some((call) => call.name === "savePersonalAiSettings")).toBe(false);
  expect(field.value).toBe("");
  await click(button(yourAi, "Save key"));
  expect(lastArgs(data)).toEqual({ enabled: true, mode: "own", provider: "openai", model: "gpt-test", models: ["gpt-test", "my-model", "other-model"], baseUrl: null });
});

test("OpenRouter is offered where the backend accepts it, with its address set by Critiqs", async () => {
  const older = await render(<YourAi modelLists />, backend());
  await click(navRow(older, "Use your own API key"));
  expect(navRow(older, "OpenRouter")).toBeNull();
  await act(async () => root?.unmount());
  container?.remove();

  const data = backend({
    personalAiSettings: { ...personal, deployment: { ...personal.deployment, allowedEndpoints: ["https://llm.example.com/v1"], providers: ["openai", "anthropic", "google", "openrouter", "gateway", "compatible"] } },
    listAiModels: async () => ({ ok: true, models: [{ id: "anthropic/claude-sonnet-4.5", label: "Anthropic: Claude Sonnet 4.5" }], truncated: false }),
    savePersonalAiSettings: async () => savedOwn,
  });
  const yourAi = await render(<YourAi modelLists />, data);
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenRouter"));
  expect(heading(yourAi)).toBe("Add your OpenRouter key");
  expect(addressField(yourAi)).toBeNull();
  expect([...yourAi.querySelectorAll("a")].find((link) => link.textContent === "Get a key")!.getAttribute("href")).toBe("https://openrouter.ai/keys");
  await type(keyField(yourAi), "sk-or-1");
  await click(button(yourAi, "Continue"));
  expect(data.calls!.find((call) => call.name === "listPersonalAiModels")!.args).toEqual({ draft: { provider: "openrouter", baseUrl: null, apiKey: "sk-or-1" } });
  await click(modelRow(yourAi, "Anthropic: Claude Sonnet 4.5"));
  await click(button(yourAi, "Save key"));
  expect(lastArgs(data)).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5", models: ["anthropic/claude-sonnet-4.5"], baseUrl: null, apiKey: "sk-or-1" });
});

test("the project's owner loads models for the project's own key", async () => {
  const data = backend({
    aiSettings: { ...project, mode: "own", provider: "anthropic", model: "claude-test", models: ["claude-test"], keyHint: "1111" },
    listAiModels: async () => ({ ok: true, models: [{ id: "claude-test", label: "Claude Test" }, { id: "claude-big", label: "Claude Big" }], truncated: true }),
    saveAiSettings: async () => project,
  });
  const dialogs = await render(<ProjectAi modelLists />, data);
  await click(navRow(dialogs, "Anthropic key"));
  await click(button(dialogs, "Continue"));
  expect(data.calls!.find((call) => call.name === "listAiModels")!.args).toEqual({ projectId: "project", draft: { provider: "anthropic", baseUrl: null } });
  // Past the limit, the first models by name are kept, and the step says the provider listed more.
  expect(dialogs.textContent).toContain("The provider listed more; search finds the first 2 by name.");
  expect(ticked(dialogs)).toEqual(["Claude Test"]);
  await click(modelRow(dialogs, "Claude Big"));
  await click(button(dialogs, "Save key"));
  expect(lastArgs(data)).toMatchObject({ projectId: "project", provider: "anthropic", model: "claude-test", models: ["claude-test", "claude-big"] });
  // Saved, the tab is back on its settings.
  expect(dialogs.querySelector('[role="switch"]')).not.toBeNull();
});

/** Your own key saved for OpenAI with two models, the key ending in 9876. */
const openaiSaved: PersonalAiSettingsView = {
  ...personal,
  saved: true,
  mode: "own",
  provider: "openai",
  model: "gpt-test",
  models: ["gpt-test", "gpt-big"],
  keyHint: "9876",
  deployment: { ...personal.deployment, allowedEndpoints: ["https://llm.example.com/v1"], providers: ["openai", "anthropic", "google", "openrouter", "gateway", "compatible"] },
};

test("choosing another provider clears the models, and choosing the saved one again brings its models back", async () => {
  const data = backend({ personalAiSettings: openaiSaved, listAiModels: async () => ({ ok: true, models: [], truncated: false }) });
  const yourAi = await render(<YourAi modelLists />, data);
  const toStep3 = async (provider: string, key?: string) => {
    await click(button(yourAi, "Back"));
    if (heading(yourAi) !== "Choose a provider") await click(button(yourAi, "Back"));
    await click(navRow(yourAi, provider));
    if (key !== undefined) await type(keyField(yourAi), key);
    await click(button(yourAi, "Continue"));
  };
  await click(navRow(yourAi, "OpenAI key"));
  await click(button(yourAi, "Continue"));
  expect(ticked(yourAi)).toEqual(["gpt-test", "gpt-big"]);
  await toStep3("Anthropic", "sk-ant-1");
  expect(ticked(yourAi)).toEqual([]);
  await toStep3("OpenAI");
  expect(ticked(yourAi)).toEqual(["gpt-test", "gpt-big"]);
});

test("at another address the saved key's models don't apply: they start empty", async () => {
  const yourAi = await render(<YourAi modelLists />, backend({ personalAiSettings: openaiSaved, listAiModels: async () => ({ ok: true, models: [], truncated: false }) }));
  await click(navRow(yourAi, "OpenAI key"));
  await type(addressField(yourAi), "https://llm.example.com/v1");
  await type(keyField(yourAi), "sk-other");
  await click(button(yourAi, "Continue"));
  expect(ticked(yourAi)).toEqual([]);
});

test("without model lists, choosing another provider clears the typed model, and the saved provider brings it back", async () => {
  const yourAi = await render(<YourAi />, backend({ personalAiSettings: openaiSaved }));
  await click(navRow(yourAi, "OpenAI key"));
  expect(modelField(yourAi)!.value).toBe("gpt-test");
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "Anthropic"));
  expect(modelField(yourAi)!.value).toBe("");
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "OpenAI"));
  expect(modelField(yourAi)!.value).toBe("gpt-test");
});

test("Continue is offered only when the server could list: a key that applies, and an address where one is needed", async () => {
  const data = backend({ personalAiSettings: openaiSaved, listAiModels: async () => ({ ok: true, models: LISTED, truncated: false }) });
  const yourAi = await render(<YourAi modelLists />, data);
  // The saved key is OpenAI's at its own address: it lists without being typed again.
  await click(navRow(yourAi, "OpenAI key"));
  expect(button(yourAi, "Continue")!.disabled).toBe(false);
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "Anthropic"));
  expect(button(yourAi, "Continue")!.disabled).toBe(true);
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "OpenAI"));
  await type(addressField(yourAi), "https://llm.example.com/v1/");
  expect(button(yourAi, "Continue")!.disabled).toBe(true);
  await type(addressField(yourAi), "");
  expect(button(yourAi, "Continue")!.disabled).toBe(false);
  // An endpoint needs no key, but it needs its address.
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "Other (OpenAI-compatible)"));
  expect(button(yourAi, "Continue")!.disabled).toBe(true);
  await type(addressField(yourAi), "https://llm.example.com/v1");
  expect(button(yourAi, "Continue")!.disabled).toBe(false);
  await click(button(yourAi, "Continue"));
  expect(data.calls!.filter((call) => call.name === "listPersonalAiModels").map((call) => call.args)).toEqual([{ draft: { provider: "compatible", baseUrl: "https://llm.example.com/v1" } }]);
});

test("typing a key clears a refusal for the old one", async () => {
  const data = backend({ listAiModels: async () => ({ ok: false, code: "auth", message: "The provider refused the key. Check that it is correct and active." }) });
  const yourAi = await render(<YourAi modelLists />, data);
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  await type(keyField(yourAi), "sk-old");
  await click(button(yourAi, "Continue"));
  expect(yourAi.textContent).toContain("The provider refused the key.");
  await type(keyField(yourAi), "sk-new");
  expect(yourAi.textContent).not.toContain("The provider refused the key.");
});

test("a list still loading for a key typed over never shows", async () => {
  let release: (result: { ok: true; models: typeof LISTED; truncated: false }) => void = () => undefined;
  const data = backend({ listAiModels: () => new Promise((resolve) => (release = resolve)) });
  const yourAi = await render(<YourAi modelLists />, data);
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  await type(keyField(yourAi), "sk-old");
  await click(button(yourAi, "Continue"));
  expect(button(yourAi, "Checking…")).not.toBeNull();
  await type(keyField(yourAi), "sk-other");
  await act(async () => release({ ok: true, models: LISTED, truncated: false }));
  await settle();
  // The list was for the old key: the key's step stays.
  expect(heading(yourAi)).toBe("Add your OpenAI key");
  expect(yourAi.querySelector('[aria-label="Models to offer"]')).toBeNull();
});

test("at the 50-model limit, a typed name stays in its field instead of vanishing", async () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `model-${i}`);
  const yourAi = await render(<YourAi modelLists />, backend({ personalAiSettings: { ...openaiSaved, model: "model-0", models: fifty }, listAiModels: async () => ({ ok: true, models: [], truncated: false }) }));
  await click(navRow(yourAi, "OpenAI key"));
  await click(button(yourAi, "Continue"));
  expect(yourAi.textContent).toContain("At most 50 models.");
  const field = yourAi.querySelector<HTMLInputElement>('input[aria-label="Model name"]')!;
  await type(field, "one-more");
  expect(button(yourAi, "Add")!.disabled).toBe(true);
  await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  expect(field.value).toBe("one-more");
  expect(ticked(yourAi)).toHaveLength(50);
});

test("after a choice saves, focus stays on its select, so keyboard use stays in the dialog", async () => {
  const yourAi = await render(<YourAi />, backend({ savePersonalAiSettings: async () => ({ ...personal, saved: true, managedModel: "strong" }) }));
  await choose(yourAi, "Model", "Strong");
  expect(select(yourAi, "Model")!.textContent).toBe("Strong");
  expect(document.activeElement).toBe(select(yourAi, "Model")!);
});


// Findings from the independent review of the rebuilt screens.

test("a model list still loading when Back or another provider is chosen never opens the next step", async () => {
  let release: (result: { ok: true; models: { id: string; label: null }[]; truncated: false }) => void = () => undefined;
  const data = backend({ listAiModels: () => new Promise((resolve) => (release = resolve)) });
  const yourAi = await render(<YourAi modelLists />, data);
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  await type(keyField(yourAi), "sk-openai");
  await click(button(yourAi, "Continue"));
  expect(button(yourAi, "Checking…")).not.toBeNull();
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "Anthropic"));
  expect(button(yourAi, "Continue")).not.toBeNull();
  await act(async () => release({ ok: true, models: [{ id: "gpt-5", label: null }], truncated: false }));
  await settle();
  expect(heading(yourAi)).toBe("Add your Anthropic key");
});

test("another provider never takes the last one's endpoint address, and the saved provider gets its own key back", async () => {
  const yourAi = await render(<YourAi />, backend({ personalAiSettings: savedOwn }));
  await click(navRow(yourAi, "OpenAI key"));
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "Other (OpenAI-compatible)"));
  await type(addressField(yourAi), "https://custom.example/v1");
  await click(button(yourAi, "Back"));
  await click(navRow(yourAi, "OpenAI"));
  expect(addressField(yourAi)).toBeNull();
  expect(keyField(yourAi)!.placeholder).toBe("Saved key ending in 1234");
  expect(modelField(yourAi)!.value).toBe("gpt-test");
});

test("the own key's model select keeps focus while its choice saves", async () => {
  let finish: () => void = () => undefined;
  const two: PersonalAiSettingsView = { ...savedOwn, models: ["gpt-test", "gpt-mini"] };
  const data = backend({ personalAiSettings: two, savePersonalAiSettings: () => new Promise((resolve) => (finish = () => resolve({ ...two, model: "gpt-mini" }))) });
  const yourAi = await render(<YourAi />, data);
  await choose(yourAi, "Model", "gpt-mini");
  expect(select(yourAi, "Model")!.disabled).toBe(false);
  expect(document.activeElement).toBe(select(yourAi, "Model"));
  await act(async () => finish());
  await settle();
  expect(document.activeElement).toBe(select(yourAi, "Model"));
});

test("without Critiqs AI, removing a key promises nothing else, and no divider stands alone", async () => {
  const none = { ...personal.deployment, managed: false, managedModels: [] };
  const notes: string[] = [];
  let yourAi = await render(<YourAi notify={(note) => notes.push(note)} />, backend({ personalAiSettings: { ...savedOwn, deployment: none }, removePersonalAiSettings: async () => ({ ...personal, enabled: false, mode: "own", deployment: none, status: { ready: false, reason: "Set up your AI to use this." } }) }));
  await click(navRow(yourAi, "Remove key"));
  expect(yourAi.textContent).toContain("Remove your key?");
  expect(yourAi.textContent).not.toContain("Critiqs AI");
  await click(button(yourAi, "Remove key"));
  expect(notes).toEqual(["Your key was removed."]);
  // Nothing above the own key's row: no divider.
  expect(yourAi.querySelector("hr.ds-divider")).toBeNull();
  expect(navRow(yourAi, "Use your own API key")).not.toBeNull();
  await act(async () => root?.unmount());
  container?.remove();
  // The project's own key without Critiqs AI or a deployment provider has nothing below it.
  yourAi = await render(<ProjectAi />, backend({ aiSettings: { ...project, mode: "own", provider: "openai", model: "gpt-test", models: ["gpt-test"], keyHint: "1234", deployment: { ...project.deployment, managed: false, managedModels: [] } } }));
  expect(yourAi.querySelector("hr.ds-divider")).toBeNull();
});

test("when switching the project to Critiqs AI fails, the confirmation stays open with the reason", async () => {
  const data = backend({
    aiSettings: { ...project, mode: "own", provider: "openai", model: "gpt-test", models: ["gpt-test"], keyHint: "1234" },
    saveAiSettings: async () => {
      throw new Error("The server refused.");
    },
  });
  const dialogs = await render(<ProjectAi />, data);
  await click(navRow(dialogs, "Use Critiqs AI instead"));
  await click(button(dialogs, "Remove key"));
  expect(dialogs.textContent).toContain("Remove the project's key and use Critiqs AI?");
  expect(dialogs.querySelector('[role="alert"].error')).not.toBeNull();
});

test("a page opened from the settings starts without the last page's error", async () => {
  const data = backend({
    savePersonalAiSettings: async () => {
      throw new Error("The server refused.");
    },
  });
  const yourAi = await render(<YourAi />, data);
  await choose(yourAi, "Model", "Strong");
  expect(yourAi.querySelector(".error")).not.toBeNull();
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  expect(yourAi.querySelector(".error")).toBeNull();
});

test("on a deployment with its own provider, the project's key can be removed to use that provider", async () => {
  const deployment = { ...project.deployment, managed: false, managedModels: [], defaultProvider: { provider: "openai" as const, model: "gpt-house" } };
  const data = backend({ aiSettings: { ...project, mode: "own", provider: "anthropic", model: "claude-test", models: ["claude-test"], keyHint: "1234", deployment }, saveAiSettings: async () => ({ ...project, mode: "own", deployment }) });
  const dialogs = await render(<ProjectAi />, data);
  await click(navRow(dialogs, "Use this deployment's provider"));
  expect(dialogs.textContent).toContain("Remove the project's key and use this deployment's provider?");
  await click(button(dialogs, "Remove key"));
  expect(lastArgs(data)).toMatchObject({ enabled: true, mode: "own", provider: null });
  expect(lastArgs(data)).not.toHaveProperty("apiKey");
});

test("the key step focuses the key first; an optional address comes after it", async () => {
  const yourAi = await render(<YourAi />, backend({ personalAiSettings: { ...personal, deployment: { ...personal.deployment, allowedEndpoints: ["https://llm.example.com/v1"] } } }));
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  expect(document.activeElement).toBe(keyField(yourAi));
  const fields = [...yourAi.querySelectorAll(".field-label")].map((label) => label.textContent);
  expect(fields.slice(0, 2)).toEqual(["API key", "Endpoint address (optional)"]);
});

// Findings from the second review.

test("a project on the deployment's own provider isn't shown as on Critiqs AI, and can switch to it", async () => {
  const deployment = { ...project.deployment, defaultProvider: { provider: "openai" as const, model: "gpt-house" } };
  const data = backend({ aiSettings: { ...project, mode: "own", provider: null, deployment }, saveAiSettings: async () => ({ ...project, deployment }) });
  const dialogs = await render(<ProjectAi />, data);
  expect(select(dialogs, "Model")).toBeNull();
  expect(navRow(dialogs, "Allowed models")).toBeNull();
  expect(meter(dialogs)).toBeNull();
  await click(navRow(dialogs, "Use Critiqs AI instead"));
  expect(lastArgs(data)).toMatchObject({ enabled: true, mode: "managed" });
});

test("Enter on the key step never saves what its button wouldn't", async () => {
  const data = backend();
  const yourAi = await render(<YourAi />, data);
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  await type(keyField(yourAi), "sk-1234");
  expect(button(yourAi, "Save key")!.disabled).toBe(true);
  await act(async () => keyField(yourAi)!.form!.requestSubmit());
  await settle();
  expect(data.calls!.some((call) => call.name === "savePersonalAiSettings")).toBe(false);
});

test("a failed save's reason stays on its step and clears on the next", async () => {
  const data = backend({
    listAiModels: async () => ({ ok: true, models: [{ id: "gpt-5", label: null }], truncated: false }),
    savePersonalAiSettings: async () => {
      throw new Error("The server refused.");
    },
  });
  const yourAi = await render(<YourAi modelLists />, data);
  await click(navRow(yourAi, "Use your own API key"));
  await click(navRow(yourAi, "OpenAI"));
  await type(keyField(yourAi), "sk-1234");
  await click(button(yourAi, "Continue"));
  await click(modelRow(yourAi, "gpt-5"));
  await click(button(yourAi, "Save key"));
  expect(yourAi.querySelector('.error[role="alert"]')).not.toBeNull();
  await click(button(yourAi, "Back"));
  expect(heading(yourAi)).toBe("Add your OpenAI key");
  expect(yourAi.querySelector('.error[role="alert"]')).toBeNull();
});

test("a confirmation left open closes when another page opens", async () => {
  const yourAi = await render(<YourAi />, backend({ personalAiSettings: savedOwn }));
  await click(navRow(yourAi, "Use Critiqs AI instead"));
  await click(navRow(yourAi, "OpenAI key"));
  await click(button(yourAi, "Back"));
  await click(button(yourAi, "Back"));
  expect(yourAi.textContent).not.toContain("Remove your key");
  expect(navRow(yourAi, "Use Critiqs AI instead")).not.toBeNull();
});
