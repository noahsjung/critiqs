/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as addressCheck from "../addressCheck.js";
import type * as ai from "../ai.js";
import type * as aiSettings from "../aiSettings.js";
import type * as billing from "../billing.js";
import type * as captureHttp from "../captureHttp.js";
import type * as captures from "../captures.js";
import type * as crons from "../crons.js";
import type * as deviceSignIn from "../deviceSignIn.js";
import type * as grouping from "../grouping.js";
import type * as http from "../http.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_autumn from "../lib/autumn.js";
import type * as lib_billing from "../lib/billing.js";
import type * as lib_links from "../lib/links.js";
import type * as lib_pages from "../lib/pages.js";
import type * as lib_r2 from "../lib/r2.js";
import type * as lib_store from "../lib/store.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as lib_validators from "../lib/validators.js";
import type * as mockups from "../mockups.js";
import type * as notificationEmails from "../notificationEmails.js";
import type * as notifications from "../notifications.js";
import type * as onboarding from "../onboarding.js";
import type * as organizationEmails from "../organizationEmails.js";
import type * as organizations from "../organizations.js";
import type * as planAlerts from "../planAlerts.js";
import type * as plans from "../plans.js";
import type * as projects from "../projects.js";
import type * as search from "../search.js";
import type * as signIn from "../signIn.js";
import type * as tags from "../tags.js";
import type * as threads from "../threads.js";
import type * as uploads from "../uploads.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  addressCheck: typeof addressCheck;
  ai: typeof ai;
  aiSettings: typeof aiSettings;
  billing: typeof billing;
  captureHttp: typeof captureHttp;
  captures: typeof captures;
  crons: typeof crons;
  deviceSignIn: typeof deviceSignIn;
  grouping: typeof grouping;
  http: typeof http;
  "lib/ai": typeof lib_ai;
  "lib/autumn": typeof lib_autumn;
  "lib/billing": typeof lib_billing;
  "lib/links": typeof lib_links;
  "lib/pages": typeof lib_pages;
  "lib/r2": typeof lib_r2;
  "lib/store": typeof lib_store;
  "lib/tokens": typeof lib_tokens;
  "lib/validators": typeof lib_validators;
  mockups: typeof mockups;
  notificationEmails: typeof notificationEmails;
  notifications: typeof notifications;
  onboarding: typeof onboarding;
  organizationEmails: typeof organizationEmails;
  organizations: typeof organizations;
  planAlerts: typeof planAlerts;
  plans: typeof plans;
  projects: typeof projects;
  search: typeof search;
  signIn: typeof signIn;
  tags: typeof tags;
  threads: typeof threads;
  uploads: typeof uploads;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
