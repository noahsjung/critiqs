/**
 * `critiqs mcp`: an MCP server over standard input and output that offers
 * Critiqs's setup steps to coding agents, and lets them read a project's
 * feedback with its context. It runs the same code as the CLI. Keys are read
 * from the server's environment, never from tool arguments, so they don't pass
 * through the agent's conversation; the sign-in for reading feedback is kept
 * in a file only this computer's user can read, never shown to the agent.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { beginSignIn, listComments, listMockups, postReply, readMockup, readScreenshot, readThread, signInStatus, signOutComputer } from "./agent.mjs";
import { runInit } from "./init.mjs";
import { beginSetup, CLOUD_BACKEND_URL, doctor, doctorReport, openBrowser, readiness, SetupError } from "./setup.mjs";

const INSTRUCTIONS = `Critiqs adds review comments to a running prototype: a React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, Astro, Solid, Ruby on Rails, Django, or Flask app, through that framework's Critiqs package (critiqs-react, critiqs-vue, the critiqs-rails gem, …), which builds on the shared critiqs package.
To set it up, call critiqs_setup_start. It finds the app's framework, adds the Critiqs component or tag where the app renders when the code has none (or name the file with entry), and keeps a project the code already names. Its result names the framework's package when the app doesn't list it yet: install it with the project's package manager.
Where the framework has a public environment variable (such as VITE_CRITIQS_PROJECT_ID), Critiqs reads its project ID from it, and setup sets it in the app's .env file; each deployment sets its own, and copies without one show nothing. In a workspace (monorepo), pass the app's folder as dir; each app gets its own project.
It returns either an address to open on this computer, or, with signIn "remote", an address and a short code the person can approve from any device. Pass them on exactly; then call critiqs_setup_finish until it reports the project.
Critiqs Cloud needs no keys. For the team's own Convex deployment, CONVEX_DEPLOY_KEY must be set in this MCP server's environment; never ask for keys in the conversation.
Call critiqs_doctor afterwards to check the setup. AI is optional; comments work without it.

To read a project's feedback, call critiqs_comments with the project's ID; it returns each thread's whole discussion and the context to find it in the prototype and its code (screen, view state, the element's data-critiqs-id as target.purposeId, record, build, page). Filter by status, author, time, tag, screen, or text. critiqs_thread adds one thread's mentions, reactions, linked tickets, and who last resolved or moved it, and critiqs_screenshot shows what the reviewer saw. After acting on feedback, critiqs_reply posts a reply in its thread as the signed-in person, marked "via coding agent", such as asking someone to check a fix; everyone in the thread is emailed, and mentioned people get a mention email. Write the reply yourself; never claim something you didn't do. Mockups are proposed changes reviewers made with Critiqs AI on frozen copies of a page; to build one for real, call critiqs_mockups to find it, then critiqs_mockup for its changes, each with the original element's markup and data-critiqs-id to find it in the code, and the discussion behind them. The first time on a computer, these say to sign in: call critiqs_sign_in, pass its address and code to the person exactly, then call critiqs_sign_in_finish. A sign-in is sent only to the backends it was approved for; when one says it isn't approved for a backend, ask the person whether they trust that backend before signing in for it. The sign-in is kept on this computer for later sessions.`;

const backendProperty = { type: "string", description: "The Critiqs backend's URL, when the project isn't on Critiqs Cloud (the default)." };
const threadProperty = { type: "string", description: "The thread's ID, or a Critiqs link to it or one of its messages (a URL with ?critiqs=…)." };

const dirProperty = { type: "string", description: "The app's folder, relative to the project root. Default: the project root. In a workspace, name one app's folder." };
const envFileProperty = { type: "string", description: "The .env file setup writes or doctor checks, relative to dir, when the app reads its project ID from the environment. Default: the framework's, such as .env.local." };

export const TOOLS = [
  {
    name: "critiqs_setup_start",
    description:
      "Starts setting up Critiqs for the prototype: finds the app's framework, checks the code can take Critiqs (adding the Critiqs component or tag where the app renders when there is none), keeps a project the code already names, deploys to the team's own Convex when asked, and starts sign-in. Returns the address (and, for remote approval, the code) for the person.",
    inputSchema: {
      type: "object",
      properties: {
        dir: dirProperty,
        target: {
          type: "string",
          description: 'Where feedback lives: "cloud" (Critiqs Cloud, the default), "own-convex" (deploy to the team\'s Convex; needs CONVEX_DEPLOY_KEY in this server\'s environment), or the URL of an existing Critiqs backend.',
        },
        name: { type: "string", description: "Project name. Default: the app's package name." },
        reviewUrl: {
          type: "string",
          description: "The prototype's deployed https:// address, where mention emails link. Without it, add it later in the Critiqs sidebar's Project setup.",
        },
        signIn: {
          type: "string",
          enum: ["auto", "browser", "remote"],
          description:
            '"browser" opens sign-in on this computer; "remote" returns an address and a code the person approves from a browser on any device (for remote machines and cloud agents). Default "auto": remote when this computer seems to have no browser.',
        },
        entry: { type: "string", description: "The file where the app renders, relative to dir, when the code has no Critiqs yet." },
        mount: { type: "string", description: "React and Next.js: the element in entry to add Critiqs beside, such as App." },
        newProject: { type: "boolean", description: "Create a new project even if the code or the person's account already has one with this name." },
        envFile: envFileProperty,
      },
    },
  },
  {
    name: "critiqs_setup_finish",
    description:
      "Waits for the person to sign in or approve from critiqs_setup_start, then reuses their project with this name or creates one, and writes its ID (and backend, unless Critiqs Cloud) into the code. Reports each stage: code, project, finishing setup (such as installing the framework's Critiqs package), trying it locally, and reviewers elsewhere. Call again while it reports waiting.",
    inputSchema: {
      type: "object",
      properties: { waitSeconds: { type: "number", description: "How long to wait for sign-in, up to 50 seconds. Default 45." } },
    },
  },
  {
    name: "critiqs_write_project_id",
    description:
      "Connects the prototype's Critiqs to an existing Critiqs project, adding the Critiqs component or tag where the app renders when there is none. Where the framework has a public environment variable, it sets it in the app's .env file; otherwise it writes the ID into the code.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project ID from project setup in the Critiqs sidebar." },
        dir: dirProperty,
        dryRun: { type: "boolean", description: "Show the change without writing it." },
        entry: { type: "string", description: "The file where the app renders, relative to dir, when the code has no Critiqs yet." },
        mount: { type: "string", description: "React and Next.js: the element in entry to add Critiqs beside, such as App." },
        envFile: envFileProperty,
      },
      required: ["projectId"],
    },
  },
  {
    name: "critiqs_doctor",
    description:
      "Checks the prototype's Critiqs setup: Critiqs in the code and its settings, the backend's version, sign-in, the project, its review address, and whether mention emails are going out. Each check says whether it read configuration or something the backend observed; it never sends email or posts a comment.",
    inputSchema: {
      type: "object",
      properties: { dir: dirProperty, envFile: envFileProperty, backend: { type: "string", description: "Check this backend URL instead of the one the code names." } },
    },
  },
  {
    name: "critiqs_comments",
    description:
      "Reads a Critiqs project's feedback: each matching thread with its whole discussion (author, author ID, time, text, links) and the context to find it in the prototype and its code: screen, view state, the target element (purposeId is its data-critiqs-id), record, scope, page address and window size, demo persona, build revision, and where it was moved. Newest activity first. " +
      "Message filters (author, since, until, text) keep a thread when any of its messages matches and mark each message's `matches`. Says to call critiqs_sign_in when this computer isn't signed in.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project's ID, as Project setup in the Critiqs sidebar shows it." },
        status: { type: "string", enum: ["open", "resolved", "all"], description: 'Which threads: "open" (default), "resolved", or "all".' },
        author: { type: "string", description: "Only messages by this person: a display name (any case) or an author ID from an earlier result. A name two people share is refused with their IDs." },
        since: { type: "string", description: "Only messages written at or after this time: a date (2026-10-01), a date and time, or an age such as 7d, 12h, or 2w." },
        until: { type: "string", description: "Only messages written at or before this time; a date alone includes that whole day (UTC)." },
        tag: { type: "string", description: "Only threads with this tag, such as Bug or #wording." },
        screen: { type: "string", description: "Only threads on this screen, such as user-details (where it was left, or where it was moved)." },
        text: { type: "string", description: "Only messages containing this text (any case)." },
        limit: { type: "number", description: "Most threads to return, 1 to 500. Default 50; the result says when more matched." },
        backend: backendProperty,
      },
      required: ["projectId"],
    },
  },
  {
    name: "critiqs_thread",
    description:
      "Reads one Critiqs thread: its whole discussion with each message's mentions and reactions, who last resolved or reopened it and who moved it, and when, its screenshot's state, the tickets linked to it in Linear, GitHub Issues, or Jira (key, title, status, address; where the backend has tickets), and the same context as critiqs_comments. A link to a message marks that message `linked`.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { thread: threadProperty, backend: backendProperty }, required: ["thread"] },
  },
  {
    name: "critiqs_screenshot",
    description:
      "Shows a thread's screenshot: the visible part of the page when the feedback was left, with the commented element outlined on it (or a screenshot the reviewer supplied). Returns the image, the page address and window size, and the marked area in page coordinates. With file, also saves it there.",
    inputSchema: {
      type: "object",
      properties: {
        thread: threadProperty,
        file: { type: "string", description: "Also save the image to this path, relative to the project root. Images over 5 MB can only be saved, so they need a file." },
        backend: backendProperty,
      },
      required: ["thread"],
    },
  },
  {
    name: "critiqs_reply",
    description:
      "Posts a reply in a Critiqs thread as the signed-in person, shown as \"<their name> · via coding agent\", for example to say what changed and ask someone to check it. " +
      "Everyone else in the thread (who started it, replied, or was mentioned) is emailed about it unless they turned that off; people in mention get a mention email instead. Returns the reply's link.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        thread: threadProperty,
        body: { type: "string", description: "The reply, up to 10,000 characters, written for the people in the thread: what changed and what to check. Plain text; #tags work as in the sidebar." },
        mention: {
          type: "array",
          items: { type: "string" },
          description: "People to mention and email: display names of people who have commented in the project, or author IDs from critiqs_thread. Each one's @Name is added to the text if missing.",
        },
        revision: { type: "string", description: "The build the reply refers to, such as a commit or release label." },
        backend: backendProperty,
      },
      required: ["thread", "body"],
    },
  },
  {
    name: "critiqs_mockups",
    description:
      "Lists a Critiqs project's mockups, most recently changed first: proposed changes reviewers made with Critiqs AI on frozen copies of a page, to build for real in the code. " +
      "Each has its ID, title, the page it was made from (address, screen, view state, build revision, demo persona), who made it, when it last changed, how many versions and mockup threads it has, its page copies' IDs and widths, and its mockup threads (ID, status, first message, author, last activity); a mockup's thread's first message says what the change is for. Read one with critiqs_mockup.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project's ID, as Project setup in the Critiqs sidebar shows it." },
        screen: { type: "string", description: "Only mockups made on this screen, such as user-details." },
        text: { type: "string", description: "Only mockups whose title contains this text (any case)." },
        limit: { type: "number", description: "Most mockups to return, 1 to 100. Default 50; the result says when more matched." },
        backend: backendProperty,
      },
      required: ["projectId"],
    },
  },
  {
    name: "critiqs_mockup",
    description:
      "Reads one Critiqs mockup to build it for real in the code. Returns the page it was made from; its page copies (frozen HTML of the page at one window width each); one version (the latest by default) with its summary, author (Critiqs AI, for the person who asked, or a person), and, per copy, every change from the original copy in order: CSS rules, text, attributes, and inserted, replaced, or removed elements. " +
      "A change names an element by its data-critiqs-node number in the copy; `original` is that element's start tag as the copy has it (without that number), its text, and the nearest data-critiqs-id on or around it, to find the component in the code. `original` is null with `addedByChange` when an earlier change in the list added the element. " +
      "Also returns the version history, the mockup's threads with their whole discussions (Critiqs AI's replies are marked, with the version each made; `pin` is the element a thread is on), and the existing feedback threads it answers, which critiqs_thread reads in full. With saveCopies, it also writes each copy's original HTML and the version's changes to files.",
    inputSchema: {
      type: "object",
      properties: {
        mockup: { type: "string", description: "The mockup's ID, from critiqs_mockups." },
        version: { type: "number", description: "Which version's changes to return: a number from the version history, or 0 for the original copies. Default: the latest." },
        saveCopies: {
          type: "string",
          description: "A folder, relative to the project root, to write each copy's original HTML (<folder>/<mockupId>/<copyId>.html) and the version's changes (edits-v<N>.json) into. Nothing is written outside it. Default: nothing is written.",
        },
        backend: backendProperty,
      },
      required: ["mockup"],
    },
  },
  {
    name: "critiqs_sign_in",
    description:
      "Signs this computer in to Critiqs for one backend so agents here can read its feedback, in this and later sessions. The sign-in is sent only to backends it was approved for; the approval page names the backend. Returns an address, and for remote approval a short code, for the person; then call critiqs_sign_in_finish. Access lasts until critiqs_sign_out, 30 days without use, or 90 days.",
    inputSchema: {
      type: "object",
      properties: {
        signIn: {
          type: "string",
          enum: ["auto", "browser", "remote"],
          description:
            'Either way the person approves with a short code on a page that says this computer stays signed in. "browser" also opens that page on this computer; "remote" only returns the address and code, for any device. Default "auto": browser when this computer has a desktop.',
        },
        force: { type: "boolean", description: "Sign in again even if this computer is already signed in." },
        backend: backendProperty,
      },
    },
  },
  {
    name: "critiqs_sign_in_finish",
    description: "Waits for the person to approve or sign in from critiqs_sign_in, then keeps the sign-in on this computer. Call again while it reports waiting.",
    inputSchema: {
      type: "object",
      properties: { waitSeconds: { type: "number", description: "How long to wait, up to 50 seconds. Default 45." } },
    },
  },
  {
    name: "critiqs_sign_out",
    description: "Ends this computer's Critiqs sign-in for reading feedback, with the sign-in service and on this computer.",
    inputSchema: { type: "object", properties: { backend: backendProperty } },
  },
];

/** Handles tool calls; holds the setup waiting for sign-in, if any. */
const lines = (checks) => checks.map((item) => `${item.status.toUpperCase()} ${item.name}: ${item.detail}`).join("\n");

export function createTools({ cwd = process.cwd(), env = process.env, open = openBrowser, fetchFn = fetch, sleep, now = Date.now } = {}) {
  /** The setup waiting for sign-in. Starting another replaces it. */
  let pending = null;
  /** The sign-in for reading feedback that is waiting for the person. */
  let signingIn = null;
  /** Changes whenever a sign-in starts or the computer signs out, so a sign-in still starting knows it was replaced. */
  let signInTurn = 0;
  /** Starts run one at a time, so two can't both become the pending setup. */
  let starting = Promise.resolve();
  let closed = false;
  const text = (message, isError = false) => ({ content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) });
  const rootOf = (dir) => resolve(cwd, typeof dir === "string" && dir !== "" ? dir : ".");

  function start(args) {
    const run = starting.then(() => startNow(args));
    starting = run.catch(() => {});
    return run;
  }

  async function startNow(args) {
    if (closed) return text("The Critiqs MCP server is shutting down.", true);
    pending?.setup.cancel();
    pending = null;
    const target = typeof args.target === "string" && args.target !== "" ? args.target : "cloud";
    if (target === "own-convex" && !env.CONVEX_DEPLOY_KEY && !env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
      return text(
        "Deploying to the team's own Convex needs CONVEX_DEPLOY_KEY (a production deploy key from the Convex project's settings) in this MCP server's environment. Ask the person to add it to the server's configuration, then try again. Don't ask for the key in the conversation.",
        true,
      );
    }
    const string = (value) => (typeof value === "string" && value !== "" ? value : undefined);
    const setup = await beginSetup({
      root: rootOf(args.dir),
      cwd,
      target: string(args.target) ?? null,
      name: string(args.name),
      reviewUrl: string(args.reviewUrl),
      env,
      fetchFn,
      entry: string(args.entry) ?? null,
      mount: string(args.mount) ?? null,
      newProject: args.newProject === true,
      signIn: ["browser", "remote"].includes(args.signIn) ? args.signIn : "auto",
      envFile: string(args.envFile) ?? null,
      ...(sleep ? { sleep } : {}),
    });
    if (setup.connected) {
      const report = doctorReport(await doctor({ root: rootOf(args.dir), cwd, fetchFn, env, envFile: string(args.envFile) ?? null }));
      return {
        ...text(
          `The code already uses Critiqs project ${setup.connected.projectId}${setup.connected.env ? ` (${setup.connected.env.name} in ${setup.connected.env.file ?? "this shell's environment"})` : ""}, so nothing was created. Its checks:\n${lines(report.checks)}\n` +
            "Call again with newProject: true only if the person wants a different project.",
          !report.ok,
        ),
        structuredContent: { connected: setup.connected, ...report },
      };
    }
    const finished = setup.finish();
    finished.catch(() => {});
    pending = { setup, finished };
    const where = setup.backendUrl === CLOUD_BACKEND_URL ? "Critiqs Cloud" : setup.backendUrl;
    if (setup.method === "remote") {
      return text(
        `Ask the person to open ${setup.url} in a browser on any device, enter the code ${setup.userCode}, sign in, and choose Approve. ` +
          `The code works for 10 minutes. Then call critiqs_setup_finish. Feedback will live on ${where}.`,
      );
    }
    open(setup.url);
    return text(
      `Ask the person to open ${setup.url} on this computer and sign in to Critiqs (it may already be open in their browser). ` +
        `If they aren't at this computer, start again with signIn "remote". Then call critiqs_setup_finish. Feedback will live on ${where}.`,
    );
  }

  async function finish(args) {
    await starting;
    const current = pending;
    if (current === null) return text("No setup is waiting. Call critiqs_setup_start first.", true);
    const seconds = Math.min(Math.max(Number(args.waitSeconds) || 45, 1), 50);
    let timer;
    const outcome = await Promise.race([
      current.finished.then((result) => ({ result }), (error) => ({ error })),
      new Promise((done) => (timer = setTimeout(() => done({ waiting: true }), seconds * 1000))),
    ]);
    clearTimeout(timer);
    if (outcome.waiting) {
      return text(
        current.setup.method === "remote"
          ? `Still waiting for approval at ${current.setup.url} with the code ${current.setup.userCode}. Call critiqs_setup_finish again.`
          : `Still waiting for the person to sign in at ${current.setup.url}. Call critiqs_setup_finish again.`,
      );
    }
    // Only the setup this call waited on is done; a newer one may have replaced it.
    if (pending === current) pending = null;
    if (outcome.error) throw outcome.error;
    const { result } = outcome;
    const stages = readiness(result);
    return {
      ...text(
        `${result.reused ? "Reused" : "Created"} the Critiqs project "${result.projectName}" (${result.projectId}).\n${lines(stages)}` +
          (result.written.ok
            ? result.written.env
              ? result.written.env.file === null
                ? `\nCommit the code change: each deployment sets ${result.written.env.name} in its own environment.`
                : `\nCommit the code change, but not ${result.written.env.file}: each deployment sets ${result.written.env.name} itself.`
              : "\nCommit the change so every copy of the prototype shares this project's feedback."
            : ""),
        !result.written.ok,
      ),
      structuredContent: {
        ok: result.written.ok,
        projectId: result.projectId,
        projectName: result.projectName,
        backendUrl: result.backendUrl,
        reused: result.reused,
        env: result.written.env ? { name: result.written.env.name, file: result.written.env.file } : null,
        stages,
      },
    };
  }

  function writeProjectId(args) {
    const output = [];
    const optional = (flag, value) => (typeof value === "string" && value !== "" ? [flag, value] : []);
    const code = runInit(
      [
        "init",
        String(args.projectId ?? ""),
        "--dir",
        rootOf(args.dir),
        ...optional("--entry", args.entry),
        ...optional("--mount", args.mount),
        ...optional("--project-env-file", args.envFile),
        ...(args.dryRun ? ["--dry-run"] : []),
      ],
      {
        cwd,
        print: (line) => output.push(line),
        env,
      },
    );
    return text(output.join("\n"), code !== 0);
  }

  async function check(args) {
    const report = doctorReport(
      await doctor({ root: rootOf(args.dir), cwd, fetchFn, env, envFile: typeof args.envFile === "string" && args.envFile !== "" ? args.envFile : null, backendUrl: typeof args.backend === "string" && args.backend !== "" ? args.backend : undefined }),
    );
    return { ...text(`${lines(report.checks)}\n${report.note}`, !report.ok), structuredContent: report };
  }

  const string = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  const services = { env, fetchFn, now };
  const day = (time) => new Date(time).toISOString().slice(0, 10);
  const json = (summary, value) => ({ content: [{ type: "text", text: summary }, { type: "text", text: JSON.stringify(value) }], structuredContent: value });

  async function comments(args) {
    const result = await listComments({ ...args, backend: string(args.backend) }, services);
    const shown = result.truncated ? `${result.returned} of ${result.total}` : `${result.total}`;
    return json(`${shown} thread${result.total === 1 ? "" : "s"} in "${result.project.name}" match (${result.filters.status}).`, result);
  }

  async function thread(args) {
    const result = await readThread({ thread: args.thread, backend: string(args.backend) }, services);
    return json(`Thread ${result.thread.id} in "${result.project.name}": ${result.thread.status}, ${result.thread.messageCount} message${result.thread.messageCount === 1 ? "" : "s"}.`, result);
  }

  async function screenshot(args) {
    const { image, ...about } = await readScreenshot({ thread: args.thread, file: string(args.file), backend: string(args.backend) }, { ...services, cwd });
    const where = about.file === null ? "" : ` Saved to ${about.file}.`;
    const content = [
      {
        type: "text",
        text:
          `Screenshot of thread ${about.threadId} (${about.kind}): the visible part of ${about.page ?? "the page"} at ${about.viewport ? `${about.viewport.width}×${about.viewport.height}` : "an unknown size"}, with the commented element outlined.${where}` +
          (image === null ? " It is too large to show here; open the saved file." : ""),
      },
      { type: "text", text: JSON.stringify(about) },
    ];
    if (image !== null) content.push({ type: "image", data: image, mimeType: about.mimeType });
    return { content, structuredContent: about };
  }

  async function mockups(args) {
    const result = await listMockups({ ...args, backend: string(args.backend) }, services);
    const shown = result.truncated ? `${result.returned} of ${result.total}` : `${result.total}`;
    const filters = [result.filters.screen && `screen ${result.filters.screen}`, result.filters.text && `"${result.filters.text}" in the title`].filter(Boolean);
    return json(`${shown} mockup${result.total === 1 ? "" : "s"} in "${result.project.name}"${filters.length === 0 ? "" : ` match (${filters.join(", ")})`}.`, result);
  }

  async function mockup(args) {
    const result = await readMockup({ mockup: args.mockup, version: args.version, saveCopies: string(args.saveCopies), backend: string(args.backend) }, { ...services, cwd });
    const { version, copies, threads, linkedThreads, saved } = result;
    const changes = copies.reduce((sum, copy) => sum + copy.edits.length, 0);
    const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
    const which =
      version.number === 0
        ? "the original page copies"
        : `version ${version.number}${version.latest ? " (latest)" : ` of ${result.mockup.versionCount}`} by ${version.byAi ? `Critiqs AI for ${version.askedBy}` : version.author}: ${plural(changes, "change")} across ${plural(copies.length, "page copy", "page copies")}`;
    return json(
      `Mockup "${result.mockup.title}" in "${result.project.name}", ${which}; ${plural(threads.length, "mockup thread")}, ${plural(linkedThreads.length, "linked thread")}.` +
        (saved === null ? "" : ` Saved the copies and changes to ${saved.folder}.`),
      result,
    );
  }

  async function replyTool(args) {
    const result = await postReply(
      { thread: args.thread, body: args.body, mention: args.mention, revision: string(args.revision), backend: string(args.backend) },
      services,
    );
    const who = result.mentioned.length === 0 ? "" : ` mentioning ${result.mentioned.map((person) => person.name).join(", ")}`;
    return json(`Replied in thread ${result.threadId} of "${result.project.name}"${who}.${result.link ? ` ${result.link}` : ""}`, result);
  }

  async function signIn(args) {
    signingIn?.pending.cancel();
    signingIn = null;
    const turn = ++signInTurn;
    const backendUrl = string(args.backend);
    const status = await signInStatus({ backendUrl, env, fetchFn });
    if (status.saved !== null && status.approved && args.force !== true) {
      const who = status.saved.reviewer?.name ?? "someone";
      return text(`This computer is already signed in to Critiqs as ${who}${status.saved.reviewer?.email ? ` (${status.saved.reviewer.email})` : ""} for ${new URL(status.backendUrl).origin}. Call with force: true to sign in again.`);
    }
    const pendingSignIn = await beginSignIn({ backendUrl, method: ["browser", "remote"].includes(args.signIn) ? args.signIn : "auto", env, fetchFn, now, ...(sleep ? { sleep } : {}) });
    if (turn !== signInTurn) {
      // Signed out, or another sign-in started, while this one was starting.
      pendingSignIn.cancel();
      return text("This sign-in was cancelled before it started: the computer signed out or another sign-in began.", true);
    }
    const finished = pendingSignIn.finish();
    finished.catch(() => {});
    signingIn = { pending: pendingSignIn, finished };
    if (pendingSignIn.method === "remote") {
      return text(
        `Ask the person to open ${pendingSignIn.url} in a browser on any device, enter the code ${pendingSignIn.userCode}, sign in, and choose Approve. ` +
          "The code works for 10 minutes. Then call critiqs_sign_in_finish.",
      );
    }
    open(pendingSignIn.url);
    return text(
      `Ask the person to enter the code ${pendingSignIn.userCode} at ${pendingSignIn.url} (it may already be open in their browser; any device works), sign in, and choose Approve. ` +
        "The code works for 10 minutes. Then call critiqs_sign_in_finish.",
    );
  }

  async function signInFinish(args) {
    const current = signingIn;
    if (current === null) return text("No sign-in is waiting. Call critiqs_sign_in first.", true);
    const seconds = Math.min(Math.max(Number(args.waitSeconds) || 45, 1), 50);
    let timer;
    const outcome = await Promise.race([
      current.finished.then((result) => ({ result }), (error) => ({ error })),
      new Promise((done) => (timer = setTimeout(() => done({ waiting: true }), seconds * 1000))),
    ]);
    clearTimeout(timer);
    if (outcome.waiting) {
      return text(`Still waiting for approval at ${current.pending.url} with the code ${current.pending.userCode}. Call critiqs_sign_in_finish again.`);
    }
    if (signingIn === current) signingIn = null;
    if (outcome.error) throw outcome.error;
    const { reviewer, endsAt, backendUrl } = outcome.result;
    return text(
      `Signed this computer in to Critiqs as ${reviewer?.name ?? "the person"}${reviewer?.email ? ` (${reviewer.email})` : ""} for ${new URL(backendUrl).origin}. ` +
        `Agents here can now use critiqs_comments, critiqs_thread, critiqs_screenshot, critiqs_mockups, and critiqs_mockup. It lasts until critiqs_sign_out, 30 days without use${endsAt ? `, or ${day(endsAt)}` : ", or 90 days"}.`,
    );
  }

  async function signOutTool(args) {
    // A sign-in still starting or waiting for approval would otherwise sign the computer back in.
    signInTurn++;
    signingIn?.pending.cancel();
    signingIn = null;
    const result = await signOutComputer({ backendUrl: string(args.backend), env, fetchFn });
    if (result === null) return text("This computer wasn't signed in to Critiqs.");
    const who = result.reviewer?.name ? ` (${result.reviewer.name})` : "";
    return text(
      result.found
        ? `Signed this computer out of Critiqs${who}.`
        : `Forgot this computer's Critiqs sign-in${who}. The service had no session for it: it had already ended, or an interrupted renewal replaced it, and that one ends after 30 days without use.`,
    );
  }

  const handlers = {
    critiqs_setup_start: start,
    critiqs_setup_finish: finish,
    critiqs_write_project_id: writeProjectId,
    critiqs_doctor: check,
    critiqs_comments: comments,
    critiqs_thread: thread,
    critiqs_screenshot: screenshot,
    critiqs_mockups: mockups,
    critiqs_mockup: mockup,
    critiqs_reply: replyTool,
    critiqs_sign_in: signIn,
    critiqs_sign_in_finish: signInFinish,
    critiqs_sign_out: signOutTool,
  };
  return {
    call: async (name, args = {}) => {
      const handler = handlers[name];
      if (handler === undefined) return text(`Unknown tool ${name}.`, true);
      try {
        return await handler(args);
      } catch (error) {
        if (error instanceof SetupError) return text(error.message, true);
        throw error;
      }
    },
    close: () => {
      closed = true;
      pending?.setup.cancel();
      signingIn?.pending.cancel();
      // A start still in progress becomes pending and is cancelled once it settles.
      void starting.then(() => pending?.setup.cancel());
    },
  };
}

/** Answers one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(message, tools, version) {
  if (typeof message !== "object" || message === null || Array.isArray(message) || typeof message.method !== "string") {
    const id = typeof message?.id === "string" || typeof message?.id === "number" ? message.id : null;
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request." } };
  }
  const { id, method, params } = message;
  const reply = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
  const error = (code, text) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "critiqs", version },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        return reply(await tools.call(params?.name, params?.arguments ?? {}));
      } catch (failure) {
        const failed = String(params?.name ?? "").startsWith("critiqs_setup") ? "Setup failed" : "Failed";
        return reply({ content: [{ type: "text", text: `${failed}: ${failure?.message ?? failure}` }], isError: true });
      }
    default:
      return method?.startsWith("notifications/") ? null : error(-32601, `Unknown method ${method}.`);
  }
}

/** Serves MCP over standard input and output until input ends. */
export async function serveMcp({ cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  const { readFileSync } = await import("node:fs");
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const tools = createTools({ cwd });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const send = (response) => output.write(`${JSON.stringify(response)}\n`);
  const inFlight = new Set();
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
      continue;
    }
    // Calls run concurrently, so a long wait for sign-in doesn't block pings.
    const work = handleMessage(message, tools, version).then((response) => response !== null && send(response));
    inFlight.add(work);
    work.finally(() => inFlight.delete(work));
  }
  await Promise.allSettled(inFlight);
  tools.close();
}
