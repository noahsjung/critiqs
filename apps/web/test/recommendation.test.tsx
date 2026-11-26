import { describe, expect, test } from "bun:test";
import { type DeveloperSendResult, type DeveloperSendSummary, type ProjectInfo, STACKS } from "@critiqs/core";
import { useState } from "react";
import type { CreatedProject } from "../src/flow.ts";
import type { QueryState } from "../src/shared.ts";
import { deliveryLine, InstallCard, Recommendation, SendCardView } from "../src/ui/Recommendation.tsx";
import { button, click, fakeBackend, fakeClipboard, labelled, refusingClipboard, render, rerender, settle, text, type } from "./render.tsx";

// The recommendation's cards as people see them: which way comes first,
// each install variant, and every answer to sending setup emails.

const PROJECT_ID = "n579b6w6641phdvxeymddfn1zd8jwjxw";
const stack = (id: string) => STACKS.find((candidate) => candidate.id === id)!;
const project = (overrides: Partial<CreatedProject> = {}): CreatedProject => ({
  id: PROJECT_ID,
  name: "Acme prototype",
  reviewUrl: "https://acme-proto.vercel.app/",
  answers: {},
  stack: "next",
  check: { kind: "public", stack: "next" },
  ...overrides,
});

function WithFields({ initial, project: shown }: { initial: string[]; project: CreatedProject }) {
  const [developers, setDevelopers] = useState(initial);
  return <Recommendation project={shown} developers={developers} onDevelopers={setDevelopers} email="sam@acme.com" />;
}

describe("which way is recommended", () => {
  const recommended = (page: Element) => page.querySelector(".recommended > .way")?.getAttribute("aria-label");
  const others = (page: Element) => [...page.querySelectorAll(".other-ways > .way")].map((way) => way.getAttribute("aria-label"));

  test("someone else changes the code: Send to your developer, with Install below", async () => {
    const page = await render(<WithFields initial={["dev@acme.com"]} project={project({ answers: { codeAccess: "teammate" } })} />);
    expect(recommended(page)).toBe("Send to your developer");
    expect(text(page.querySelector(".recommended")!)).toContain("A developer on your team can add Critiqs in a few minutes.");
    expect(others(page)).toEqual(["Install in your app"]);
    expect(labelled(page, "Developer 1 email")?.value).toBe("dev@acme.com");
    expect(button(page, "Someone else changes the code")).toBeUndefined();
  });

  test("nobody can change it: Send to your developer, saying so", async () => {
    const page = await render(<WithFields initial={[""]} project={project({ answers: { codeAccess: "nobody" } })} />);
    expect(recommended(page)).toBe("Send to your developer");
    expect(text(page)).toContain("Send the setup steps to whoever maintains the prototype.");
  });

  test("every question skipped: Install, as the default, with Send below", async () => {
    const page = await render(<WithFields initial={[""]} project={project({ answers: {}, stack: null, check: { kind: "none" }, reviewUrl: null })} />);
    expect(recommended(page)).toBe("Install in your app");
    expect(text(page)).toContain("Installing puts comments right on the prototype your reviewers open.");
    expect(others(page)).toEqual(["Send to your developer"]);
  });

  test("an engineer who skipped can say someone else changes the code, which puts Send first", async () => {
    const page = await render(<WithFields initial={[""]} project={project({ answers: { role: "engineer" } })} />);
    expect(recommended(page)).toBe("Install in your app");
    expect(text(page)).toContain("You can add Critiqs to the build your reviewers already open.");
    await click(button(page, "Someone else changes the code"));
    expect(recommended(page)).toBe("Send to your developer");
    expect(others(page)).toEqual(["Install in your app"]);
    expect(button(page, "Someone else changes the code")).toBeUndefined();
  });

  test("only ways that exist today have cards", async () => {
    const page = await render(<WithFields initial={[""]} project={project({ answers: { codeAccess: "nobody" }, check: { kind: "sign-in", via: "redirect", host: "accounts.google.com", stack: null } })} />);
    expect([recommended(page), ...others(page)]).toEqual(["Send to your developer", "Install in your app"]);
    expect(text(page)).not.toMatch(/extension|review link|share a build/i);
  });
});

describe("Install in your app", () => {
  test("an installable stack: both commands, each with Copy, and a coding agent's prompt", async () => {
    const clipboard = fakeClipboard();
    const page = await render(<InstallCard projectId={PROJECT_ID} stack={stack("next")} reason={null} />);
    expect(text(page)).toContain("Run these in the prototype's folder");
    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["npm install critiqs-react", `npx critiqs-react init ${PROJECT_ID}`]);
    await click(button(page, `Copy command: npx critiqs-react init ${PROJECT_ID}`));
    expect(clipboard.text).toBe(`npx critiqs-react init ${PROJECT_ID}`);
    expect(text(page)).toContain("Command copied");
    await click(button(page, "Copy prompt"));
    expect(clipboard.text).toBe(`Add Critiqs to this Next.js app: run \`npm install critiqs-react\`, then \`npx critiqs-react init ${PROJECT_ID}\` in its folder, and follow the steps they print.`);
  });

  test("an unknown stack: the same commands, for a React app built with Vite or Next.js", async () => {
    const page = await render(<InstallCard projectId={PROJECT_ID} stack={null} reason={null} />);
    expect(text(page)).toContain("If your prototype is a React app built with Vite or Next.js, run these in its folder.");
    expect(page.querySelectorAll("code")).toHaveLength(2);
  });

  test("a project on a backend other than Critiqs Cloud: a step that gives <Critiqs /> its backend, also in the agent's prompt", async () => {
    const clipboard = fakeClipboard();
    const backend = fakeBackend({ componentBackend: "https://team-backend.convex.cloud" });
    const page = await render(<InstallCard projectId={PROJECT_ID} stack={stack("react")} reason={null} />, { backend });
    expect(text(page)).toContain("This project is on your team's own Critiqs backend, not Critiqs Cloud. Then add this property to the <Critiqs /> component that init adds, so it connects there:");
    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "npm install critiqs-react",
      `npx critiqs-react init ${PROJECT_ID}`,
      'backend="https://team-backend.convex.cloud"',
    ]);
    await click(button(page, "Copy prompt"));
    expect(clipboard.text).toBe(
      `Add Critiqs to this React (Vite) app: run \`npm install critiqs-react\`, then \`npx critiqs-react init ${PROJECT_ID}\` in its folder, and follow the steps they print. Then add \`backend="https://team-backend.convex.cloud"\` to the <Critiqs /> component init added, so it connects to this project's backend instead of Critiqs Cloud.`,
    );
    // Critiqs Cloud, the component's default, needs no step.
    const cloud = await render(<InstallCard projectId={PROJECT_ID} stack={stack("react")} reason={null} />);
    expect(text(cloud)).not.toContain("backend");
  });

  test("a stack Critiqs can't install in yet: says so, with no commands", async () => {
    const page = await render(<InstallCard projectId={PROJECT_ID} stack={stack("vue")} reason={null} />);
    expect(text(page)).toContain("Critiqs installs in React apps built with Vite or Next.js today. Vue support is coming.");
    expect(page.querySelectorAll("code")).toHaveLength(0);
    expect(button(page, "Copy prompt")).toBeUndefined();
  });
});

describe("Send to your developer", () => {
  const NOW = Date.UTC(2026, 10, 25, 12);
  const summary = (overrides: Partial<DeveloperSendSummary> = {}): DeveloperSendSummary => ({
    sendId: "s1",
    email: "dev@acme.com",
    status: "sent",
    lastSentAt: NOW - 60_000,
    ...overrides,
  });
  const ACME_ADMIN: ProjectInfo["organization"] = { id: "o1", name: "Acme", role: "admin" };

  function Card({
    initial,
    sends,
    send,
    organization = null,
    organizationState,
  }: {
    initial: string[];
    sends?: QueryState<DeveloperSendSummary[]>;
    send?: (emails: string[]) => Promise<DeveloperSendResult[]>;
    organization?: ProjectInfo["organization"] | null;
    organizationState?: QueryState<ProjectInfo["organization"] | null>;
  }) {
    const [developers, setDevelopers] = useState(initial);
    return (
      <SendCardView
        project={project({ answers: { codeAccess: "teammate" } })}
        organization={organizationState ?? { status: "ready", data: organization }}
        developers={developers}
        onDevelopers={setDevelopers}
        email="sam@acme.com"
        reason="A developer on your team can add Critiqs in a few minutes."
        sends={sends ?? { status: "ready", data: [] }}
        send={send ?? (async (emails) => emails.map((email) => ({ email, status: "sent", sendId: "s1", invite: "none" })))}
      />
    );
  }

  test("Copy message copies core's message, linking to this site's setup page for the project", async () => {
    const clipboard = fakeClipboard();
    const page = await render(<Card initial={["dev@acme.com"]} />);
    await click(button(page, "Copy message"));
    expect(clipboard.text).toBe(
      [
        "Can you add Critiqs to Acme prototype at acme-proto.vercel.app? It lets us comment right on the prototype.",
        `It's built with Next.js, so run these in its folder:\nnpm install critiqs-react\nnpx critiqs-react init ${PROJECT_ID}`,
        `Setup page: ${window.location.origin}/setup/${PROJECT_ID}`,
      ].join("\n\n"),
    );
    expect(text(page)).toContain("Message copied");
  });

  test("on a backend other than Critiqs Cloud, the copied message says to give <Critiqs /> that backend", async () => {
    const clipboard = fakeClipboard();
    const page = await render(<Card initial={["dev@acme.com"]} />, { backend: fakeBackend({ componentBackend: "https://team-backend.convex.cloud" }) });
    await click(button(page, "Copy message"));
    expect(clipboard.text).toBe(
      [
        "Can you add Critiqs to Acme prototype at acme-proto.vercel.app? It lets us comment right on the prototype.",
        `It's built with Next.js, so run these in its folder:\nnpm install critiqs-react\nnpx critiqs-react init ${PROJECT_ID}`,
        'This project is on our own Critiqs backend, not Critiqs Cloud. Then add this property to the <Critiqs /> component that init adds, so it connects there:\nbackend="https://team-backend.convex.cloud"',
        `Setup page: ${window.location.origin}/setup/${PROJECT_ID}`,
      ].join("\n\n"),
    );
  });

  test("Send emails each address that has none yet, and says each was sent", async () => {
    const sent: string[][] = [];
    const page = await render(
      <Card
        initial={["dev@acme.com", "lee@acme.com"]}
        sends={{ status: "ready", data: [summary({ email: "lee@acme.com" })] }}
        send={async (emails) => {
          sent.push(emails);
          return emails.map((email) => ({ email, status: "sent", sendId: "s2", invite: "none" }));
        }}
      />,
    );
    expect(button(page, "Send setup email")).toBeDefined();
    await click(button(page, "Send setup email"));
    await settle();
    expect(sent).toEqual([["dev@acme.com"]]);
    expect(text(page)).toContain("Sent to dev@acme.com.");
  });

  test("two unsent addresses: Send setup emails", async () => {
    const page = await render(<Card initial={["dev@acme.com", "lee@acme.com"]} />);
    expect(button(page, "Send setup emails")).toBeDefined();
  });

  test("invalid, repeated, or own addresses aren't sent, and each field says why", async () => {
    let calls = 0;
    const page = await render(
      <Card
        initial={["dev@acme", "sam@acme.com"]}
        send={async () => {
          calls++;
          return [];
        }}
      />,
    );
    await click(button(page, "Send setup emails"));
    expect(calls).toBe(0);
    expect(text(page)).toContain("Enter a valid email address.");
    expect(text(page)).toContain("That's your address. Choose Yes to see the install steps.");
  });

  test("the fields can be edited, added to, and removed, up to three", async () => {
    const page = await render(<Card initial={["dev@acme.com"]} />);
    await click(button(page, "Add another developer"));
    await type(labelled(page, "Developer 2 email"), "lee@acme.com");
    await click(button(page, "Add another developer"));
    expect(button(page, "Add another developer")).toBeUndefined();
    expect(text(page)).toContain("Up to 3 developers per project.");
    await click(button(page, "Remove lee@acme.com"));
    expect([...page.querySelectorAll("input")].map((input) => input.value)).toEqual(["dev@acme.com", ""]);
  });

  test("each answer from the server, in words, with Copy message where Critiqs won't email", async () => {
    const clipboard = fakeClipboard();
    const results: DeveloperSendResult[] = [
      { email: "a@acme.com", status: "already-sent", sendId: "s1" },
      { email: "b@acme.com", status: "limit", limit: "person", message: "You've sent 5 developer emails today. Copy the message instead." },
      { email: "c@acme.com", status: "suppressed" },
    ];
    const page = await render(<Card initial={["a@acme.com", "b@acme.com", "c@acme.com"]} send={async () => results} />);
    await click(button(page, "Send setup emails"));
    await settle();
    const lines = [...page.querySelectorAll(".deliveries li > span")].map((line) => text(line));
    expect(lines).toEqual([
      "Already sent to a@acme.com.",
      "You've sent 5 developer emails today. Copy the message instead.",
      "c@acme.com turned off emails from Critiqs. Copy the message instead.",
    ]);
    expect(text(page)).not.toMatch(/resend/i);
    await click(button(page, "Copy message for a@acme.com"));
    expect(clipboard.text).toContain("Can you add Critiqs to Acme prototype");
  });

  test("an address the server can't use says so", () => {
    expect(deliveryLine("x@acme", undefined, { email: "x@acme", status: "invalid", message: "Enter a valid email address." })).toEqual({
      text: "x@acme: Enter a valid email address.",
      tone: "error",
      action: null,
    });
  });

  test("a sent email: one per developer, so no Resend, and Send leaves it out", async () => {
    const page = await render(<Card initial={["dev@acme.com"]} sends={{ status: "ready", data: [summary()] }} />);
    expect(text(page.querySelector(".deliveries")!)).toBe("Sent to dev@acme.com.");
    expect(button(page, "Resend")).toBeUndefined();
    expect(button(page, "Send setup email")).toBeUndefined();
  });

  test("an admin is told before sending that developers are invited to the organization, then sees each invite apart from its email", async () => {
    const results: DeveloperSendResult[] = [
      { email: "a@acme.com", status: "sent", sendId: "s1", invite: "created" },
      { email: "b@acme.com", status: "sent", sendId: "s2", invite: "pending" },
      { email: "c@acme.com", status: "sent", sendId: "s3", invite: "member" },
    ];
    const page = await render(<Card initial={["a@acme.com", "b@acme.com", "c@acme.com"]} organization={ACME_ADMIN} send={async () => results} />);
    expect(text(page)).toContain("They'll also be invited to join Acme when they sign in.");
    await click(button(page, "Send setup emails"));
    await settle();
    expect([...page.querySelectorAll(".deliveries li .delivery-text")].map((line) => [...line.children].map((part) => text(part)))).toEqual([
      ["Sent to a@acme.com.", "a@acme.com is invited to join Acme when they sign in."],
      ["Sent to b@acme.com.", "b@acme.com was already invited to Acme."],
      ["Sent to c@acme.com.", "c@acme.com is already in Acme."],
    ]);
    const capped = await render(<Card initial={["d@acme.com"]} organization={ACME_ADMIN} send={async () => [{ email: "d@acme.com", status: "sent", sendId: "s4", invite: "limit" }]} />);
    await click(button(capped, "Send setup email"));
    await settle();
    expect(text(capped.querySelector(".deliveries")!)).toBe("Sent to d@acme.com.Acme can't invite anyone else today, so d@acme.com wasn't invited.");
  });

  test("a member who isn't an admin is told nothing about invites, and none are shown", async () => {
    const page = await render(<Card initial={["a@acme.com"]} organization={{ id: "o1", name: "Acme", role: "member" }} />);
    expect(text(page)).not.toMatch(/invite/i);
    await click(button(page, "Send setup email"));
    await settle();
    expect(text(page.querySelector(".deliveries")!)).toBe("Sent to a@acme.com.");
  });

  test("Send and Send again wait for the project's organization, so the invite note always comes first", async () => {
    const failed = { status: "ready" as const, data: [summary({ status: "failed" })] };
    const loading = await render(<Card initial={["dev@acme.com", "lee@acme.com"]} sends={failed} organizationState={{ status: "loading" }} />);
    expect(button(loading, "Send setup emails")?.disabled).toBe(true);
    expect(button(loading, "Send again to dev@acme.com")?.disabled).toBe(true);
    const errored = await render(<Card initial={["lee@acme.com"]} organizationState={{ status: "error", code: "error", message: "Something went wrong." }} />);
    expect(button(errored, "Send setup email")?.disabled).toBe(true);
    expect(text(errored)).toContain("The project's organization couldn't be loaded, so Critiqs can't email yet. Copy the message instead, or try again later.");
    // The live card, with a lookup that answers late: Send waits for it, then the note shows before anything is sent.
    const info: ProjectInfo = { _id: PROJECT_ID, name: "Acme prototype", tags: [], createdAt: 0, reviewUrl: null, isOwner: true, organization: ACME_ADMIN! };
    const shown = project({ answers: { codeAccess: "teammate" } });
    const slow = fakeBackend({ projectState: { status: "loading" } });
    const page = await render(<WithFields initial={["lee@acme.com"]} project={shown} />, { backend: slow });
    expect(button(page, "Send setup email")?.disabled).toBe(true);
    await click(button(page, "Send setup email"));
    expect(slow.calls).toEqual([]);
    const answered = fakeBackend({ project: info });
    await rerender(<WithFields initial={["lee@acme.com"]} project={shown} />, { backend: answered });
    expect(text(page)).toContain("They'll also be invited to join Acme when they sign in.");
    expect(button(page, "Send setup email")?.disabled).toBe(false);
  });

  test("the live card reads the project's organization for the invite note", async () => {
    const backend = fakeBackend({ project: { _id: PROJECT_ID, name: "Acme prototype", tags: [], createdAt: 0, reviewUrl: null, isOwner: true, organization: ACME_ADMIN! } });
    const page = await render(<WithFields initial={["dev@acme.com"]} project={project({ answers: { codeAccess: "teammate" } })} />, { backend });
    expect(text(page)).toContain("They'll also be invited to join Acme when they sign in.");
  });

  test("a failed email offers Send again, which emails just that address", async () => {
    const sent: string[][] = [];
    const page = await render(
      <Card
        initial={["dev@acme.com", "lee@acme.com"]}
        sends={{ status: "ready", data: [summary({ status: "failed" }), summary({ sendId: "s2", email: "lee@acme.com" })] }}
        send={async (emails) => {
          sent.push(emails);
          return [];
        }}
      />,
    );
    expect(text(page.querySelector(".deliveries li")!)).toBe("Couldn't send to dev@acme.com.Send again");
    await click(button(page, "Send again to dev@acme.com"));
    await settle();
    expect(sent).toEqual([["dev@acme.com"]]);
  });

  test("a refused retry of a failed email shows the refusal in place of the failure", async () => {
    const refusals: DeveloperSendResult[] = [
      { email: "dev@acme.com", status: "limit", limit: "person", message: "You've sent 5 developer emails today. Copy the message instead." },
      { email: "dev@acme.com", status: "suppressed" },
      { email: "dev@acme.com", status: "invalid", message: "Enter a valid email address." },
    ];
    const lines: string[] = [];
    for (const refusal of refusals) {
      const page = await render(<Card initial={["dev@acme.com"]} sends={{ status: "ready", data: [summary({ status: "failed" })] }} send={async () => [refusal]} />);
      await click(button(page, "Send again to dev@acme.com"));
      await settle();
      lines.push(text(page.querySelector(".deliveries li span")!));
    }
    expect(lines).toEqual([
      "You've sent 5 developer emails today. Copy the message instead.",
      "dev@acme.com turned off emails from Critiqs. Copy the message instead.",
      "dev@acme.com: Enter a valid email address.",
    ]);
  });

  test("records and answers match the exact address, lowercased and trimmed, as the server keeps them; not another address of the same inbox", async () => {
    const page = await render(<Card initial={["dev+second@acme.com"]} sends={{ status: "ready", data: [summary({ email: "dev+first@acme.com" })] }} />);
    expect(page.querySelector(".deliveries")).toBeNull();
    expect(text(page)).not.toContain("Sent to");
    expect(button(page, "Send setup email")?.disabled).toBe(false);
    const same = await render(<Card initial={[" Dev+First@Acme.com "]} sends={{ status: "ready", data: [summary({ email: "dev+first@acme.com" })] }} />);
    expect(text(same.querySelector(".deliveries")!)).toBe("Sent to Dev+First@Acme.com.");
    expect(button(same, "Send setup email")).toBeUndefined();
    const answered = await render(<Card initial={["Dev+QA@acme.com"]} send={async () => [{ email: "dev+qa@acme.com", status: "suppressed" }]} />);
    await click(button(answered, "Send setup email"));
    await settle();
    expect(text(answered.querySelector(".deliveries li span")!)).toBe("Dev+QA@acme.com turned off emails from Critiqs. Copy the message instead.");
  });

  test("another spelling of an address already entered is refused, and Send moves focus to it", async () => {
    let calls = 0;
    const page = await render(<Card initial={["dev+a@acme.com", "dev+b@acme.com"]} send={async () => (calls++, [])} />);
    await click(button(page, "Send setup emails"));
    expect(calls).toBe(0);
    const second = labelled(page, "Developer 2 email")!;
    expect(document.activeElement).toBe(second);
    expect(document.getElementById(second.getAttribute("aria-describedby")!)?.textContent).toBe("You already entered dev+b@acme.com.");
  });

  test("when the browser won't copy, the button says so and asks to select the text, shown in a field", async () => {
    refusingClipboard();
    const page = await render(<Card initial={["dev@acme.com"]} />);
    await click(button(page, "Copy message"));
    expect(text(page)).toContain("Couldn't copy");
    expect(text(page)).toContain("Your browser didn't allow copying. Select the text below and copy it.");
    expect(page.querySelector("textarea")?.value).toContain("Can you add Critiqs to Acme prototype");
    expect(text(page)).not.toContain("Message copied");
    // A command is on the page already: no field, only how to copy it.
    const card = await render(<InstallCard projectId={PROJECT_ID} stack={stack("next")} reason={null} />);
    await click(button(card, "Copy command: npm install critiqs-react"));
    expect(text(card)).toContain("Couldn't copy");
    expect(text(card)).toContain("Your browser didn't allow copying. Select the text and copy it.");
    expect(card.querySelector("textarea")).toBeNull();
    fakeClipboard();
  });

  test("a failed email can be sent again straight away with Send", async () => {
    const sent: string[][] = [];
    const page = await render(
      <Card
        initial={["dev@acme.com"]}
        sends={{ status: "ready", data: [summary({ status: "failed" })] }}
        send={async (emails) => {
          sent.push(emails);
          return [];
        }}
      />,
    );
    expect(text(page.querySelector(".deliveries")!)).toBe("Couldn't send to dev@acme.com.Send again");
    await click(button(page, "Send setup email"));
    await settle();
    expect(sent).toEqual([["dev@acme.com"]]);
  });

  test("an email whose answer never came counts as sent", async () => {
    const page = await render(<Card initial={["dev@acme.com"]} sends={{ status: "ready", data: [summary({ status: "uncertain" })] }} />);
    expect(text(page.querySelector(".deliveries")!)).toMatch(/^Sent to dev@acme\.com\./);
  });

  test("a refusal of the whole request shows the server's message, with Copy message beside it", async () => {
    const clipboard = fakeClipboard();
    const message = "Project names in setup emails can't contain web addresses. Rename the project and try again.";
    const page = await render(
      <Card
        initial={["dev@acme.com"]}
        send={async () => {
          throw Object.assign(new Error("Server Error"), { data: { code: "invalid", message } });
        }}
      />,
    );
    await click(button(page, "Send setup email"));
    await settle();
    expect(page.querySelector("[role='alert']")?.textContent).toBe(message);
    const beside = page.querySelector(".request-failure button");
    expect(beside?.textContent).toBe("Copy message instead");
    await click(beside);
    expect(clipboard.text).toContain("Can you add Critiqs to Acme prototype");
  });

  test("a deployment that can't send email says to copy the message", async () => {
    const page = await render(
      <Card
        initial={["dev@acme.com"]}
        send={async () => {
          throw Object.assign(new Error("Server Error"), { data: { code: "unavailable", message: "This deployment can't send setup emails. Copy the message instead." } });
        }}
      />,
    );
    await click(button(page, "Send setup email"));
    await settle();
    expect(page.querySelector("[role='alert']")?.textContent).toBe("This deployment can't send setup emails. Copy the message instead.");
  });

  test("no address yet: says to add one, with Copy message still there", async () => {
    const page = await render(<Card initial={[""]} />);
    expect(text(page)).toContain("Add a developer's email address to send the setup steps.");
    expect(button(page, "Send setup email")).toBeUndefined();
    expect(button(page, "Copy message")).toBeDefined();
  });

  test("the live card asks the backend for the project's sends", async () => {
    const backend = fakeBackend({ sends: [summary()] });
    const page = await render(<WithFields initial={["dev@acme.com"]} project={project({ answers: { codeAccess: "teammate" } })} />, { backend });
    expect(text(page)).toContain("Sent to dev@acme.com.");
  });
});
