import type { Anchor, MockupEdit, MockupSource, TargetLocation } from "@critiqs/core";
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
