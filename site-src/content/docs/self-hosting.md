---
title: Self-hosting on your own Convex
description: Deploy Critiqs's open-source backend to your own Convex deployment, configure email, R2 capture storage, and AI keys.
section: Guides
order: 2
---

Critiqs is open source under the MIT license. Instead of using Critiqs Cloud, you can run Critiqs's Convex backend functions on your own Convex deployment so comments, captures, and mockups stay on storage your team controls.

Self-hosted deployments have no Critiqs Cloud plans or plan limits.

## Prerequisites

- Node.js 20 or later
- A React 18 or 19 host app with `critiqs-react` installed
- Either:
  - A Convex Cloud project and its **production deploy key** (`CONVEX_DEPLOY_KEY`, starting with `prod:`), from your Convex project settings, or
  - A self-hosted Convex backend with `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`
- Optional: a Resend API key and verified sending domain if you want mention, reply, and invite emails

## 1. Deploy and connect your app

1. Install `critiqs-react` if you have not already:

   ```sh
   npm install critiqs-react
   ```

2. Run `init` with `--own-convex`:

   ```sh
   npx critiqs-react init --own-convex
   ```

   In an interactive terminal, `init` prompts for your Convex production deploy key with hidden input (and offers an optional prompt for a Resend API key and sender address). For non-interactive runs, inject `CONVEX_DEPLOY_KEY` into the process environment from your secret store (for example, `op run` or CI secrets) instead of typing a literal key into your shell history or a repository file.

   For a self-hosted Convex backend, inject `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` through the process environment instead (do not set both `CONVEX_DEPLOY_KEY` and self-hosted variables).

   `init --own-convex` performs these steps:
   - Configures `CRITIQS_AUTH_ISSUER` (and optional Resend variables) on your Convex deployment via standard input, never via command arguments.
   - Deploys Critiqs's bundled Convex functions to your deployment.
   - Signs you in, creates your project, and writes both `backend="https://<deployment>.convex.cloud"` and your project ID into your app.

3. Verify the deployment:

   ```sh
   npx critiqs-react doctor
   ```

4. Set the project's review address once your staging build is live:

   ```sh
   npx critiqs-react init --review-url https://staging.example.com
   ```

## Connect additional apps to the same deployment

Once Critiqs is deployed to your Convex backend, connect other apps to it without redeploying:

```sh
npx critiqs-react init --backend https://<deployment>.convex.cloud
```

For coding agents, pass `--backend https://<deployment>.convex.cloud` to `npx critiqs-react sign-in` and in MCP tool calls (see [MCP](/docs/mcp)).

## Configure sign-in

By default, `init --own-convex` sets `CRITIQS_AUTH_ISSUER` to Critiqs Cloud's sign-in service. Your feedback, captures, and mockups stay on your Convex deployment, while Critiqs Cloud emails one-time sign-in codes.

To run your own sign-in service on your Convex deployment with no Critiqs Cloud involvement, set these environment variables on your Convex deployment (passing secret values via standard input or the Convex dashboard):

| Variable | Value |
| --- | --- |
| `CRITIQS_AUTH_ISSUER` | Your deployment's `.convex.site` URL (for example `https://<deployment>.convex.site`) |
| `CRITIQS_AUTH_PRIVATE_KEY` | An ES256 private JWK used to sign tokens |
| `RESEND_API_KEY` | Your Resend API key |
| `CRITIQS_EMAIL_FROM` | A sender address on a domain verified in Resend (such as `Critiqs <sign-in@example.com>`) |

If you run a custom sign-in service at another address, set `CRITIQS_SIGN_IN_URL` in your shell before running `npx critiqs-react init --own-convex`.

## Configure mention and reply emails

To send mention, reply, and organization invite emails from your Convex deployment, target the same deployment (for example with `--prod`, or by setting `CONVEX_DEPLOYMENT` or `CONVEX_DEPLOY_KEY` in the process environment) and set these variables:

```sh
npx convex env set --prod RESEND_API_KEY
npx convex env set --prod CRITIQS_EMAIL_FROM
```

Enter each value at the stdin prompt (for example `Critiqs <critiqs@example.com>` on a domain verified in Resend). Without Resend configured, mentions still post and highlight in threads, and no email is sent.

## Optional: store captures in private Cloudflare R2

By default, captures and screenshots are stored in native Convex file storage. To store image bytes in a private Cloudflare R2 bucket while keeping comments, metadata, and access checks in Convex:

1. Create a private Standard R2 bucket with public access disabled.
2. Create an R2 API token with **Object Read & Write** permission restricted to that bucket.
3. Set these variables on your Convex deployment (never in your host app):

   | Variable | Value |
   | --- | --- |
   | `CRITIQS_CAPTURE_STORAGE` | `r2` (`convex` is the default) |
   | `CRITIQS_R2_ACCOUNT_ID` | Your Cloudflare account ID |
   | `CRITIQS_R2_BUCKET` | Private bucket name, such as `critiqs-captures` |
   | `CRITIQS_R2_ACCESS_KEY_ID` | Bucket-restricted R2 access key ID |
   | `CRITIQS_R2_SECRET_ACCESS_KEY` | Bucket-restricted R2 secret access key |

4. Run `npx critiqs-react doctor` to confirm screenshot storage is configured, then leave a real comment to verify upload access.

Existing Convex-stored captures remain readable without migration. Incomplete R2 settings fail explicitly instead of silently falling back to Convex storage.

## Optional: enable AI on your deployment

AI is optional; commenting, threads, mentions, tags, and exports work without it. To enable AI features (automatic tag grouping, natural-language search with insights, and Mockup mode) on your Convex deployment:

1. Generate a 32+ character encryption key so project owners and reviewers can save their own provider API keys encrypted with AES-256-GCM (target the same deployment with `--prod`, or with `CONVEX_DEPLOYMENT` or `CONVEX_DEPLOY_KEY`):

   ```sh
   openssl rand -base64 32 | npx convex env set --prod CRITIQS_AI_ENCRYPTION_KEY
   ```

2. Optional: configure a default provider used by projects that have not saved their own:
   - `CRITIQS_AI_PROVIDER`: `openai`, `anthropic`, `google`, `openrouter`, `gateway`, or `compatible`
   - `CRITIQS_AI_MODEL`: model name for that provider
   - `CRITIQS_AI_API_KEY`: provider API key (optional only for `compatible`)
   - `CRITIQS_AI_BASE_URL`: endpoint URL for `compatible`

3. Optional: allow custom OpenAI-compatible endpoints in project and personal AI settings:
   - `CRITIQS_AI_ALLOWED_ENDPOINTS`: comma-separated HTTPS endpoint URLs owners may enter
   - `CRITIQS_AI_LOCAL_ENDPOINTS=enabled`: allow `http://` or private addresses in the allowlist

4. Optional: offer a managed list of models for every project and reviewer on your deployment:
   - `CRITIQS_MANAGED_AI=enabled`
   - `CRITIQS_MANAGED_AI_PROVIDER`: `openai`, `anthropic`, `google`, `openrouter`, `gateway`, or `compatible`
   - `CRITIQS_MANAGED_AI_MODELS`: JSON array of `{"id", "label", "model", "credits"}` (or set a single model with `CRITIQS_MANAGED_AI_MODEL`)
   - `CRITIQS_MANAGED_AI_API_KEY`: provider key (and optional `CRITIQS_MANAGED_AI_BASE_URL` for `compatible`)

## Upgrading your deployment

<!-- GAP: no supported backend-only upgrade command -->

Keep your Convex backend functions in step with your installed `critiqs-react` version.

`critiqs-react` does not currently include a supported command for a backend-only upgrade. Do not rerun `npx critiqs-react init --own-convex` on an app that already names a project: `init` refuses when a project is already configured, and passing `--new-project` creates a replacement project instead of upgrading your existing one.

To upgrade the backend while keeping your current project ID, existing data, and `CRITIQS_AUTH_ISSUER`:

1. Update `critiqs-react` and read the release notes for any new backend environment variables or one-time migrations.
2. Deploy the package's bundled Convex functions (`node_modules/critiqs-react/dist/backend/convex`) to the same deployment with the Convex CLI, using `CONVEX_DEPLOY_KEY` (or your self-hosted Convex variables) injected from your secret store or process environment, without overwriting `CRITIQS_AUTH_ISSUER`.
3. Run `npx critiqs-react doctor` to confirm the deployment reports a matching backend version.

After upgrading an older deployment that already had comments before hashtags were introduced, run the backfill once against the same deployment (for example with `--prod`, or with `CONVEX_DEPLOYMENT` or `CONVEX_DEPLOY_KEY` set):

```sh
npx convex run --prod tags:backfill
```

## Related pages

- [Command line reference](/docs/cli)
- [Backends](/docs/backends)
- [Your AI](/docs/your-ai)
- [Troubleshooting](/docs/troubleshooting)
