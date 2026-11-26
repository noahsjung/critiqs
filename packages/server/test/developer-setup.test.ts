import { expect, test } from "bun:test";
import { inboxOf as coresInboxOf, SCRIPT_TAG_GUIDE, type StackId } from "@critiqs/core";
import { developerSetupMessage, hasWebAddress, readReportToken, reportToken, sendStatus, webBase } from "../src/developer-setup.ts";
import { inboxOf } from "../src/index.ts";
import { MAX_NAME_SHOWN } from "../src/organizations.ts";
import { MailError, resendMailer, senderAs, signInCodeMessage } from "../src/signin.ts";

const PROJECT = "p_0123456789abcdef0123456789abcdef";

function message(overrides: Partial<Parameters<typeof developerSetupMessage>[0]> = {}) {
  return developerSetupMessage({
    to: "dev@acme.com",
    inviterName: "Sam Lee",
    inviterEmail: "sam@acme.com",
    projectName: "Acme prototype",
    projectId: PROJECT,
    stack: "next",
    someoneElseChangesCode: true,
    setupUrl: "https://critiqs.app/setup/e_1",
    reportUrl: "https://backend.example/developer-emails/report?token=a.b",
    joining: "Acme",
    idempotencyKey: "critiqs-developer:e_1:0",
    ...overrides,
  });
}

test("the setup email comes from Critiqs as the inviter, with replies to them", () => {
  const email = message();
  expect(email).toMatchObject({
    to: "dev@acme.com",
    fromName: "Sam Lee via Critiqs",
    replyTo: "sam@acme.com",
    subject: "Sam Lee asked you to add Critiqs to Acme prototype",
    idempotencyKey: "critiqs-developer:e_1:0",
  });
  expect(email.text).toBe(
    [
      "Sam Lee (sam@acme.com) is setting up Critiqs so your team can comment right on the prototype. They said someone else changes its code, so they asked us to send you the setup steps.",
      "Project: Acme prototype\nBuilt with: Next.js",
      `Run these in the prototype's folder. They already have the project ID:\n\nnpm install critiqs-react\nnpx critiqs init ${PROJECT}`,
      "Setup steps: https://critiqs.app/setup/e_1\nThe setup page shows the prototype's address once you sign in.",
      "You don't need anyone's approval. Sign in to Critiqs with dev@acme.com to join Acme. Reply to this email to reach Sam Lee.",
      "Didn't expect this? Report it: https://backend.example/developer-emails/report?token=a.b",
    ].join("\n\n"),
  );
});

test("every stack with a Critiqs package gets its own commands, an unknown one critiqs init alone, and one without a package the script tag", () => {
  const cases: [StackId | null, string, string[] | null][] = [
    ["react", "Run these in the prototype's folder.", ["npm install critiqs-react", `npx critiqs init ${PROJECT}`]],
    ["vue", "Run these in the prototype's folder.", ["npm install critiqs-vue", `npx critiqs init ${PROJECT}`]],
    ["rails", "Run these in the prototype's folder.", ["bundle add critiqs-rails", `npx critiqs init ${PROJECT}`]],
    ["django", "Run these in the prototype's folder.", ["pip install django-critiqs", `npx critiqs init ${PROJECT}`]],
    [null, "Run this in the prototype's folder. It already has the project ID, finds the framework (React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, Astro, Solid, Rails, Django, or Flask), and adds Critiqs:", [`npx critiqs init ${PROJECT}`]],
    ["laravel", "Laravel has no Critiqs package, so Critiqs goes in with a script tag on every page.", null],
  ];
  for (const [stack, how, commands] of cases) {
    const email = message({ stack });
    expect([stack, email.text.includes(how), email.html.includes(how.replaceAll("'", "&#39;"))]).toEqual([stack, true, true]);
    expect([stack, email.text.includes(`npx critiqs init ${PROJECT}`), email.html.includes(`npx critiqs init ${PROJECT}`)]).toEqual([stack, commands !== null, commands !== null]);
    if (commands !== null) expect([stack, email.text.includes(commands.join("\n")), email.html.includes(commands.join("\n"))]).toEqual([stack, true, true]);
    else expect([stack, email.text.includes(`${SCRIPT_TAG_GUIDE}\nProject ID: ${PROJECT}`), email.html.includes(`href="${SCRIPT_TAG_GUIDE}"`)]).toEqual([stack, true, true]);
    expect([stack, /coming|can't be added|npx critiqs-react/.test(email.text)]).toEqual([stack, false]);
  }
  expect(message({ stack: null }).text).toContain("Built with: Not confirmed");
});

test("the setup email says who asked and why, and joining only when the developer is invited", () => {
  const plain = message({ someoneElseChangesCode: false, joining: null });
  expect(plain.text).toContain("is setting up Critiqs so your team can comment right on the prototype. They asked us to send you the setup steps.");
  expect(plain.text).toContain("You don't need anyone's approval. Reply to this email to reach Sam Lee.");
  expect(plain.html).not.toContain("to join");
});

test("names the sender controls are on one line, without control characters, shortened, and escaped", () => {
  const long = "N".repeat(MAX_NAME_SHOWN + 20);
  const email = message({ inviterName: `Sam\u0000 <script>alert(1)</script>\r\nBcc: x@evil.test`, projectName: long, joining: "Acme\u001b[2J" });
  expect(email.fromName).toBe("Sam <script>alert(1)</script> Bcc: x@evil.test via Critiqs");
  expect(email.subject).toBe(`Sam <script>alert(1)</script> Bcc: x@evil.test asked you to add Critiqs to ${"N".repeat(MAX_NAME_SHOWN - 1)}…`);
  expect(email.text).toContain("join Acme[2J.");
  expect(email.html).not.toContain("<script>");
  expect(email.html).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  // Even a hostile name can't change the sender's header.
  expect(senderAs("Critiqs <sign-in@example.com>", `Evil" <ceo@bank.test>\r\nBcc: x@y.z`)).toBe('"Evil\\" <ceo@bank.test>Bcc: x@y.z" <sign-in@example.com>');
  expect(senderAs("sign-in@example.com", "Sam Lee via Critiqs")).toBe('"Sam Lee via Critiqs" <sign-in@example.com>');
});

test("names and the inviter's address are text, never links; only the setup and report links are", () => {
  const email = message({ projectName: "Open www.evil.example now", inviterName: "http://evil.example" });
  const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  expect(hrefs).toEqual(["https://critiqs.app/setup/e_1", "https://backend.example/developer-emails/report?token=a.b"]);
  expect(email.html).not.toContain("evil.example");
  expect(email.html).not.toContain("http://evil");
  expect(email.html).toContain("http:<span></span>/<span></span>/<span></span>evil.<span></span>example");
});

test("Resend gets the display name and Reply-To only for emails that set them", async () => {
  const bodies: Record<string, unknown>[] = [];
  const mailer = resendMailer({
    apiKey: "re_key",
    from: "Critiqs <sign-in@example.com>",
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ id: "1" });
    }) as unknown as typeof fetch,
  });
  await mailer.send(message());
  await mailer.send(signInCodeMessage({ to: "dana@example.com", code: "012345", site: "proto.example", idempotencyKey: "k" }));
  expect(bodies[0]).toMatchObject({ from: '"Sam Lee via Critiqs" <sign-in@example.com>', reply_to: "sam@acme.com", to: ["dev@acme.com"] });
  expect(Object.keys(bodies[1]!)).toEqual(["from", "to", "subject", "text", "html"]);
  expect(bodies[1]!.from).toBe("Critiqs <sign-in@example.com>");
});

test("a mail service refusal is confirmed; no answer, a server error, or a request in progress is not", async () => {
  const answering = (status: number) =>
    resendMailer({ apiKey: "re_key", from: "x@example.com", fetch: (async () => new Response("no", { status })) as unknown as typeof fetch });
  const confirmed = async (mailer: ReturnType<typeof resendMailer>) => {
    const error = await mailer.send(message()).catch((caught: unknown) => caught);
    return error instanceof MailError ? error.confirmed : "not a MailError";
  };
  expect(await Promise.all([400, 403, 422, 429, 409, 500, 503].map((status) => confirmed(answering(status))))).toEqual([true, true, true, true, false, false, false]);
  const offline = resendMailer({
    apiKey: "re_key",
    from: "x@example.com",
    fetch: (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch,
  });
  expect(await confirmed(offline)).toBe(false);
});

test("a send's status follows from its attempts: failed only when every one was refused, none unanswered", () => {
  const attempts = (...answers: ("accepted" | "refused" | null)[]) => answers.map((answer, at) => ({ at, answer }));
  const cases: [ReturnType<typeof attempts>, ReturnType<typeof sendStatus>][] = [
    [attempts(), "uncertain"],
    [attempts(null), "uncertain"],
    [attempts("refused"), "failed"],
    [attempts("refused", "refused"), "failed"],
    // An unanswered attempt, lost or claimed before a crash, may have gone out.
    [attempts(null, "refused"), "uncertain"],
    [attempts("refused", null), "uncertain"],
    [attempts(null, "accepted"), "sent"],
    [attempts("refused", "accepted"), "sent"],
  ];
  for (const [given, status] of cases) expect([given, sendStatus(given)]).toEqual([given, status]);
});

test("a web address is ://, www., or a domain-like name.tld; versions and ordinary names aren't", () => {
  for (const text of ["https://elsewhere.example.test/hello", "evil.com", "Visit WWW.example", "ftp://x", "Acme.co", "naïve.café", "dana@acme.io"]) {
    expect([text, hasWebAddress(text)]).toEqual([text, true]);
  }
  for (const text of ["Acme v2.0", "Q4 plan", "Version 2.0beta", "e.g. this", "St. Louis", "Acme Inc.", "J.R.R. Tolkien", ".NET dashboard", ""]) {
    expect([text, hasWebAddress(text)]).toEqual([text, false]);
  }
  // Product and file names that end in a code file's ending aren't web addresses; a real domain beside or inside one still is.
  for (const text of ["Next.js prototype", "Vue.js app", "index.html", "Built on Next.js.", "App.tsx and styles.css"]) {
    expect([text, hasWebAddress(text)]).toEqual([text, false]);
  }
  for (const text of ["evil.com", "https://x.test", "Next.js at evil.com", "evil.com.js", "x.test/app.js"]) {
    expect([text, hasWebAddress(text)]).toEqual([text, true]);
  }
  // Endings that are also delegated country domains (.rs Serbia, .md Moldova, .py Paraguay) are web addresses.
  expect(hasWebAddress("Next.js")).toBe(false);
  for (const text of ["evil.rs", "notes.md", "pay.py"]) {
    expect([text, hasWebAddress(text)]).toEqual([text, true]);
  }
  // Linear: a long name with many dots is answered at once.
  const started = performance.now();
  expect(hasWebAddress(`${"a.".repeat(50_000)}1`)).toBe(false);
  expect(performance.now() - started).toBeLessThan(100);
});

test("the website's address: the default when unset, and only an HTTPS one (HTTP on this computer)", () => {
  expect(webBase(undefined, "https://critiqs.app")).toBe("https://critiqs.app");
  expect(webBase("  ", "https://critiqs.app")).toBe("https://critiqs.app");
  expect(webBase(undefined, null)).toBeNull();
  expect(webBase("https://staging.critiqs.app/", null)).toBe("https://staging.critiqs.app");
  expect(webBase("https://example.com/critiqs//", null)).toBe("https://example.com/critiqs");
  expect(webBase("http://localhost:3000", null)).toBe("http://localhost:3000");
  for (const bad of ["http://critiqs.app", "ftp://critiqs.app", "critiqs.app", "https://u:p@critiqs.app", "https://critiqs.app/?x=1", "https://critiqs.app/#a"]) {
    expect([bad, webBase(bad, "https://critiqs.app")]).toEqual([bad, null]);
  }
});

test("a report link's token names its send only when Critiqs signed it", async () => {
  const token = await reportToken("secret", "e_0123");
  expect(await readReportToken("secret", token)).toBe("e_0123");
  expect(await readReportToken("other", token)).toBeNull();
  expect(await readReportToken("secret", token.replace("e_0123", "e_0124"))).toBeNull();
  expect(await readReportToken("secret", `${token}x`)).toBeNull();
  for (const bad of ["", ".", "e_0123", ".abc", "x".repeat(400)]) expect(await readReportToken("secret", bad)).toBeNull();
});

test("the server matches inboxes with core's inboxOf, so the website matches them the same way", () => {
  expect(inboxOf).toBe(coresInboxOf);
});

test("on a team's own backend, the setup email says where to add it, as the setup page does; on Critiqs Cloud it doesn't", () => {
  const cloud = message();
  expect(cloud.text).not.toContain("own Critiqs backend");
  const own = message({ backend: "https://happy-otter-123.convex.cloud" });
  expect(own.text).toContain(
    `npx critiqs init ${PROJECT}\n\nThis project is on your team's own Critiqs backend, not Critiqs Cloud. Add this on the <Critiqs /> component init added, so Critiqs connects there:\n\nbackend="https://happy-otter-123.convex.cloud"\n\nSetup steps:`,
  );
  expect(own.html).toContain("<pre style=\"background:#f4f4f5;padding:12px;border-radius:6px\">backend=&#34;https://happy-otter-123.convex.cloud&#34;</pre>");
  // Each framework's own setting, as its package reads it; a stack with no package gets the script tag's.
  expect(message({ stack: "django", backend: "https://team.example/critiqs" }).text).toContain(
    'Add this to the settings module (settings.py), so Critiqs connects there:\n\nCRITIQS = {"BACKEND": "https://team.example/critiqs"}',
  );
  expect(message({ stack: "wordpress", backend: "https://team.example/critiqs" }).text).toContain('Add this to the script tag, so Critiqs connects there:\n\ndata-backend="https://team.example/critiqs"');
});
