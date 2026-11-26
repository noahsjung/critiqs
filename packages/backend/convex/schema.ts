import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  anchorValidator,
  billingPricesValidator,
  captureValidator,
  locationValidator,
  mockupEditValidator,
  mockupSourceValidator,
  profileValidator,
  revisionValidator,
  threadMockupValidator,
} from "./lib/validators";

/** The fields every AI connection has, a project's or a person's. */
const aiConnectionFields = {
  enabled: v.boolean(),
  mode: v.union(v.literal("managed"), v.literal("own")),
  /** The Critiqs AI model's id; absent means the deployment's first model. */
  managedModel: v.optional(v.string()),
  provider: v.optional(
    v.union(v.literal("openai"), v.literal("anthropic"), v.literal("google"), v.literal("openrouter"), v.literal("gateway"), v.literal("compatible")),
  ),
  model: v.optional(v.string()),
  /** The own key's models a request may name; absent means only `model`. */
  models: v.optional(v.array(v.string())),
  baseUrl: v.optional(v.string()),
  secret: v.optional(v.object({ ciphertext: v.string(), iv: v.string(), hint: v.string() })),
  epoch: v.number(),
  updatedAt: v.number(),
  lastTest: v.optional(v.object({ ok: v.boolean(), at: v.number(), message: v.string() })),
};

export default defineSchema({
  /** Reviewers, keyed by the sign-in provider's token identifier. */
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.union(v.string(), v.null()),
    imageUrl: v.union(v.string(), v.null()),
    /** Profile version of the token that last set the name, so an older token cannot revert it. */
    profileVersion: v.optional(v.number()),
    /** Critiqs Cloud plan from before organizations; it applies until their home organization, which copies it, exists. */
    plan: v.optional(v.string()),
    /** Where the person's new projects go, and whose plan covers their own Critiqs AI. */
    homeOrganizationId: v.optional(v.id("organizations")),
  }).index("by_token", ["tokenIdentifier"]),

  /** A group of people that owns projects and the Critiqs Cloud plan covering them. */
  organizations: defineTable({
    name: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    /** Critiqs Cloud plan; absent means the default plan. */
    plan: v.optional(v.string()),
    /** Critiqs AI credits allowed past the plan's: absent means the plan's default, null means no cap. */
    overageCap: v.optional(v.union(v.number(), v.null())),
    /** Extra image storage bought, 100 GB each. */
    extraStorageUnits: v.optional(v.number()),
  }),

  /** That a person belongs to an organization, and as what. */
  memberships: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("member")),
    createdAt: v.number(),
  })
    .index("by_organization_user", ["organizationId", "userId"])
    .index("by_organization_role", ["organizationId", "role"])
    .index("by_user", ["userId"]),

  /** An emailed invitation to join an organization. */
  invites: defineTable({
    organizationId: v.id("organizations"),
    /** Normalized, as sign-in normalizes addresses. */
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
    invitedBy: v.id("users"),
    createdAt: v.number(),
    acceptedAt: v.optional(v.number()),
  })
    .index("by_organization_email", ["organizationId", "email"])
    .index("by_email", ["email"])
    .index("by_organization_pending", ["organizationId", "acceptedAt"])
    .index("by_email_pending", ["email", "acceptedAt"]),

  /** A Critiqs project: the shared feedback space for one prototype. */
  projects: defineTable({
    name: v.string(),
    tags: v.array(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    /** The prototype address mention emails link to. */
    reviewUrl: v.optional(v.string()),
    /** The organization that owns it; absent on projects from before organizations until `organizations:backfill`. */
    organizationId: v.optional(v.id("organizations")),
  })
    .index("by_creator", ["createdBy"])
    .index("by_organization", ["organizationId"]),

  /**
   * Critiqs Cloud plans configured on this deployment, replacing the built-in
   * plan of the same name. Set with `npx convex run plans:set`.
   */
  plans: defineTable({
    name: v.string(),
    label: v.string(),
    limits: v.array(
      v.object({
        metric: v.union(
          v.literal("projects"),
          v.literal("threads"),
          v.literal("messages"),
          v.literal("reviewers"),
          v.literal("captureBytes"),
          v.literal("mentionEmails"),
          v.literal("aiRequests"),
          v.literal("personalAiRequests"),
          v.literal("aiCredits"),
        ),
        period: v.union(v.literal("total"), v.literal("month"), v.literal("day")),
        max: v.number(),
        overage: v.optional(v.object({ defaultCap: v.number() })),
        addOn: v.optional(v.object({ size: v.number() })),
      }),
    ),
  }).index("by_name", ["name"]),

  /** Usage counters for Critiqs Cloud plans, one per metric, account or project, and period. */
  usage: defineTable({ key: v.string(), count: v.number() }).index("by_key", ["key"]),
  /** Who already counted toward a counter that counts people once, such as reviewers per month. */
  usageMembers: defineTable({ key: v.string(), member: v.string() }).index("by_key_member", ["key", "member"]),

  /** R2 bytes stay private; only their location and upload lifecycle live in Convex. */
  captureFiles: defineTable({
    projectId: v.id("projects"),
    uploadedBy: v.id("users"),
    accountId: v.string(),
    bucket: v.string(),
    key: v.string(),
    status: v.union(v.literal("reserved"), v.literal("uploading"), v.literal("ready"), v.literal("attached"), v.literal("deleting")),
    contentType: v.optional(v.string()),
    size: v.optional(v.number()),
    createdAt: v.number(),
    cleanupAt: v.optional(v.number()),
  }).index("by_cleanup", ["cleanupAt"]).index("by_uploader_status", ["uploadedBy", "status"]),

  threads: defineTable({
    projectId: v.id("projects"),
    status: v.union(v.literal("open"), v.literal("resolved"), v.literal("deleted")),
    anchor: anchorValidator,
    tags: v.array(v.string()),
    capture: captureValidator,
    createdBy: v.id("users"),
    createdAt: v.number(),
    /** Newest message time. Edits, reactions, and status changes leave it unchanged. */
    lastMessageAt: v.number(),
    messageCount: v.number(),
    editCount: v.optional(v.number()),
    statusChangedBy: v.optional(v.id("users")),
    statusChangedAt: v.optional(v.number()),
    /** Replacement target. The anchor keeps the original target and evidence. */
    reattachment: v.optional(
      v.object({ location: locationValidator, reattachedBy: v.id("users"), reattachedAt: v.number() }),
    ),
    /** Hashtags the thread's messages use, with how many messages use each. Absent before the tag backfill. */
    textTags: v.optional(v.array(v.object({ key: v.string(), label: v.string(), count: v.number() }))),
    /** Whether `threadFollowers` lists everyone in the thread; absent on older threads until reply emails read them. */
    followersReady: v.optional(v.boolean()),
    /** Set on a mockup thread, which the thread list, search, and export leave out. */
    mockup: v.optional(threadMockupValidator),
  })
    .index("by_project_status", ["projectId", "status"])
    .index("by_project", ["projectId"])
    .index("by_project_activity", ["projectId", "lastMessageAt"])
    .index("by_capture_storage", ["capture.storageId"])
    .index("by_mockup", ["mockup.mockupId"]),

  messages: defineTable({
    threadId: v.id("threads"),
    authorId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
    editedAt: v.union(v.number(), v.null()),
    revision: revisionValidator,
    /** Reviewers the message mentions, with the name as written in the text. */
    mentions: v.optional(v.array(v.object({ userId: v.id("users"), label: v.string() }))),
    /** The thread's project, for search; absent until the tag backfill reaches older messages. */
    projectId: v.optional(v.id("projects")),
    /** Unique hashtags the text uses, as first written; absent until the tag backfill. */
    hashtags: v.optional(v.array(v.string())),
    /** Written for its author by a coding agent, or by Critiqs AI in a mockup thread. */
    via: v.optional(v.union(v.literal("agent"), v.literal("ai"))),
    /** The mockup version Critiqs AI saved with this message. */
    mockupVersion: v.optional(v.number()),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["projectId"] }),

  /**
   * Proposed changes to a frozen copy of a page (see Mockup mode in
   * docs/technical-direction.md). `headVersion` is the latest version's
   * number; 0 means only the original copies.
   */
  mockups: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    source: mockupSourceValidator,
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** `updatedAt` once the mockup's thread exists; absent before, and after the thread is deleted. The Mockup panel lists by it. */
    listedAt: v.optional(v.number()),
    headVersion: v.number(),
    /** Bytes of changes stored across its versions, kept within what one request can read. */
    editBytes: v.number(),
  })
    .index("by_project_updated", ["projectId", "updatedAt"])
    .index("by_project_screen_updated", ["projectId", "source.screen", "updatedAt"])
    .index("by_project_listed", ["projectId", "listedAt"])
    .index("by_project_screen_listed", ["projectId", "source.screen", "listedAt"]),

  /** A mockup's page copy at one width: HTML in Convex file storage, read only through the access-checked route. */
  mockupSnapshots: defineTable({
    mockupId: v.id("mockups"),
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    width: v.number(),
    height: v.number(),
    scrollY: v.number(),
    viewportHeight: v.number(),
    capturedAt: v.number(),
    createdBy: v.id("users"),
    size: v.number(),
  })
    .index("by_mockup", ["mockupId"])
    .index("by_storage", ["storageId"]),

  /** A saved state of a mockup: for each copy, every change from the original copy. */
  mockupVersions: defineTable({
    mockupId: v.id("mockups"),
    number: v.number(),
    createdAt: v.number(),
    authorId: v.id("users"),
    byAi: v.boolean(),
    summary: v.string(),
    threadId: v.optional(v.id("threads")),
    messageId: v.optional(v.id("messages")),
    restoredFrom: v.optional(v.number()),
    edits: v.array(v.object({ snapshotId: v.id("mockupSnapshots"), edits: v.array(mockupEditValidator) })),
  }).index("by_mockup_number", ["mockupId", "number"]),

  /** An existing thread added to a mockup as instructions for it. */
  mockupLinks: defineTable({
    mockupId: v.id("mockups"),
    threadId: v.id("threads"),
    projectId: v.id("projects"),
    linkedBy: v.id("users"),
    linkedAt: v.number(),
  })
    .index("by_mockup", ["mockupId", "threadId"])
    .index("by_thread", ["threadId"]),

  /** Tags used or offered in a project, with their shared groups and automatic grouping state. */
  projectTags: defineTable({
    projectId: v.id("projects"),
    key: v.string(),
    label: v.string(),
    firstUsedAt: v.number(),
    lastUsedAt: v.number(),
    groupIds: v.array(v.id("tagGroups")),
    grouping: v.union(v.literal("pending"), v.literal("ai"), v.literal("starter"), v.literal("human"), v.literal("none")),
    epoch: v.number(),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    claimToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_project_key", ["projectId", "key"])
    .index("by_project_used", ["projectId", "lastUsedAt"])
    .index("by_project_grouping", ["projectId", "grouping", "nextAttemptAt"])
    .index("by_due", ["grouping", "nextAttemptAt"]),

  /** Shared groups of tags in a project. */
  tagGroups: defineTable({
    projectId: v.id("projects"),
    name: v.string(),
    nameKey: v.string(),
    origin: v.union(v.literal("ai"), v.literal("human"), v.literal("starter")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project_name", ["projectId", "nameKey"]),

  /** That a thread has a tag, explicit or written, so search can find threads by tag. */
  threadTags: defineTable({
    projectId: v.id("projects"),
    threadId: v.id("threads"),
    key: v.string(),
  })
    .index("by_thread", ["threadId"])
    .index("by_project_key", ["projectId", "key"]),

  /** A project's AI connection, and whose connection people's requests use. Keys are stored only encrypted (AES-GCM), never returned. */
  aiSettings: defineTable({
    projectId: v.id("projects"),
    ...aiConnectionFields,
    updatedBy: v.string(),
    /** Whose connection requests people start use; absent means `either`. */
    rule: v.optional(v.union(v.literal("project"), v.literal("personal"), v.literal("either"))),
    /** Critiqs AI model ids the project's connection may use; absent means all. */
    allowedModels: v.optional(v.array(v.string())),
  }).index("by_project", ["projectId"]),

  /** A person's own AI connection, one per person. Its key is encrypted bound to the person, never returned. */
  personalAiSettings: defineTable({
    userId: v.id("users"),
    ...aiConnectionFields,
  }).index("by_user", ["userId"]),

  /** Critiqs AI credits held while a request's model answers, per payer's counter scope. */
  creditHolds: defineTable({ scope: v.string(), credits: v.number(), expiresAt: v.number() }).index("by_scope_expiry", ["scope", "expiresAt"]),

  /** Short-window counters for operational limits, such as searches per minute. */
  aiRateLimits: defineTable({ key: v.string(), count: v.number(), expiresAt: v.number() })
    .index("by_key", ["key"])
    .index("by_expiry", ["expiresAt"]),

  /** People who have commented in a project; the people who can be mentioned there. */
  participants: defineTable({
    projectId: v.id("projects"),
    userId: v.id("users"),
    lastActiveAt: v.number(),
  })
    .index("by_project_user", ["projectId", "userId"])
    .index("by_project_activity", ["projectId", "lastActiveAt"]),

  /**
   * One email owed to one reviewer about one thread. Mentions gather into it
   * for a short pause; once a send is attempted its content and key are fixed.
   */
  deliveries: defineTable({
    recipientId: v.id("users"),
    projectId: v.id("projects"),
    threadId: v.id("threads"),
    status: v.union(v.literal("pending"), v.literal("sending"), v.literal("sent"), v.literal("skipped"), v.literal("failed")),
    attempts: v.number(),
    dueAt: v.number(),
    claimToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    message: v.optional(v.object({ to: v.string(), subject: v.string(), text: v.string(), html: v.string() })),
    /** The email as first prepared, stored as a private file, and the address it goes to. */
    payload: v.optional(v.object({ fileId: v.id("_storage"), to: v.string() })),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
  })
    .index("by_status_due", ["status", "dueAt"])
    .index("by_status_lease", ["status", "leaseUntil"])
    .index("by_recipient_thread", ["recipientId", "threadId", "status", "attempts"])
    .index("by_finished", ["finishedAt"]),

  /** An email owed to an organization's admins about its Critiqs AI credits, at most one of each kind per month and plan. */
  planAlerts: defineTable({
    organizationId: v.id("organizations"),
    /** `included`: the plan's credits are used and extra credits are billed; `paused`: no credits are left. */
    kind: v.union(v.literal("included"), v.literal("paused")),
    /** `YYYY-MM` (UTC). */
    month: v.string(),
    /** The plan's name, which keys the alert, and its label for the email. */
    plan: v.string(),
    planLabel: v.string(),
    included: v.number(),
    overage: v.optional(v.object({ cap: v.union(v.number(), v.null()) })),
    projectId: v.optional(v.id("projects")),
    status: v.union(v.literal("pending"), v.literal("sending"), v.literal("sent"), v.literal("skipped"), v.literal("failed")),
    attempts: v.number(),
    dueAt: v.number(),
    claimToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
  })
    .index("by_organization_kind_month_plan", ["organizationId", "kind", "month", "plan"])
    .index("by_status_due", ["status", "dueAt"])
    .index("by_status_lease", ["status", "leaseUntil"]),

  /**
   * An organization's Autumn customer (same ID), on deployments that take
   * payment: its subscription as last read from Autumn.
   */
  billingAccounts: defineTable({
    organizationId: v.id("organizations"),
    /** Absent until the customer is first read after it was created. */
    state: v.optional(
      v.object({
        plan: v.union(v.literal("free"), v.literal("plus"), v.literal("pro")),
        pastDue: v.boolean(),
        currentPeriodEnd: v.union(v.number(), v.null()),
        cancelAtPeriodEnd: v.boolean(),
        scheduledPlan: v.union(v.literal("free"), v.literal("plus"), v.literal("pro"), v.null()),
        storageUnits: v.number(),
        storageRenewing: v.number(),
        storageEnding: v.optional(v.array(v.union(v.number(), v.null()))),
      }),
    ),
    /** When the state was read from Autumn; an older read never replaces a newer one. */
    readAt: v.optional(v.number()),
    /** A billing change is in progress until then; another is refused meanwhile. */
    busyUntil: v.optional(v.number()),
    /**
     * Autumn subscription IDs of the storage add-ons set to end because Pro
     * is: keeping Pro keeps them. Only while Pro is set to end; one is
     * forgotten each time the admin removes storage meanwhile.
     */
    storageEndingWithPlan: v.optional(v.array(v.string())),
  }).index("by_organization", ["organizationId"]),

  /**
   * Critiqs Cloud's prices as last read from Autumn's catalog, to show; one
   * row. Autumn owns prices: the daily check reads them again, and the page
   * asks for a read while none has succeeded.
   */
  billingPrices: defineTable({
    /** Absent until a read succeeds. */
    prices: v.optional(billingPricesValidator),
    readAt: v.optional(v.number()),
    /** When the page last asked for a read; it asks at most once a minute. */
    askedAt: v.optional(v.number()),
  }),

  /**
   * Critiqs AI credits a paying organization used, waiting to be reported to
   * Autumn. Written in the same transaction as the charge; each is sent with
   * its own `Idempotency-Key`, so Autumn records it once however often it is sent.
   */
  billingUsage: defineTable({
    organizationId: v.id("organizations"),
    credits: v.number(),
    createdAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("sending"), v.literal("sent"), v.literal("failed")),
    attempts: v.number(),
    dueAt: v.number(),
    claimToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
  })
    .index("by_status_due", ["status", "dueAt"])
    .index("by_status_lease", ["status", "leaseUntil"])
    .index("by_status_finished", ["status", "finishedAt"]),

  /** The mentions a delivery reports. */
  notifications: defineTable({
    deliveryId: v.id("deliveries"),
    recipientId: v.id("users"),
    messageId: v.id("messages"),
    authorId: v.id("users"),
    createdAt: v.number(),
    /** A mention (absent, from before reply emails, means one) or a reply in a thread the recipient is in. */
    kind: v.optional(v.union(v.literal("mention"), v.literal("reply"))),
  }).index("by_delivery", ["deliveryId"]),

  /** People in a thread (started it, replied, or were mentioned), who get its reply emails. */
  threadFollowers: defineTable({
    threadId: v.id("threads"),
    userId: v.id("users"),
    /** The thread's message count once they joined; replies numbered above it are emailed to them. */
    since: v.number(),
  }).index("by_thread_user", ["threadId", "userId"]),

  /** Replies whose emails to everyone in their thread the background worker is still queuing, a page at a time. */
  replyEmailJobs: defineTable({
    projectId: v.id("projects"),
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    authorId: v.id("users"),
    createdAt: v.number(),
    /** The reply's number in its thread. */
    position: v.number(),
    stage: v.union(v.literal("scan"), v.literal("notify")),
    cursor: v.union(v.string(), v.null()),
  }).index("by_created", ["createdAt"]),

  /** A reviewer's email notification choices. */
  preferences: defineTable({
    userId: v.id("users"),
    mentionEmails: v.boolean(),
    /** Emails about replies in threads the reviewer is in; absent means on. */
    replyEmails: v.optional(v.boolean()),
    mutedProjects: v.array(v.id("projects")),
  }).index("by_user", ["userId"]),

  /** Values a deployment generates for itself, such as the key that signs mute and unsubscribe links. */
  settings: defineTable({ key: v.string(), value: v.string() }).index("by_key", ["key"]),

  reactions: defineTable({
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    userId: v.id("users"),
    emoji: v.string(),
  })
    .index("by_thread", ["threadId"])
    .index("by_message_user_emoji", ["messageId", "userId", "emoji"]),

  // Sign-in tables. Only Critiqs's sign-in deployment (the hosted one) uses them.

  /**
   * Reviewers known to the sign-in service. The document ID is the reviewer's
   * permanent Critiqs ID, the token subject every deployment sees; it never
   * changes with the sign-in method or display name.
   */
  reviewers: defineTable({
    /** Verified email address, lowercased. */
    email: v.string(),
    /** The name the reviewer chose to show on their comments. */
    name: v.string(),
    /** Increases with each name change; tokens carry it as `profile_version`. */
    nameVersion: v.number(),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  /** Transactional sign-in start counters; no untrusted IP headers. */
  signInLimits: defineTable({ key: v.string(), count: v.number(), expiresAt: v.number() })
    .index("by_key", ["key"]).index("by_expiry", ["expiresAt"]),

  /** A sign-in popup in progress: which site asked, its email code, and the reviewer once verified. */
  signInAttempts: defineTable({
    key: v.string(),
    origin: v.string(),
    clientState: v.string(),
    /** Hash of the cookie that ties the attempt to the browser that started it. */
    bindingHash: v.string(),
    createdAt: v.number(),
    /** Left over from WorkOS sign-in; attempts expire within the hour, then this can go. */
    codeVerifier: v.optional(v.string()),
    /** The address the latest code went to. */
    email: v.optional(v.string()),
    /** Codes sent so far, and which one is current. */
    codesSent: v.optional(v.number()),
    codeGeneration: v.optional(v.number()),
    /** Keyed digest of the current code, never the code itself. */
    codeDigest: v.optional(v.string()),
    codeExpiresAt: v.optional(v.number()),
    /** Wrong guesses still allowed, across every code this attempt sends. */
    guessesLeft: v.optional(v.number()),
    /** Set once a code matched; a new reviewer then chooses a name. */
    verifiedEmail: v.optional(v.string()),
    profile: v.optional(profileValidator),
    /** Hash of the token the consent page must return. */
    consentHash: v.optional(v.string()),
    /** Set when this sign-in approves setup on another device rather than signing in to a site. */
    device: v.optional(v.id("deviceGrants")),
  })
    .index("by_key", ["key"])
    .index("by_created", ["createdAt"]),

  /**
   * Setup waiting on another device (`critiqs init --remote`): the command
   * line holds a device secret and polls; the person enters a short code in a
   * browser anywhere, signs in, and approves. Both are stored only as hashes.
   */
  deviceGrants: defineTable({
    deviceHash: v.string(),
    userCodeHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    /** Seconds the command line waits between polls. */
    interval: v.number(),
    lastPolledAt: v.optional(v.number()),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
    /** Who approved, once approved. */
    profile: v.optional(profileValidator),
    /**
     * Approval keeps the command line signed in (a session, as a site's),
     * for reading feedback with `critiqs sign-in`; setup gets 15 minutes only.
     */
    keepSignedIn: v.optional(v.boolean()),
  })
    .index("by_device", ["deviceHash"])
    .index("by_user_code", ["userCodeHash"])
    .index("by_expiry", ["expiresAt"]),

  /** Sites a reviewer allowed to use their Critiqs account. */
  siteGrants: defineTable({
    subject: v.string(),
    origin: v.string(),
    grantedAt: v.number(),
  }).index("by_subject_origin", ["subject", "origin"]),

  /** A signed-in component on one site. Refresh tokens are stored only as hashes. */
  sessions: defineTable({
    refreshHash: v.string(),
    origin: v.string(),
    profile: profileValidator,
    createdAt: v.number(),
    /** Ends this long after last use… */
    expiresAt: v.number(),
    /** …but never after this, however often it is used. */
    endsAt: v.optional(v.number()),
  })
    .index("by_refresh_hash", ["refreshHash"])
    .index("by_expiry", ["expiresAt"]),

  /** Personal read state (F5). Never affects other reviewers or thread status. */
  readStates: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    lastReadAt: v.number(),
    manualUnread: v.boolean(),
  }).index("by_user_thread", ["userId", "threadId"]),
});
