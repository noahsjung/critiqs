import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("remove expired sign-in attempts, sessions, and tracker sign-ins", { hours: 1 }, internal.signIn.cleanUp, {});

crons.interval("send mention emails", { minutes: 1 }, internal.notificationEmails.deliver, {});
crons.interval("send plan alert emails", { minutes: 1 }, internal.notificationEmails.deliverPlanAlerts, {});
crons.interval("remove old mention emails", { hours: 24 }, internal.notifications.cleanUp, {});
crons.interval("remove unused R2 screenshots", { minutes: 10 }, internal.captures.cleanUp, {});
crons.interval("remove expired uploads and unused files in Convex storage", { minutes: 10 }, internal.uploads.cleanUp, {});
crons.interval("group new tags", { minutes: 1 }, internal.ai.groupTags, {});
crons.interval("remove expired AI request counters", { hours: 1 }, internal.grouping.cleanUpRateLimits, {});
crons.interval("report Critiqs AI usage to billing", { minutes: 1 }, internal.billing.reportUsage, {});
crons.interval("check organizations' subscriptions with billing", { hours: 24 }, internal.billing.reconcile, {});
crons.interval("remove old billing records", { hours: 24 }, internal.billing.cleanUp, {});
crons.interval("remove ended review link leases and old usage", { minutes: 10 }, internal.reviewLinks.cleanUp, {});
crons.interval("check review links' addresses with the reputation provider", { hours: 1 }, internal.reviewLinks.recheckReputation, {});
crons.interval("check allowed sites' Allow Critiqs proof again", { minutes: 10 }, internal.reviewAllow.recheck, {});
crons.interval("end shared builds past their expiry and unpublished uploads", { minutes: 10 }, internal.reviewBuilds.expire, {});
crons.interval("remove ended shared builds' files", { minutes: 10 }, internal.reviewBuilds.purge, {});

export default crons;
