import type { AddressCheck, CodeAccess, FeedbackFrom, Purpose, RecommendationReason, Role, TeamSize } from "@critiqs/core";

// Every string the website's app shows, from the merged onboarding draft
// (to be tested with people), in the design system's writing rules: sentence
// case, nouns for labels, verbs for buttons, and nothing calls a question
// optional.

export const copy = {
  appName: "Critiqs",
  loading: "Loading…",
  skip: "Skip",
  continue: "Continue",
  back: "Back",
  startOver: "Start over",
  copyFailed: "Couldn't copy",
  selectToCopy: "Your browser didn't allow copying. Select the text and copy it.",
  selectBelowToCopy: "Your browser didn't allow copying. Select the text below and copy it.",

  deployment: {
    title: "Critiqs can't start",
  },

  signIn: {
    title: "Sign in to Critiqs",
    lead: "We'll email you a sign-in code.",
    button: "Sign in with email",
    waiting: "Finish signing in in the other window…",
    tryAgain: "Try again",
    signedInAs: (email: string) => `Signed in as ${email}.`,
    useAnother: "Use another email",
  },

  address: {
    title: "What's your prototype's address?",
    lead: "Paste the address you open in your browser. Staging, preview, and local addresses all work.",
    field: "Prototype address",
    placeholder: "https://staging.example.com",
    onlyOnMyComputer: "It's only on my computer",
    noAddressYet: "I don't have one yet",
    check: "Check address",
    checking: (host: string) => `Checking ${host}…`,
    invalid: "Enter the full address, starting with https:// or http://.",
    checkFailed: "The address couldn't be checked. Try again, or skip this step.",
  },

  stack: {
    detected: (label: string) => `Looks like ${label}.`,
    use: (label: string) => `Use ${label}`,
    change: "Change",
    pickerTitle: "What's your prototype built with?",
    pickerLead: "So we can show the right install steps.",
    field: "Framework",
    unsure: "I'm not sure",
    notInstallable: (label: string) => `Critiqs installs in React apps built with Vite or Next.js today. ${label} support is coming.`,
  },

  role: {
    title: "What's your role?",
    lead: "Your role and team size help us suggest a setup and a plan.",
    options: {
      designer: "Designer",
      "product-manager": "Product manager",
      engineer: "Engineer",
      founder: "Founder",
      agency: "Agency or freelancer",
      other: "Other",
    } satisfies Record<Role, string>,
  },

  teamSize: {
    title: "How big is your team?",
    options: {
      "just-me": "Just me",
      "2-5": "2–5 people",
      "6-20": "6–20 people",
      "21-100": "21–100 people",
      "over-100": "More than 100 people",
    } satisfies Record<TeamSize, string>,
  },

  codeAccess: {
    title: "Can you change the prototype's code?",
    lead: "Installing Critiqs takes a small change to the prototype's code.",
    options: {
      self: "Yes",
      teammate: "Someone on my team can",
      nobody: "No",
    } satisfies Record<CodeAccess, string>,
  },

  developers: {
    group: "Developers to email",
    note: "Next, you can email them how to add Critiqs, or copy a message to send yourself.",
    field: (number: number) => `Developer ${number} email`,
    placeholder: "developer@company.com",
    add: "Add another developer",
    remove: (email: string) => (email.trim() === "" ? "Remove this developer" : `Remove ${email.trim()}`),
    removeShort: "Remove",
    atLimit: (max: number) => `Up to ${max} developers per project.`,
    invalid: "Enter a valid email address.",
    duplicate: (email: string) => `You already entered ${email}.`,
    own: "That's your address. Choose Yes to see the install steps.",
  },

  feedbackFrom: {
    title: "Who will leave feedback?",
    lead: "Choose any.",
    options: {
      team: "My team",
      clients: "Clients or stakeholders",
      "test-users": "Test users",
    } satisfies Record<FeedbackFrom, string>,
  },

  purpose: {
    title: "What's it for?",
    lead: "This sets the project's starting tags.",
    options: {
      "design-review": "Design review",
      qa: "QA",
      "user-testing": "User testing",
    } satisfies Record<Purpose, string>,
  },

  create: {
    title: "Create your project",
    lead: "Everyone who reviews this prototype comments in this project.",
    name: "Project name",
    defaultName: "My prototype",
    organization: "Organization",
    button: "Create project",
    creating: "Creating…",
    nameRequired: "Enter a name for the project.",
    failed: "The project couldn't be created. Try again.",
    organizationsFailed: (message: string) => `Your organizations couldn't be loaded, so the project can't be created yet. ${message}`,
    organizationLost: (name: string | null) => `${name ?? "The organization you chose"} is no longer one of your organizations. Choose where to create the project.`,
    addressNotSaved: (address: string) =>
      `${address} won't be saved as the project's review address: Critiqs saves only HTTPS addresses, or HTTP ones on this computer. You can add one later in the project's settings.`,
    /** Under a project's name in the list: its organization, and its review address or when it was created. */
    projectDetail: (organization: string | null, address: string | null, createdAt: number) =>
      [organization, address === null ? `Created ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(createdAt)}` : address.replace(/^https?:\/\//, "").replace(/\/$/, "")]
        .filter((part) => part !== null)
        .join(" · "),
    useExisting: "Use a project you created",
    useFailed: "That project couldn't be opened. Try again.",
    upgrade: "Upgrade the plan",
  },

  recommendation: {
    title: (projectName: string) => `Recommended for ${projectName}`,
    lead: "Every way uses the same project, so comments stay in one place if you switch later.",
    badge: "Recommended",
    others: "Other ways to set up",
    someoneElse: "Someone else changes the code",
    reasons: {
      "can-change-code": "You can add Critiqs to the build your reviewers already open.",
      "someone-else-changes-code": "A developer on your team can add Critiqs in a few minutes.",
      "no-code-access": "Send the setup steps to whoever maintains the prototype.",
      "install-is-default": "Installing puts comments right on the prototype your reviewers open.",
    } satisfies Record<RecommendationReason, string>,
  },

  install: {
    title: "Install in your app",
    commandsLabel: "Run these in the prototype's folder",
    unknownStack: "If your prototype is a React app built with Vite or Next.js, run these in its folder.",
    copyCommand: "Copy command",
    copyCommandOf: (command: string) => `Copy command: ${command}`,
    commandCopied: "Command copied",
    agentLabel: "Or paste this into a coding agent",
    copyPrompt: "Copy prompt",
    promptCopied: "Prompt copied",
    agentPrompt: (commands: readonly string[], stackLabel: string | null, backend: string | null) =>
      `Add Critiqs to this ${stackLabel ?? "React"} app: run \`${commands.join("`, then `")}\` in its folder, and follow the steps they print.` +
      (backend === null ? "" : ` Then add \`backend="${backend}"\` to the <Critiqs /> component init added, so it connects to this project's backend instead of Critiqs Cloud.`),
    /** For a backend other than Critiqs Cloud, which `init <projectId>` doesn't write: the step after the commands. `whose` is "your team's" or "our". */
    customBackend: (whose: string) => `This project is on ${whose} own Critiqs backend, not Critiqs Cloud. Then add this property to the <Critiqs /> component that init adds, so it connects there:`,
    backendProperty: (backend: string) => `backend="${backend}"`,
    copyProperty: "Copy property",
    propertyCopied: "Property copied",
  },

  send: {
    title: "Send to your developer",
    lead: "Email them the setup steps from Critiqs, or copy a message to send yourself.",
    sendOne: "Send setup email",
    sendMany: "Send setup emails",
    sending: "Sending…",
    copyMessage: "Copy message",
    messageCopied: "Message copied",
    copyMessageFor: (email: string) => `Copy message for ${email}`,
    noAddresses: "Add a developer's email address to send the setup steps.",
    sent: (email: string) => `Sent to ${email}.`,
    alreadySent: (email: string) => `Already sent to ${email}.`,
    failed: (email: string) => `Couldn't send to ${email}.`,
    sendAgain: "Send again",
    sendAgainTo: (email: string) => `Send again to ${email}`,
    suppressed: (email: string) => `${email} turned off emails from Critiqs. Copy the message instead.`,
    invalid: (email: string, message: string) => `${email}: ${message}`,
    failedRequest: "The emails couldn't be sent. Try again, or copy the message instead.",
    organizationFailed: "The project's organization couldn't be loaded, so Critiqs can't email yet. Copy the message instead, or try again later.",
    copyMessageInstead: "Copy message instead",
    invite: {
      before: (organization: string) => `They'll also be invited to join ${organization} when they sign in.`,
      created: (email: string, organization: string) => `${email} is invited to join ${organization} when they sign in.`,
      pending: (email: string, organization: string) => `${email} was already invited to ${organization}.`,
      member: (email: string, organization: string) => `${email} is already in ${organization}.`,
      limit: (email: string, organization: string) => `${organization} can't invite anyone else today, so ${email} wasn't invited.`,
      theOrganization: "the organization",
    },
  },

  setup: {
    title: (projectName: string) => `Add Critiqs to ${projectName}`,
    signInLead: "Sign in with the email address this link was sent to.",
    asked: (inviter: string) => `${inviter} asked you to add Critiqs so your team can comment right on the prototype.`,
    askedNoName: "Your team asked you to add Critiqs so they can comment right on the prototype.",
    project: "Project",
    address: "Prototype address",
    notGiven: "Not given",
    builtWith: "Built with",
    notConfirmed: "Not confirmed",
    commandsLabel: "Run these in the prototype's folder. They already have the project ID.",
    noApproval: "You don't need anyone's approval.",
    notFoundTitle: "Setup link not found",
    notFound: "This setup link doesn't exist, or it was sent to another address.",
    signOut: "Sign out",
  },
} as const;

/**
 * Whether a local address is this computer itself: `localhost`, a
 * `.localhost` name, or a loopback address. Every other local address
 * (private ranges, `.local`, `.internal`, `.home.arpa`, `.ts.net`) is on a
 * private network. Core's rule says only that an address is local; which kind
 * is wording, so the app tells them apart from the address.
 */
export function isThisComputer(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** The address check's result line: a heading and its detail, for the address checked; null when the person said where it is instead. */
export function checkResult(check: AddressCheck, url: URL | null): { heading: string; detail: string } {
  const host = url?.host ?? "";
  switch (check.kind) {
    case "public":
      return { heading: `${host} is public`, detail: "Critiqs opened it without signing in." };
    case "sign-in":
      return check.via === "redirect"
        ? { heading: `${host} needs a sign-in`, detail: "It sends visitors to a sign-in page first." }
        : { heading: `${host} asks for a password`, detail: "It's protected by a password." };
    case "blocked":
      return { heading: "Bot protection stopped the check", detail: `${host} returned a bot challenge.` };
    case "unreachable":
      return { heading: `Couldn't reach ${host}`, detail: "It may be offline, or behind a VPN or firewall. You can still continue." };
    case "local":
      if (url !== null && !isThisComputer(url.hostname)) {
        return { heading: `${host} is on a private network`, detail: "Critiqs can't reach private networks. You can still continue." };
      }
      return { heading: host === "" ? "It runs on your computer" : `${host} runs on your computer`, detail: "Only this computer can open it." };
    case "none":
      return { heading: "No address yet", detail: "You can add one later in the project's settings." };
    default: {
      const exhaustive: never = check;
      return exhaustive;
    }
  }
}
