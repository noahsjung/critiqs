import { describe, expect, test } from "bun:test";
import type { DeveloperSendResult, DeveloperSendSummary, ProjectInfo } from "@critiqs/core";
import { useState } from "react";
import type { CreatedProject } from "../src/flow.ts";
import type { QueryState } from "../src/shared.ts";
import { deliveryLine, InstallPanel, SendPanel, SendPanelView } from "../src/ui/Ways.tsx";
import { button, click, fakeBackend, fakeClipboard, labelled, refusingClipboard, render, rerender, settle, text } from "./render.tsx";

// The two ways to add Critiqs, as people see them: the one command, and
// every answer to sending setup emails.

const PROJECT_ID = "n579b6w6641phdvxeymddfn1zd8jwjxw";
const COMMAND = `npm install critiqs-react && npx critiqs init ${PROJECT_ID}`;
const project = (overrides: Partial<CreatedProject> = {}): CreatedProject => ({
  id: PROJECT_ID,
  name: "Acme prototype",
  reviewUrl: "https://acme-proto.vercel.app/",
  stack: "next",
  ...overrides,
});

describe("I will: the command", () => {
  test("one command, copied as one line, then what happens next; copying it counts as done", async () => {
    const clipboard = fakeClipboard();
    let done = 0;
    const page = await render(<InstallPanel project={project()} onDone={() => done++} />);
    expect(page.querySelector("h1")?.textContent).toBe("Add Critiqs to your prototype");
    expect(page.querySelector(".command")?.textContent).toBe(`npm install critiqs-react &&\nnpx critiqs init ${PROJECT_ID}`);
    expect(page.querySelectorAll(".command").length).toBe(1);
    await click(button(page, "Copy command"));
    expect(clipboard.text).toBe(COMMAND);
    expect(text(page)).toContain("Copied");
    expect(done).toBe(1);
    expect(text(page)).toContain("Then open acme-proto.vercel.app. You'll see Critiqs at the bottom of the page.");
  });

  test("a coding agent's instructions are one quiet button beside Copy, and copying them counts as done", async () => {
    const clipboard = fakeClipboard();
    let done = 0;
    const page = await render(<InstallPanel project={project()} onDone={() => done++} />);
    const agent = button(page, "Copy for a coding agent");
    expect(agent?.className).toBe("quiet");
    await click(agent);
    expect(clipboard.text).toBe(`Add Critiqs to this Next.js app: run \`${COMMAND}\` in its folder, and follow the steps it prints.`);
    expect(done).toBe(1);
  });

  test("no address: says to open the prototype; an unknown stack runs init alone, which finds the framework", async () => {
    const page = await render(<InstallPanel project={project({ reviewUrl: null, stack: null })} />);
    expect(text(page)).toContain("Then open your prototype.");
    expect(page.querySelector(".command")?.textContent).toBe(`npx critiqs init ${PROJECT_ID}`);
    expect(text(page)).toContain("It finds your framework (React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, Astro, Solid, Rails, Django, or Flask) and adds Critiqs.");
  });

  test("every framework with a Critiqs package gets its package and init, never coming soon", async () => {
    const cases: [CreatedProject["stack"], string][] = [
      ["vue", "npm install critiqs-vue"],
      ["sveltekit", "npm install critiqs-svelte"],
      ["rails", "bundle add critiqs-rails"],
      ["flask", "pip install flask-critiqs"],
    ];
    for (const [stack, install] of cases) {
      const page = await render(<InstallPanel project={project({ stack })} />);
      expect([stack, page.querySelector(".command")?.textContent]).toEqual([stack, `${install} &&\nnpx critiqs init ${PROJECT_ID}`]);
      expect([stack, text(page).includes("coming soon")]).toEqual([stack, false]);
    }
  });

  test("a project on a backend other than Critiqs Cloud: a step that gives Critiqs its backend, also in the agent's instructions", async () => {
    const clipboard = fakeClipboard();
    const page = await render(<InstallPanel project={project()} />, { backend: fakeBackend({ componentBackend: "https://team-backend.convex.cloud" }) });
    expect(text(page)).toContain("This project is on your team's own Critiqs backend, not Critiqs Cloud. Add this on the <Critiqs /> component init added, so Critiqs connects there:");
    await click(button(page, "Copy setting"));
    expect(clipboard.text).toBe('backend="https://team-backend.convex.cloud"');
    await click(button(page, "Copy for a coding agent"));
    expect(clipboard.text).toContain('Then set Critiqs\'s backend to https://team-backend.convex.cloud: add `backend="https://team-backend.convex.cloud"` on the <Critiqs /> component init added');
  });

  test("on its own backend, each framework gets the setting its package reads, and a stack with no package the script tag's", async () => {
    const clipboard = fakeClipboard();
    const backend = fakeBackend({ componentBackend: "https://team-backend.convex.cloud" });
    const cases = [
      ["rails", "in the layout, in place of the <%= critiqs_tag %> init added", '<%= critiqs_tag(backend: "https://team-backend.convex.cloud") %>'],
      ["django", "to the settings module (settings.py)", 'CRITIQS = {"BACKEND": "https://team-backend.convex.cloud"}'],
      ["flask", "after app = Flask(__name__), where init added Critiqs(app)", 'app.config["CRITIQS_BACKEND"] = "https://team-backend.convex.cloud"'],
      ["nuxt", "to nuxt.config, beside the critiqs-nuxt module init added", 'critiqs: { backend: "https://team-backend.convex.cloud" }'],
      ["wordpress", "to the script tag", 'data-backend="https://team-backend.convex.cloud"'],
    ] as const;
    for (const [stack, where, setting] of cases) {
      const page = await render(<InstallPanel project={project({ stack })} />, { backend });
      expect([stack, text(page)]).toEqual([stack, expect.stringContaining(`not Critiqs Cloud. Add this ${where}, so Critiqs connects there:`)]);
      await click(button(page, "Copy setting"));
      expect([stack, clipboard.text]).toEqual([stack, setting]);
      if (stack !== "wordpress") {
        await click(button(page, "Copy for a coding agent"));
        expect(clipboard.text).toContain(`add \`${setting}\` ${where}`);
      }
    }
  });

  test("a stack with no Critiqs package: the script tag's guide and the project ID to copy, with no command", async () => {
    const clipboard = fakeClipboard();
    let done = 0;
    const page = await render(<InstallPanel project={project({ stack: "laravel" })} onDone={() => done++} />);
    expect(text(page)).toContain("Laravel has no Critiqs package, so add Critiqs with a script tag on every page. The guide shows the tag; give it this project ID.");
    expect(page.querySelector("a")?.getAttribute("href")).toBe("https://github.com/noahsjung/critiqs/tree/main/packages/critiqs#with-a-script-tag");
    expect(page.querySelector(".command")).toBeNull();
    await click(button(page, "Copy project ID"));
    expect(clipboard.text).toBe(PROJECT_ID);
    expect(done).toBe(1);
  });

  test("when the browser won't copy the command, it asks to select it; no extra field, since it's on the page", async () => {
    refusingClipboard();
    const page = await render(<InstallPanel project={project()} />);
    await click(button(page, "Copy command"));
    expect(text(page)).toContain("Couldn't copy");
    expect(text(page)).toContain("Your browser didn't allow copying. Select the text and copy it.");
    expect(page.querySelector("textarea")).toBeNull();
    fakeClipboard();
  });
});

describe("My developer will: the email", () => {
  const NOW = Date.UTC(2026, 10, 25, 12);
  const summary = (overrides: Partial<DeveloperSendSummary> = {}): DeveloperSendSummary => ({ sendId: "s1", email: "dev@acme.com", status: "sent", lastSentAt: NOW - 60_000, ...overrides });
  const ACME_ADMIN: ProjectInfo["organization"] = { id: "o1", name: "Acme", role: "admin" };

  function Panel({
    initial,
    sends,
    send,
    organization = null,
    organizationState,
    onDone,
  }: {
    initial: string[];
    sends?: QueryState<DeveloperSendSummary[]>;
    send?: (emails: string[], resend?: boolean) => Promise<DeveloperSendResult[]>;
    organization?: ProjectInfo["organization"] | null;
    organizationState?: QueryState<ProjectInfo["organization"] | null>;
    onDone?: () => void;
  }) {
    const [developers, setDevelopers] = useState(initial);
    return (
      <SendPanelView
        project={project()}
        organization={organizationState ?? { status: "ready", data: organization }}
        developers={developers}
        onDevelopers={setDevelopers}
        email="sam@acme.com"
        sends={sends ?? { status: "ready", data: [] }}
        send={send ?? (async (emails) => emails.map((email) => ({ email, status: "sent", sendId: "s1", invite: "none" })))}
        onDone={onDone}
      />
    );
  }

  function Live({ initial }: { initial: string[] }) {
    const [developers, setDevelopers] = useState(initial);
    return <SendPanel project={project()} developers={developers} onDevelopers={setDevelopers} email="sam@acme.com" />;
  }

  test("one field, Send email, and a quiet Copy a message beside it", async () => {
    const page = await render(<Panel initial={[""]} />);
    expect(page.querySelector("h1")?.textContent).toBe("Send the steps to your developer");
    expect(page.querySelectorAll("input").length).toBe(1);
    expect(labelled(page, "Developer's email")).toBeDefined();
    expect(button(page, "Send email")?.className).toContain("primary");
    expect(button(page, "Copy a message to send yourself")?.className).toBe("quiet");
  });

  test("Copy a message copies core's message, linking to this site's setup page, and counts as done", async () => {
    const clipboard = fakeClipboard();
    let done = 0;
    const page = await render(<Panel initial={["dev@acme.com"]} onDone={() => done++} />);
    await click(button(page, "Copy a message to send yourself"));
    expect(clipboard.text).toBe(
      [
        "Can you add Critiqs to Acme prototype at acme-proto.vercel.app? It lets us comment right on the prototype.",
        `It's built with Next.js, so run these in its folder:\nnpm install critiqs-react\nnpx critiqs init ${PROJECT_ID}`,
        `Setup page: ${window.location.origin}/setup/${PROJECT_ID}`,
      ].join("\n\n"),
    );
    expect(text(page)).toContain("Message copied");
    expect(done).toBe(1);
  });

  test("on a backend other than Critiqs Cloud, the copied message says to give Critiqs that backend", async () => {
    const clipboard = fakeClipboard();
    const page = await render(<Panel initial={["dev@acme.com"]} />, { backend: fakeBackend({ componentBackend: "https://team-backend.convex.cloud" }) });
    await click(button(page, "Copy a message to send yourself"));
    expect(clipboard.text).toContain('This project is on our own Critiqs backend, not Critiqs Cloud. Add this on the <Critiqs /> component init added, so Critiqs connects there:\nbackend="https://team-backend.convex.cloud"');
  });

  test("Send emails each address that has none yet; once every one is sent, the form gives way to what was sent", async () => {
    const sent: string[][] = [];
    let done = 0;
    const page = await render(
      <Panel
        initial={["dev@acme.com", "lee@acme.com"]}
        sends={{ status: "ready", data: [summary({ email: "lee@acme.com" })] }}
        send={async (emails) => {
          sent.push(emails);
          return emails.map((email) => ({ email, status: "sent", sendId: "s2", invite: "none" }));
        }}
        onDone={() => done++}
      />,
    );
    expect(button(page, "Send email")).toBeDefined();
    await click(button(page, "Send email"));
    await settle();
    expect(sent).toEqual([["dev@acme.com"]]);
    expect(done).toBe(1);
    expect(page.querySelector("h1")?.textContent).toBe("Emails sent");
    expect([...page.querySelectorAll(".deliveries li")].map((line) => text(line))).toEqual(["Sent to dev@acme.com", "Sent to lee@acme.com"]);
    expect(page.querySelector("input")).toBeNull();
    expect(button(page, "Send to another developer")).toBeDefined();
  });

  test("two unsent addresses: Send emails", async () => {
    const page = await render(<Panel initial={["dev@acme.com", "lee@acme.com"]} />);
    expect(button(page, "Send emails")).toBeDefined();
  });

  test("Send to another developer brings back the form with a new empty field, up to three", async () => {
    const page = await render(<Panel initial={["dev@acme.com"]} sends={{ status: "ready", data: [summary()] }} />);
    expect(page.querySelector("h1")?.textContent).toBe("Email sent");
    await click(button(page, "Send to another developer"));
    expect([...page.querySelectorAll("input")].map((input) => input.value)).toEqual(["dev@acme.com", ""]);
    expect(text(page)).toContain("Sent to dev@acme.com");
    const full = await render(<Panel initial={["a@acme.com", "b@acme.com", "c@acme.com"]} sends={{ status: "ready", data: ["a", "b", "c"].map((name) => summary({ email: `${name}@acme.com` })) }} />);
    expect(button(full, "Send to another developer")).toBeUndefined();
  });

  test("nothing typed: Send says to enter an address and sends nothing; Copy a message still works", async () => {
    let calls = 0;
    const page = await render(<Panel initial={[""]} send={async () => (calls++, [])} />);
    expect(text(page)).not.toContain("Enter your developer's email address.");
    await click(button(page, "Send email"));
    expect(calls).toBe(0);
    expect(text(page)).toContain("Enter your developer's email address.");
    expect(button(page, "Copy a message to send yourself")).toBeDefined();
  });

  test("invalid, repeated, or own addresses aren't sent, and each field says why", async () => {
    let calls = 0;
    const page = await render(<Panel initial={["dev@acme", "sam@acme.com"]} send={async () => (calls++, [])} />);
    await click(button(page, "Send emails"));
    expect(calls).toBe(0);
    expect(text(page)).toContain("Enter a valid email address.");
    expect(text(page)).toContain("That's your own address. Enter your developer's.");
  });

  test("another spelling of an address already entered is refused, and Send moves focus to it", async () => {
    let calls = 0;
    const page = await render(<Panel initial={["dev+a@acme.com", "dev+b@acme.com"]} send={async () => (calls++, [])} />);
    await click(button(page, "Send emails"));
    expect(calls).toBe(0);
    const second = labelled(page, "Developer 2 email")!;
    expect(document.activeElement).toBe(second);
    expect(document.getElementById(second.getAttribute("aria-describedby")!)?.textContent).toBe("You already entered dev+b@acme.com.");
  });

  test("fields can be added and removed, up to three", async () => {
    const page = await render(<Panel initial={["dev@acme.com"]} />);
    await click(button(page, "Add another developer"));
    await click(button(page, "Add another developer"));
    expect(page.querySelectorAll("input").length).toBe(3);
    expect(button(page, "Add another developer")).toBeUndefined();
    await click(button(page, "Remove dev@acme.com"));
    expect([...page.querySelectorAll("input")].map((input) => input.value)).toEqual(["", ""]);
  });

  test("each refusal from the server, in words, with Copy message where Critiqs won't email", async () => {
    const clipboard = fakeClipboard();
    const results: DeveloperSendResult[] = [
      { email: "a@acme.com", status: "already-sent", sendId: "s1" },
      { email: "b@acme.com", status: "limit", limit: "person", message: "You've sent 5 developer emails today. Copy the message instead." },
      { email: "c@acme.com", status: "suppressed" },
    ];
    const page = await render(<Panel initial={["a@acme.com", "b@acme.com", "c@acme.com"]} send={async () => results} />);
    await click(button(page, "Send emails"));
    await settle();
    expect([...page.querySelectorAll(".deliveries .delivery-main")].map((line) => text(line))).toEqual([
      "Already sent to a@acme.com",
      "You've sent 5 developer emails today. Copy the message instead.",
      "c@acme.com turned off emails from Critiqs. Copy the message instead.",
    ]);
    expect(text(page)).not.toMatch(/resend/i);
    await click(button(page, "Copy message for a@acme.com"));
    expect(clipboard.text).toContain("Can you add Critiqs to Acme prototype");
  });

  test("an address the server can't use says so", () => {
    expect(deliveryLine("x@acme", undefined, { email: "x@acme", status: "invalid", message: "Enter a valid email address." })).toEqual({ text: "x@acme: Enter a valid email address.", tone: "error", action: null });
  });

  test("an admin is told before sending that developers are invited, then sees each invite apart from its email", async () => {
    const results: DeveloperSendResult[] = [
      { email: "a@acme.com", status: "sent", sendId: "s1", invite: "created" },
      { email: "b@acme.com", status: "sent", sendId: "s2", invite: "pending" },
      { email: "c@acme.com", status: "sent", sendId: "s3", invite: "member" },
    ];
    const page = await render(<Panel initial={["a@acme.com", "b@acme.com", "c@acme.com"]} organization={ACME_ADMIN} send={async () => results} />);
    expect(text(page)).toContain("They'll also be invited to Acme.");
    await click(button(page, "Send emails"));
    await settle();
    expect([...page.querySelectorAll(".deliveries li .delivery-text")].map((line) => [...line.children].map((part) => text(part)))).toEqual([
      ["Sent to a@acme.com", "a@acme.com is invited to Acme."],
      ["Sent to b@acme.com", "b@acme.com was already invited to Acme."],
      ["Sent to c@acme.com", "c@acme.com is already in Acme."],
    ]);
    const capped = await render(<Panel initial={["d@acme.com"]} organization={ACME_ADMIN} send={async () => [{ email: "d@acme.com", status: "sent", sendId: "s4", invite: "limit" }]} />);
    await click(button(capped, "Send email"));
    await settle();
    expect(text(capped.querySelector(".deliveries")!)).toBe("Sent to d@acme.comAcme can't invite anyone else today, so d@acme.com wasn't invited.");
  });

  test("a member who isn't an admin is told nothing about invites", async () => {
    const page = await render(<Panel initial={["a@acme.com"]} organization={{ id: "o1", name: "Acme", role: "member" }} />);
    expect(text(page)).not.toMatch(/invite/i);
    await click(button(page, "Send email"));
    await settle();
    expect(text(page.querySelector(".deliveries")!)).toBe("Sent to a@acme.com");
  });

  test("Send and Send again wait for the project's organization, so the invite note always comes first", async () => {
    const failed = { status: "ready" as const, data: [summary({ status: "failed" })] };
    const loading = await render(<Panel initial={["dev@acme.com", "lee@acme.com"]} sends={failed} organizationState={{ status: "loading" }} />);
    expect(button(loading, "Send emails")?.disabled).toBe(true);
    expect(button(loading, "Send again to dev@acme.com")?.disabled).toBe(true);
    const errored = await render(<Panel initial={["lee@acme.com"]} organizationState={{ status: "error", code: "error", message: "Something went wrong." }} />);
    expect(button(errored, "Send email")?.disabled).toBe(true);
    expect(text(errored)).toContain("Critiqs can't email yet. Copy the message instead, or try again later.");
    // The live panel, with a lookup that answers late: Send waits for it, then the note shows before anything is sent.
    const info: ProjectInfo = { _id: PROJECT_ID, name: "Acme prototype", tags: [], createdAt: 0, reviewUrl: null, isOwner: true, organization: ACME_ADMIN! };
    const slow = fakeBackend({ projectState: { status: "loading" } });
    const page = await render(<Live initial={["lee@acme.com"]} />, { backend: slow });
    expect(button(page, "Send email")?.disabled).toBe(true);
    await click(button(page, "Send email"));
    expect(slow.calls).toEqual([]);
    await rerender(<Live initial={["lee@acme.com"]} />, { backend: fakeBackend({ project: info }) });
    expect(text(page)).toContain("They'll also be invited to Acme.");
    expect(button(page, "Send email")?.disabled).toBe(false);
  });

  test("while the project's organization loads, a status line says why Send waits, and it goes once the organization is known", async () => {
    const loading = await render(<Panel initial={["dev@acme.com"]} organizationState={{ status: "loading" }} />);
    const send = button(loading, "Send email")!;
    expect(send.disabled).toBe(true);
    const status = loading.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Checking your organization before sending…");
    // The button names the reason, so it's read with the button.
    expect(send.getAttribute("aria-describedby")).toBe(status!.id);
    const ready = await render(<Panel initial={["dev@acme.com"]} organization={ACME_ADMIN} />);
    expect(ready.querySelector('[role="status"]')).toBeNull();
    expect(button(ready, "Send email")?.hasAttribute("aria-describedby")).toBe(false);
    expect(text(ready)).toContain("They'll also be invited to Acme.");
  });

  test("a failed email offers Send again, which emails just that address", async () => {
    const sent: string[][] = [];
    const page = await render(
      <Panel
        initial={["dev@acme.com", "lee@acme.com"]}
        sends={{ status: "ready", data: [summary({ status: "failed" }), summary({ sendId: "s2", email: "lee@acme.com" })] }}
        send={async (emails) => (sent.push(emails), [])}
      />,
    );
    expect(text(page.querySelector(".deliveries li")!)).toBe("Couldn't send to dev@acme.comSend again");
    await click(button(page, "Send again to dev@acme.com"));
    await settle();
    expect(sent).toEqual([["dev@acme.com"]]);
  });

  test("24 hours after an email went out, Send again sends the steps again to just that address; before then, nothing", async () => {
    const asked: [string[], boolean | undefined][] = [];
    const send = async (emails: string[], resend?: boolean) => (asked.push([emails, resend]), emails.map((email) => ({ email, status: "sent" as const, sendId: "s1", invite: "none" as const })));
    const now = Date.now();
    const sends = { status: "ready" as const, data: [summary({ resendAt: now - 1 }), summary({ sendId: "s2", email: "lee@acme.com", resendAt: now + 3_600_000 })] };
    const page = await render(<Panel initial={["dev@acme.com", "lee@acme.com"]} sends={sends} send={send} />, { backend: fakeBackend({ developerResends: true }) });
    expect([...page.querySelectorAll(".deliveries li")].map((row) => row.querySelector("button")?.getAttribute("aria-label") ?? null)).toEqual(["Send the steps again to dev@acme.com", null]);
    await click(button(page, "Send the steps again to dev@acme.com"));
    await settle();
    expect(asked).toEqual([[["dev@acme.com"], true]]);
    // A backend that can't send again offers nothing.
    const older = await render(<Panel initial={["dev@acme.com"]} sends={sends} send={send} />);
    expect(older.querySelector(".deliveries button")).toBeNull();
  });

  test("a refused retry of a failed email shows the refusal in place of the failure", async () => {
    const refusals: DeveloperSendResult[] = [
      { email: "dev@acme.com", status: "limit", limit: "person", message: "You've sent 5 developer emails today. Copy the message instead." },
      { email: "dev@acme.com", status: "suppressed" },
      { email: "dev@acme.com", status: "invalid", message: "Enter a valid email address." },
    ];
    const lines: string[] = [];
    for (const refusal of refusals) {
      const page = await render(<Panel initial={["dev@acme.com"]} sends={{ status: "ready", data: [summary({ status: "failed" })] }} send={async () => [refusal]} />);
      await click(button(page, "Send again to dev@acme.com"));
      await settle();
      lines.push(text(page.querySelector(".deliveries .delivery-main")!));
    }
    expect(lines).toEqual([
      "You've sent 5 developer emails today. Copy the message instead.",
      "dev@acme.com turned off emails from Critiqs. Copy the message instead.",
      "dev@acme.com: Enter a valid email address.",
    ]);
  });

  test("records and answers match the exact address, lowercased and trimmed; not another address of the same inbox", async () => {
    const page = await render(<Panel initial={["dev+second@acme.com"]} sends={{ status: "ready", data: [summary({ email: "dev+first@acme.com" })] }} />);
    expect(page.querySelector(".deliveries")).toBeNull();
    expect(button(page, "Send email")?.disabled).toBe(false);
    const same = await render(<Panel initial={[" Dev+First@Acme.com "]} sends={{ status: "ready", data: [summary({ email: "dev+first@acme.com" })] }} />);
    expect(text(same.querySelector(".deliveries")!)).toBe("Sent to Dev+First@Acme.com");
    expect(button(same, "Send email")).toBeUndefined();
  });

  test("an email whose answer never came counts as sent", async () => {
    const page = await render(<Panel initial={["dev@acme.com"]} sends={{ status: "ready", data: [summary({ status: "uncertain" })] }} />);
    expect(text(page.querySelector(".deliveries")!)).toBe("Sent to dev@acme.com");
  });

  test("a refusal of the whole request shows the server's message, with Copy message instead beside it", async () => {
    const clipboard = fakeClipboard();
    const message = "Project names in setup emails can't contain web addresses. Rename the project and try again.";
    const page = await render(
      <Panel
        initial={["dev@acme.com"]}
        send={async () => {
          throw Object.assign(new Error("Server Error"), { data: { code: "invalid", message } });
        }}
      />,
    );
    await click(button(page, "Send email"));
    await settle();
    expect(page.querySelector("[role='alert']")?.textContent).toBe(message);
    await click(button(page, "Copy message instead"));
    expect(clipboard.text).toContain("Can you add Critiqs to Acme prototype");
  });

  test("when the browser won't copy the message, it's shown in a field to select", async () => {
    refusingClipboard();
    const page = await render(<Panel initial={["dev@acme.com"]} />);
    await click(button(page, "Copy a message to send yourself"));
    expect(text(page)).toContain("Your browser didn't allow copying. Select the text below and copy it.");
    expect(page.querySelector("textarea")?.value).toContain("Can you add Critiqs to Acme prototype");
    fakeClipboard();
  });

  test("the live panel asks the backend for the project's sends", async () => {
    const page = await render(<Live initial={["dev@acme.com"]} />, { backend: fakeBackend({ sends: [summary()] }) });
    expect(text(page)).toContain("Sent to dev@acme.com");
  });
});
