import type { Anchor, CodeAccess, FeedbackFrom, MockupEdit, MockupSource, Purpose, Role, StackId, TargetLocation, TeamSize, TicketStatus, TrackerId } from "@critiqs/core";
import { type Infer, v } from "convex/values";

export const viewStateValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null()),
);

const rectValidator = v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() });

const targetValidator = v.object({
  purposeId: v.union(v.string(), v.null()),
  recordKey: v.union(v.string(), v.null()),
  clues: v.object({
    tagName: v.string(),
    role: v.union(v.string(), v.null()),
    label: v.union(v.string(), v.null()),
    path: v.string(),
  }),
});

const scopeValidator = v.union(v.literal("shared"), v.literal("record"));

/** Where a target is: screen, view state, element, and scope. */
export const locationValidator = v.object({
  screen: v.string(),
  viewState: viewStateValidator,
  target: targetValidator,
  scope: scopeValidator,
});

export const anchorValidator = v.object({
  screen: v.string(),
  viewState: viewStateValidator,
  target: targetValidator,
  scope: scopeValidator,
  evidence: v.object({
    url: v.string(),
    viewport: v.object({ width: v.number(), height: v.number() }),
    marker: v.union(rectValidator, v.null()),
    capturedAt: v.number(),
    revision: v.union(v.string(), v.null()),
    persona: v.union(v.string(), v.null()),
    userAgent: v.union(v.string(), v.null()),
  }),
});

// Keep the stored anchor and location identical to @critiqs/core's types.
type StoredAnchor = Infer<typeof anchorValidator>;
export const anchorTypesMatch: [StoredAnchor, Anchor] extends [Anchor, StoredAnchor] ? true : never = true;
type StoredLocation = Infer<typeof locationValidator>;
export const locationTypesMatch: [StoredLocation, TargetLocation] extends [TargetLocation, StoredLocation]
  ? true
  : never = true;

/** Original image state (F6). A failed capture still saves the comment. */
export const captureFileValidator = v.union(v.id("_storage"), v.id("captureFiles"));
export const captureValidator = v.union(
  v.object({ status: v.literal("captured"), storageId: captureFileValidator }),
  v.object({ status: v.literal("supplied"), storageId: captureFileValidator, failureReason: v.string() }),
  v.object({ status: v.literal("failed"), failureReason: v.string() }),
);

export const revisionValidator = v.union(v.string(), v.null());

/** A reviewer verified by the sign-in provider. */
export const profileValidator = v.object({
  subject: v.string(),
  name: v.string(),
  email: v.string(),
  pictureUrl: v.union(v.string(), v.null()),
  profileVersion: v.optional(v.number()),
});

/** One change to a mockup's page copy; see MockupEdit in @critiqs/core. */
export const mockupEditValidator = v.union(
  v.object({ kind: v.literal("css"), css: v.string() }),
  v.object({ kind: v.literal("text"), node: v.number(), text: v.string() }),
  v.object({ kind: v.literal("attribute"), node: v.number(), name: v.string(), value: v.union(v.string(), v.null()) }),
  v.object({
    kind: v.literal("insert"),
    node: v.number(),
    position: v.union(v.literal("before"), v.literal("after"), v.literal("prepend"), v.literal("append")),
    html: v.string(),
  }),
  v.object({ kind: v.literal("replace"), node: v.number(), html: v.string() }),
  v.object({ kind: v.literal("remove"), node: v.number() }),
);

/** The page a mockup was made from. */
export const mockupSourceValidator = v.object({
  url: v.string(),
  screen: v.string(),
  viewState: viewStateValidator,
  revision: revisionValidator,
  persona: v.union(v.string(), v.null()),
  recordKey: v.optional(v.union(v.string(), v.null())),
});

/** What a mockup thread is about: the mockup, and optionally one element of one copy. */
export const threadMockupValidator = v.object({
  mockupId: v.id("mockups"),
  snapshotId: v.union(v.id("mockupSnapshots"), v.null()),
  node: v.union(v.number(), v.null()),
});

// Keep stored changes and sources identical to @critiqs/core's types.
type StoredEdit = Infer<typeof mockupEditValidator>;
export const mockupEditTypesMatch: [StoredEdit, MockupEdit] extends [MockupEdit, StoredEdit] ? true : never = true;
type StoredSource = Infer<typeof mockupSourceValidator>;
export const mockupSourceTypesMatch: [StoredSource, MockupSource] extends [MockupSource, StoredSource] ? true : never = true;

const extraCreditsValidator = v.union(v.object({ amount: v.number(), credits: v.number() }), v.null());
const planPriceValidator = v.object({ monthly: v.number(), extraCredits: extraCreditsValidator });

/** `BillingPrices`: Critiqs Cloud's prices as read from Autumn's catalog. */
export const billingPricesValidator = v.object({
  plans: v.object({ free: planPriceValidator, plus: planPriceValidator, pro: planPriceValidator }),
  storageAddOn: v.object({ gb: v.number(), monthly: v.number() }),
});

// Onboarding's answers as stored; each must list exactly core's values (checked below).

export const roleValidator = v.union(
  v.literal("designer"),
  v.literal("product-manager"),
  v.literal("engineer"),
  v.literal("founder"),
  v.literal("agency"),
  v.literal("other"),
);
export const teamSizeValidator = v.union(v.literal("just-me"), v.literal("2-5"), v.literal("6-20"), v.literal("21-100"), v.literal("over-100"));
const codeAccessValidator = v.union(v.literal("self"), v.literal("teammate"), v.literal("nobody"));
const feedbackFromValidator = v.union(v.literal("team"), v.literal("clients"), v.literal("test-users"));
const purposeValidator = v.union(v.literal("design-review"), v.literal("qa"), v.literal("user-testing"));
const stackValidator = v.union(
  v.literal("react"),
  v.literal("next"),
  v.literal("angular"),
  v.literal("astro"),
  v.literal("django"),
  v.literal("flask"),
  v.literal("gatsby"),
  v.literal("laravel"),
  v.literal("nuxt"),
  v.literal("rails"),
  v.literal("remix"),
  v.literal("solid"),
  v.literal("svelte"),
  v.literal("sveltekit"),
  v.literal("vue"),
  v.literal("wordpress"),
);

/** A project's onboarding answers and stack, as `ProjectOnboarding` in @critiqs/server. */
export const projectOnboardingValidator = v.object({
  codeAccess: v.optional(codeAccessValidator),
  feedbackFrom: v.optional(v.array(feedbackFromValidator)),
  purpose: v.optional(purposeValidator),
  stack: v.optional(stackValidator),
});

/** Onboarding's answers about a project as sent; values core doesn't know are dropped, as if skipped. */
export const projectAnswersArgs = v.object({
  codeAccess: v.optional(v.string()),
  feedbackFrom: v.optional(v.array(v.string())),
  purpose: v.optional(v.string()),
});

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameAsCore: [
  Same<Infer<typeof roleValidator>, Role>,
  Same<Infer<typeof teamSizeValidator>, TeamSize>,
  Same<Infer<typeof codeAccessValidator>, CodeAccess>,
  Same<Infer<typeof feedbackFromValidator>, FeedbackFrom>,
  Same<Infer<typeof purposeValidator>, Purpose>,
  Same<Infer<typeof stackValidator>, StackId>,
] = [true, true, true, true, true, true];
void sameAsCore;

/** A developer setup email as stored, as `StoredMail` in @critiqs/server. */
export const storedMailValidator = v.object({
  to: v.string(),
  subject: v.string(),
  text: v.string(),
  html: v.string(),
  fromName: v.string(),
  replyTo: v.string(),
});

/** A tracker tickets can be created in; see TrackerId in @critiqs/core. */
export const trackerValidator = v.union(v.literal("linear"), v.literal("github"), v.literal("jira"));

/** A ticket's last known status; see TicketStatus in @critiqs/core. */
export const ticketStatusValidator = v.object({
  label: v.string(),
  category: v.union(v.literal("open"), v.literal("started"), v.literal("done"), v.literal("canceled"), v.literal("unknown")),
});

/** A tracker token as stored: AES-GCM ciphertext and IV, base64. */
export const storedTokenValidator = v.object({ ciphertext: v.string(), iv: v.string() });

// Keep stored trackers and statuses identical to @critiqs/core's types.
type StoredTracker = Infer<typeof trackerValidator>;
export const trackerTypesMatch: [StoredTracker, TrackerId] extends [TrackerId, StoredTracker] ? true : never = true;
type StoredTicketStatus = Infer<typeof ticketStatusValidator>;
export const ticketStatusTypesMatch: [StoredTicketStatus, TicketStatus] extends [TicketStatus, StoredTicketStatus] ? true : never = true;

/** What a person's stored tracker token is read for (`TokenUse`): their own request, a job in projects they may review, removing what Critiqs registered, or Atlassian personal data reporting. */
export const tokenUseValidator = v.union(
  v.object({ by: v.literal("person") }),
  v.object({ by: v.literal("job"), projects: v.array(v.string()) }),
  v.object({ by: v.literal("cleanup") }),
  v.object({ by: v.literal("privacy") }),
);
/** A use a token may be returned for (`TokenRead`): never `cleanup` or `privacy`, whose tokens stay inside narrow capabilities. */
export const tokenReadValidator = v.union(v.object({ by: v.literal("person") }), v.object({ by: v.literal("job"), projects: v.array(v.string()) }));
