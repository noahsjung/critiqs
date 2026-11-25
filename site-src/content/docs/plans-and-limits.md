---
title: Plans and limits
description: Compare Critiqs Cloud Free, Plus, and Pro plans, beta pricing, AI credits, overage caps, image storage, and limit behavior.
section: Teams and plans
order: 2
requires: [53, 57]
---

> **Plan:** Beta pricing applies while Critiqs is in beta. Plus is **$10 a month** (regular price $20) and Pro is **$50 a month** (regular price $100). Free is **$0**. All prices are in US dollars, billed monthly.

On Critiqs Cloud, each [organization](/docs/organizations) has one plan: **Free**, **Plus**, or **Pro**. Monthly limits and paid billing periods follow UTC calendar months and renew at the start of each month in UTC.

Self-hosted deployments on your own Convex have no plans or plan limits. See [self-hosting](/docs/self-hosting).

## Plan comparison

| Limit | Counted per | Free ($0) | Plus ($10/mo beta; $20 regular) | Pro ($50/mo beta; $100 regular) |
| --- | --- | --- | --- | --- |
| Critiqs AI credits | Organization / month | 200 | 2,000 | 10,000 |
| Extra AI credits | Organization / month | Not available | $1 per 100 credits, up to overage cap | $1 per 100 credits, up to overage cap |
| Default overage cap | Organization / month | None | 2,000 extra credits ($20) | 10,000 extra credits ($100) |
| Projects | Organization (total) | 1 | 10 | No limit |
| Reviewers | Project / month | 5 | 25 | No limit |
| Comments (including replies) | Project / month | 500 | 5,000 | No limit |
| Image storage (captures and mockup copies) | Organization (total) | 500 MB | 10 GB | 100 GB, then $10/month per extra 100 GB |
| Mention emails | Project / day | 100 | No limit | No limit |

## How Critiqs AI credits work

Commenting, threads, mentions, tags, and exports never consume AI credits. Connecting your own AI provider API key also costs zero Critiqs AI credits (see [Your AI](/docs/your-ai) and [AI models and credits](/docs/ai-models-and-credits)).

- **1 credit = $0.01 (one cent)** of customer usage.
- **Per-token billing:** For a priced model, each Critiqs AI request costs `ceil(api_cost_usd × 200)` credits (minimum 1 credit): twice the API cost, rounded up to whole credits. Critiqs uses the provider's reported cost when available, and otherwise calculates it from the request's tokens and the model's configured prices. Models without configured token prices use flat credits per request. The credit number shown beside each priced model in the menu is an estimate.
- **Who pays:** When a project pays for AI, credits count against the project's organization. When a person pays for their own Critiqs AI, credits count against their home organization while they belong to it, or fall back to their own usage account on the default plan if they have no eligible home organization.
- **Reserve then charge:** Before calling a model, Critiqs reserves the request's estimated worst-case cost against the remaining balance (including any allowed extra credits, minus active holds). A small balance above zero can still be refused if it cannot cover that hold. Once the model answers, Critiqs releases the hold and charges the actual cost in full without discarding completed work. A failed request releases its hold and costs nothing.

## Extra credits and the overage cap

On **Plus** and **Pro**, Critiqs AI continues working after your included monthly credits run out, billed at **$1 per 100 extra credits** up to your organization's overage cap.

- **Default cap:** Starts equal to your plan's included credits (2,000 extra credits on Plus, 10,000 extra credits on Pro).
- **Adjust or remove the cap:** Organization admins can raise, lower, or remove the overage cap in **Plan and billing** under **Cap on extra credits**.
- **Alert emails:** Organization admins receive one email per month when included credits run out (and extra credits begin), and another email if the overage cap is reached (or when Free credits run out).
- **Free plan:** Has no overage. Critiqs AI requests stop at 200 credits until the next month starts or an admin upgrades.

## Image storage and extra storage on Pro

Image storage counts captures, attached screenshots, and Mockup mode page copies across every project in the organization.

- **Free:** 500 MB total
- **Plus:** 10 GB total
- **Pro:** 100 GB total, plus optional **100 GB add-on units at $10 a month each**, managed by admins in **Plan and billing**

Deleting a thread hides it from normal views without erasing its history, so its stored usage remains counted.

## What happens when you reach a limit

| Limit reached | Behavior |
| --- | --- |
| Projects | Creating a new project is refused. Existing projects keep working (for example, if an organization has more projects than Free allows, only creating new projects is blocked). |
| Reviewers | Each reviewer counts once per project per UTC month regardless of how many comments they post. Past the limit, additional reviewers cannot post comments in that project until next month or an upgrade. |
| Comments | New comments and replies in that project are refused until next month or an upgrade. |
| Image storage | New capture uploads and Mockup mode page copies are refused. Comments still save without an automatic capture. |
| Mention emails (Free) | Past 100 mention emails in a UTC day on a project, mentions still post and highlight in the thread, but Critiqs skips sending emails. |
| Critiqs AI credits | AI searches fall back to Basic search, Mockup mode refuses new AI turns, and automatic tag grouping pauses. Switch to your own API key, wait for the next UTC month, raise the overage cap (Plus/Pro), or upgrade. |

> **Note:** Reaching any plan limit never blocks sign-in. Plans marked "No limit" still sit under operational limits against abuse (such as sign-in code rate limits, 10 MB per capture image, 500 messages per thread, and 200 threads per export).

## View usage and manage your plan

- **Project owners** (organization admins and the project's creator while they remain a member) see current usage under the **\<plan name\> plan** block in the **Project panel** (Browse mode) and in **Project setup**, including organization-wide counts for projects, image storage, and Critiqs AI credits.
- **Organization admins** upgrade, downgrade, cancel, change the **Cap on extra credits**, add Pro storage, or update payment details in **Plan and billing** (opened via **Upgrade**).


## Self-hosted

Critiqs is open source under the MIT license. Running Critiqs on your own Convex deployment costs $0 in Critiqs plan fees and has no limits on projects, reviewers, comments, or storage beyond your own Convex account. See [Self-hosting on your own Convex](/docs/self-hosting).
