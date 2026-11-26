---
title: Backends
description: Choose between Critiqs Cloud (the default hosted service) and self-hosting Critiqs on your team's own Convex deployment.
section: Get started
order: 4
---

This guide covers two backend options: **Critiqs Cloud** by default, or your team's own **Convex deployment** if you want feedback and captures stored on infrastructure you control. Both run the same open-source Critiqs server code under the MIT license. Team-owned Convex uses Critiqs Cloud's sign-in service by default; to run with no Critiqs service involved, configure your own sign-in as described in [Self-hosting on your own Convex](/docs/self-hosting).

| Feature | Critiqs Cloud | Team-owned Convex |
| --- | --- | --- |
| Hosting and setup | Managed by Critiqs; no keys required | Deployed to your Convex account |
| Sign-in and email | Built-in email codes and notifications | Uses Critiqs Cloud sign-in by default, or your own; Resend key for email |
| Captures storage | Managed by Critiqs | Convex file storage or private Cloudflare R2 bucket |
| Mockup mode and MCP server | Included | Included |
| AI | Critiqs AI credits or your own provider key | Your own provider key (or deployment default provider) |
| Plan limits | Free, Plus, and Pro plans | No Critiqs plan limits |

## Critiqs Cloud (default)

Critiqs Cloud is the default backend when you set no backend. Critiqs operates the Convex backend, email-code sign-in service, and notification emails.

You do not configure any backend keys or environment secrets. Run `npx critiqs init`, sign in with your email, and Critiqs Cloud creates your project.

> **Plan:** Critiqs Cloud includes a Free plan (1 project, 5 reviewers a month, 500 comments a month, 200 Critiqs AI credits a month, and 500 MB of captures), Plus ($20/month regular, $10/month beta), and Pro ($100/month regular, $50/month beta). See [AI models and credits](/docs/ai-models-and-credits) for credit details.

## Team-owned Convex deployment

To keep all comments, threads, mockups, and captures in your own Convex account, deploy Critiqs's Convex functions to your own deployment. The `critiqs` package, which every Critiqs npm package and the setup CLI use, bundles the backend functions for you.

### 1. Create a Convex deploy key

Create a project in your Convex dashboard and generate a production deploy key (`CONVEX_DEPLOY_KEY`) in that project's settings.

### 2. Deploy and connect with init

Run `init` with `--own-convex`:

```sh
npx critiqs init --own-convex
```

Init asks for `CONVEX_DEPLOY_KEY` (or reads it from your environment) and sends secrets through standard input rather than command arguments. It deploys Critiqs's functions to your deployment, connects your app, and sets its backend. In a React app, that is the `backend` prop on `<Critiqs />`:

```tsx
<Critiqs
	backend="https://your-deployment.convex.cloud"
	projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID}
	requireProjectId
/>
```

To connect another app or checkout to a Convex deployment that already runs Critiqs, pass `--backend`:

```sh
npx critiqs init --backend https://your-deployment.convex.cloud
```

Self-hosted Convex backends are also supported by setting `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` in your environment before running `init --own-convex`.

### 3. Configure optional backend services

Set environment variables on your Convex deployment from your terminal (typing secrets into stdin, not as command arguments) or in the Convex dashboard. Never put backend keys in your app or its build settings.

#### Mention and reply emails

By default, a team-owned Convex deployment trusts Critiqs Cloud's sign-in service (`CRITIQS_AUTH_ISSUER`), so reviewers can sign in right away. To send mention and reply notification emails from your deployment, set a Resend key and verified sender address:

- `RESEND_API_KEY`: Your Resend API key.
- `CRITIQS_EMAIL_FROM`: A verified sender address, such as `Critiqs <critiqs@example.com>`.

If you also want to run your own sign-in service with no Critiqs service involved, set `CRITIQS_AUTH_PRIVATE_KEY` (an ES256 private JWK) and point `CRITIQS_AUTH_ISSUER` to your own `.convex.site` URL alongside the Resend settings. See [Self-hosting on your own Convex](/docs/self-hosting).

#### Private Cloudflare R2 capture storage

By default, captures are stored in Convex file storage. To store captures in a private Cloudflare R2 bucket while keeping metadata and access checks in Convex, set these variables on your Convex deployment:

| Variable | Value |
| --- | --- |
| `CRITIQS_CAPTURE_STORAGE` | `r2` |
| `CRITIQS_R2_ACCOUNT_ID` | Your Cloudflare account ID |
| `CRITIQS_R2_BUCKET` | Private bucket name (public access disabled) |
| `CRITIQS_R2_ACCESS_KEY_ID` | R2 API token access key restricted to that bucket |
| `CRITIQS_R2_SECRET_ACCESS_KEY` | R2 API token secret key |

Existing captures stored in Convex remain readable after switching to R2.

#### AI on your own Convex deployment

To let project owners and reviewers save their own AI provider keys in Critiqs, set an encryption key on the same Convex deployment (for example with `--prod`, or with `CONVEX_DEPLOYMENT` or `CONVEX_DEPLOY_KEY` set in the process environment):

```sh
npx convex env set --prod CRITIQS_AI_ENCRYPTION_KEY
```

Generate a value of at least 32 random characters (for example with `openssl rand -base64 32`). You can also configure a default provider for every project that does not save its own key by setting `CRITIQS_AI_PROVIDER`, `CRITIQS_AI_MODEL`, and `CRITIQS_AI_API_KEY`. To allow custom OpenAI-compatible endpoints, list their URLs in `CRITIQS_AI_ALLOWED_ENDPOINTS`.

## Verify your backend

Run `doctor` to verify that your component, backend version, project, and optional services are configured:

```sh
npx critiqs doctor
```

Pass `--backend <url>` to check a specific deployment URL.
