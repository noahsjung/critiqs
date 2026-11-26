import { listOr, PACKAGE_STACK_NAMES, type RecommendationReason, type Role, type TeamSize } from "@critiqs/core";

/** "A", "A and B", or "A, B, and C". */
function listAnd(items: readonly string[]): string {
  return items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// Every string the website's app shows. Short, plain, and in the order people
// read it: one heading, at most one line under it, and buttons that say what
// they do. Nothing calls a question optional.

export const copy = {
  appName: "Critiqs",
  loading: "Loading…",
  skip: "Skip",
  continue: "Continue",
  back: "Back",
  copyFailed: "Couldn't copy",
  selectToCopy: "Your browser didn't allow copying. Select the text and copy it.",
  selectBelowToCopy: "Your browser didn't allow copying. Select the text below and copy it.",
  defaultProjectName: "My prototype",
  progress: (step: number, count: number) => `Step ${step} of ${count}`,

  deployment: {
    title: "Critiqs can't start",
  },

  signIn: {
    title: "Sign in to Critiqs",
    button: "Sign in with email",
    waiting: "Finish signing in in the other window.",
    tryAgain: "Try again",
    signedInAs: (email: string) => `Signed in as ${email}.`,
    signOut: "Sign out",
    next: "Next, you'll sign in with your email.",
  },

  address: {
    title: "What should your team review?",
    lead: "Paste the link to your prototype.",
    field: "Prototype link",
    placeholder: "your-app.vercel.app",
    notOnline: "It's not online yet",
    empty: "Paste a link, or choose It's not online yet.",
    invalid: "That doesn't look like a link. Try something like your-app.vercel.app.",
  },

  who: {
    title: "Who will add Critiqs to it?",
    lead: "It's a small change to the prototype's code.",
    me: { label: "I will", detail: "I can edit the code" },
    developer: { label: "My developer will", detail: "Email them the steps" },
    extension: { label: "No one, for now", detail: "Review it in Chrome with the Critiqs extension" },
    recommended: "Recommended",
    /** One sentence under the choices: why the first one is recommended. */
    reason: {
      "install-is-default": "Adding Critiqs to the code is the main way: everyone who opens the prototype can comment, with nothing to install.",
      "can-change-code": "You can change the code, so Critiqs can go right into the prototype.",
      "someone-else-changes-code": "Someone else changes the code, so they can add Critiqs for everyone.",
      "no-code-access": "You can't change the code, so whoever does can add Critiqs for everyone.",
    } satisfies Record<RecommendationReason, string>,
    creating: "Setting up your project…",
    failed: "Your project couldn't be set up. Try again.",
    organization: "Project goes in",
    organizationsFailed: (message: string) => `Your organizations couldn't be loaded, so the project can't be set up yet. ${message}`,
    organizationLost: (name: string | null) => `${name ?? "The organization you chose"} is no longer one of yours. Choose where the project goes.`,
    addressNotSaved: (address: string) => `Critiqs can't save ${address} as the review link, because it isn't HTTPS. You can add a link later.`,
    projectDetail: (organization: string | null, address: string | null, createdAt: number) =>
      [organization, address === null ? `Created ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(createdAt)}` : address.replace(/^https?:\/\//, "").replace(/\/$/, "")]
        .filter((part) => part !== null)
        .join(", "),
    useExisting: "Or use a project you already have",
    useFailed: "That project couldn't be opened. Try again.",
    upgrade: "Upgrade the plan",
  },

  install: {
    title: "Add Critiqs to your prototype",
    lead: "Run this in your prototype's folder.",
    copy: "Copy",
    copied: "Copied",
    copyCommand: "Copy command",
    then: (host: string | null) => (host === null ? "Then open your prototype. You'll see Critiqs at the bottom of the page." : `Then open ${host}. You'll see Critiqs at the bottom of the page.`),
    unknownStack: `It finds your framework (${listOr(PACKAGE_STACK_NAMES)}) and adds Critiqs.`,
    scriptTag: (label: string) => `${label} has no Critiqs package, so add Critiqs with a script tag on every page. The guide shows the tag; give it this project ID.`,
    scriptTagGuide: "How to add the script tag",
    copyProjectId: "Copy project ID",
    projectIdCopied: "Project ID copied",
    agent: "Copy for a coding agent",
    agentCopied: "Instructions copied",
    /** `backend`: for a backend other than Critiqs Cloud, `backendSetting`'s answer and the backend's address. */
    agentPrompt: (command: string, stackLabel: string | null, backend: { address: string; where: string; setting: string } | null) =>
      `Add Critiqs to this ${stackLabel === null ? "" : `${stackLabel} `}app: run \`${command}\` in its folder, and follow the steps it prints.` +
      (backend === null ? "" : ` Then set Critiqs's backend to ${backend.address}: add \`${backend.setting}\` ${backend.where}, so it connects to this project's backend instead of Critiqs Cloud.`),
    /** For a backend other than Critiqs Cloud, which `init <projectId>` and the script tag's guide don't set. `whose` is "your team's" or "our"; `where` completes "add this …". */
    customBackend: (whose: string, where: string) => `This project is on ${whose} own Critiqs backend, not Critiqs Cloud. Add this ${where}, so Critiqs connects there:`,
    copyProperty: "Copy setting",
    propertyCopied: "Setting copied",
  },

  developers: {
    field: (number: number) => (number === 1 ? "Developer's email" : `Developer ${number} email`),
    placeholder: "developer@company.com",
    add: "Add another developer",
    remove: (email: string) => (email.trim() === "" ? "Remove this developer" : `Remove ${email.trim()}`),
    removeShort: "Remove",
    invalid: "Enter a valid email address.",
    duplicate: (email: string) => `You already entered ${email}.`,
    own: "That's your own address. Enter your developer's.",
  },

  send: {
    title: "Send the steps to your developer",
    lead: "We'll email them how to add Critiqs, and say it's from you.",
    sendOne: "Send email",
    sendMany: "Send emails",
    sending: "Sending…",
    copyMessage: "Copy a message to send yourself",
    copyMessageShort: "Copy message",
    messageCopied: "Message copied",
    copyMessageFor: (email: string) => `Copy message for ${email}`,
    noAddresses: "Enter your developer's email address.",
    sent: (email: string) => `Sent to ${email}`,
    sentTitle: (count: number) => (count === 1 ? "Email sent" : "Emails sent"),
    sentNext: "They'll get the steps and a link to set it up. Once it's added, comments show up right on your prototype.",
    alreadySent: (email: string) => `Already sent to ${email}`,
    failed: (email: string) => `Couldn't send to ${email}`,
    sendAgain: "Send again",
    sendAgainTo: (email: string) => `Send again to ${email}`,
    suppressed: (email: string) => `${email} turned off emails from Critiqs. Copy the message instead.`,
    invalid: (email: string, message: string) => `${email}: ${message}`,
    failedRequest: "The emails couldn't be sent. Try again, or copy the message instead.",
    organizationFailed: "Critiqs can't email yet. Copy the message instead, or try again later.",
    /** While the project's organization loads: an admin's send invites the developer to it, and says so before sending. */
    organizationLoading: "Checking your organization before sending…",
    copyMessageInstead: "Copy message instead",
    sendAnother: "Send to another developer",
    invite: {
      before: (organization: string) => `They'll also be invited to ${organization}.`,
      created: (email: string, organization: string) => `${email} is invited to ${organization}.`,
      pending: (email: string, organization: string) => `${email} was already invited to ${organization}.`,
      member: (email: string, organization: string) => `${email} is already in ${organization}.`,
      limit: (email: string, organization: string) => `${organization} can't invite anyone else today, so ${email} wasn't invited.`,
      theOrganization: "your organization",
    },
  },

  connection: {
    waiting: (host: string | null) => `Waiting for Critiqs to load on ${host ?? "your prototype"}…`,
    connected: (origin: string | null) => (origin === null ? "Connected. Critiqs loaded on the prototype." : `Connected. Critiqs loaded on ${origin.replace(/^https?:\/\//, "")}.`),
    when: (at: number) => `Last loaded ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(at)}.`,
    clear: "Clear",
    clearHint: "Not right? Clear it. Critiqs records it again the next time it loads at the project's address.",
    clearFailed: "Couldn't clear it. Try again.",
    setupWaiting: "Once it's added, this page says Connected when Critiqs loads at the prototype's address.",
    /** For the project's owners, once setup steps went to developers. */
    waitingForInstall: (emails: readonly string[], at: number) =>
      `Waiting for install. Sent to ${listAnd(emails)}, ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(at)}.`,
  },

  sends: {
    title: "Setup emails",
    sentAt: (at: number) => `Sent ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(at)}`,
    sending: "Sending…",
    notSent: "Not sent",
    resend: "Send again",
    resendTo: (email: string) => `Send the steps again to ${email}`,
    resendAfter: (at: number) => `Can send again ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(at)}`,
    resent: "Sent again",
    resendFailed: "Couldn't send again. Try again later.",
  },

  invite: {
    heading: "Invite your team",
    lead: (organization: string, host: string | null) =>
      `Invite them to ${organization}, so they can comment on ${host ?? "the prototype"}. They join when they sign in to Critiqs with the address you invite.`,
    field: "Teammate's email",
    placeholder: "teammate@company.com",
    button: "Invite",
    inviting: "Inviting…",
    invalid: "Enter a valid email address.",
    own: "That's your own address.",
    invited: (email: string, organization: string) => `${email} is invited to ${organization}.`,
    emailed: "An email with the invitation is on its way.",
    notEmailed: (email: string) => `This Critiqs deployment can't send email, so tell ${email} to sign in to Critiqs with that address to join.`,
    member: (email: string, organization: string) => `${email} is already in ${organization}.`,
    pending: (email: string, organization: string) => `${email} was already invited to ${organization}.`,
    failed: "The invite wasn't sent. Try again.",
    askAdmin: (organization: string) => `To invite your team, ask an admin of ${organization}.`,
  },

  ways: {
    /** The other ways in, under the one chosen. */
    switchTo: { me: "I'll add it myself", developer: "Someone else will add it", extension: "Review it with the extension instead" },
  },

  extension: {
    title: "Review it with the Critiqs extension",
    lead: (host: string | null) => `Comment right on ${host ?? "your prototype"} in Chrome, Edge, Brave, or Arc. Nothing changes in its code.`,
    getTitle: "Get the extension.",
    get: "It isn't in the Chrome Web Store yet. Until it is, someone on your team can build it from Critiqs's code and load it into Chrome.",
    guide: "How to load the extension",
    ownBackend: "This project is on your team's own Critiqs backend, so build the extension for it, in the Critiqs code's packages/extension folder:",
    openTitle: (host: string | null) => (host === null ? "Open your prototype" : `Open ${host}`),
    open: (email: string | null) => (email === null ? "and click Critiqs in the toolbar, then sign in." : `and click Critiqs in the toolbar, then sign in with ${email}.`),
    listing: "Adding the address so the extension finds this project…",
    found: (projectName: string) => `It finds ${projectName} by its address, and you can comment.`,
    choose: (projectName: string) => `Choose Add to a project, then ${projectName}, and you can comment.`,
  },

  about: {
    heading: "While you're here",
    "team-size": {
      title: "How big is your team?",
      options: {
        "just-me": "Just me",
        "2-5": "2–5",
        "6-20": "6–20",
        "21-100": "21–100",
        "over-100": "100+",
      } satisfies Record<TeamSize, string>,
    },
    role: {
      title: "What do you do?",
      options: {
        designer: "Design",
        "product-manager": "Product",
        engineer: "Engineering",
        founder: "Founder",
        agency: "Agency",
        other: "Something else",
      } satisfies Record<Role, string>,
    },
    thanks: "Thanks, that helps.",
    plan: {
      heading: "Suggested plan",
      fits: (label: string, organization: string) => `${organization}'s ${label} plan fits a team this size.`,
      suggest: (label: string) => `${label} fits a team this size`,
      includes: (reviewers: number | null, projects: number | null) =>
        `${reviewers === null ? "Any number of reviewers" : `Up to ${reviewers} reviewers a month`}, and ${projects === null ? "any number of projects" : projects === 1 ? "1 project" : `${projects} projects`}.`,
      price: (monthly: number) => (monthly === 0 ? "Free." : `US$${monthly} a month.`),
      seePlans: "See plans",
      askAdmin: (organization: string) => `An admin of ${organization} can change its plan.`,
      changeInCritiqs: "Change it in Critiqs's Plan and billing.",
    },
  },

  preview: {
    label: (host: string) => `How ${host} will look with Critiqs`,
    placeholder: "your-prototype.app",
    comments: ["Can this be bigger?", "Love this", "Typo here"],
  },

  setup: {
    title: (projectName: string) => `Add Critiqs to ${projectName}`,
    signInLead: "Sign in with the email address this link was sent to.",
    asked: (inviter: string) => `${inviter} asked you to add Critiqs so your team can comment right on the prototype.`,
    askedNoName: "Your team asked you to add Critiqs so they can comment right on the prototype.",
    project: "Project",
    address: "Prototype",
    notGiven: "Not given",
    builtWith: "Built with",
    notConfirmed: "Not confirmed",
    commandLabel: "Run this in the prototype's folder. It already has the project ID.",
    noApproval: "You don't need anyone's approval.",
    notFoundTitle: "Setup link not found",
    notFound: "This setup link doesn't exist, or it was sent to another address.",
    signOut: "Sign out",
  },

  threadPage: {
    tabTitle: "Comment",
    signInTitle: "Sign in to see this comment",
    signInLead: "Use the email address you use with Critiqs, or the one this link was sent to.",
    unavailableTitle: "This comment isn't available",
    unavailableLead: "It doesn't exist, or this email address can't open it.",
    unavailableOtherEmail: "If you use Critiqs with another email address, sign in with that one.",
    unavailableAsk: "Otherwise, ask whoever shared the link to add you to their team on Critiqs.",
    otherEmail: "Use another email",
    deletedTitle: "This comment was deleted",
    deletedLead: "Its discussion was removed for everyone.",
    failedTitle: "Couldn't load this comment",
    title: (projectName: string) => `Comment on ${projectName}`,
    resolvedTitle: (projectName: string) => `Resolved comment on ${projectName}`,
    resolved: (by: string | null, at: string | null) => `Resolved${by === null ? "" : ` by ${by}`}${at === null ? "" : `, ${at}`}.`,
    screen: "Screen",
    openInPrototype: "Open in prototype",
    opensAt: (address: string) => `Opens ${address}`,
    extensionTitle: "Not installed on the prototype yet",
    extensionMadeWith: "Left with the Critiqs extension",
    extension: "Open the prototype in Chrome and click Critiqs in the toolbar to see this comment there.",
    getExtension: "Get the extension",
    mentionList: "People in this thread",
    noAddress: (page: string) =>
      `This project has no review address, so there's no prototype to open. The comment was left on ${page}.`,
    copyLink: "Copy link",
    linkCopied: "Link copied",
    captureAlt: "The page when the comment was left",
    captureLoading: "Loading the image…",
    captureFailed: "Couldn't load the image.",
    tryAgain: "Try again",
    retrying: "Trying again…",
    noCapture: "No image was saved with this comment.",
    supplied: "Screenshot added after the automatic capture failed.",
    discussion: "Discussion",
    edited: "(edited)",
    viaAgent: "via coding agent",
    replyLabel: "Reply",
    replyPlaceholder: "Reply. Type @ to mention someone in this thread, # to tag.",
    reply: "Reply",
    sending: "Sending…",
    replyRefused: "Your reply wasn't sent. This email address can't reply to this comment.",
    replyFailed: "Your reply wasn't sent. Try again.",
  },
} as const;
