---
title: Your AI and provider keys
description: Use Your AI to pick models or connect your own OpenAI, Anthropic, Gemini, OpenRouter, or Vercel AI Gateway key, and control who pays.
section: Mockup mode
order: 3
---

Critiqs lets both individual reviewers and project owners choose how they connect to AI. You can use Critiqs AI on a Critiqs plan with no setup, or connect your own API key from a supported provider.

## What Your AI is

Every signed-in reviewer on a deployment with Critiqs AI has Critiqs AI ready by default. To check or change your personal setup, click your avatar on the toolbar and choose **Your AI…**.

In **Your AI**, you can:

- Choose your default Critiqs AI model from the **Model** menu.
- Check your personal plan and credits used, and click **Upgrade** when an upgrade page is configured.
- Click **Use your own API key** to connect your own provider account instead of using Critiqs AI credits.

Your personal AI settings follow your account across every project whose **Who pays** rule allows personal AI. Only you can see or change **Your AI**.

## Connect your own API key

Both individuals (in **Your AI…**) and project owners (in the **AI** tab of **Tags and AI**) can connect an API key from:

- **OpenAI**
- **Anthropic**
- **Google Gemini**
- **OpenRouter** (uses `https://openrouter.ai/api/v1` automatically)
- **Vercel AI Gateway**
- **Other (OpenAI-compatible)** (requires an HTTPS endpoint URL on the deployment operator's allowlist)

Follow these steps to connect a key:

1. Open **Your AI…** from your avatar menu (or, as a project owner configuring the project's shared connection, open **Tags and AI** in the **Comments** sidebar and select the **AI** tab).
2. Click **Use your own API key**.
3. On step 1 (**Choose a provider**), select your provider.
4. On step 2 (**Add your \<Provider\> key** or **Connect your endpoint**), paste your API key (and enter the **Endpoint address** if your provider requires one), then click **Continue**. Critiqs verifies the key from the server and loads the provider's model list (up to 500 models). If a provider does not publish a list, click **Name models instead**.
5. On step 3 (**Choose models**), tick the models you want to offer (up to 50) or type a model ID and click **Add**, then click **Save key**.

Your own provider key costs no Critiqs AI credits; your AI provider bills your account directly.

To switch back to Critiqs AI later, open **Your AI…** (or the project's **AI** tab), click **Use Critiqs AI instead**, and confirm **Remove key**.

> **Note:** Critiqs makes all model calls from its server using API keys. Consumer Claude or ChatGPT web subscriptions cannot be used from a server under those providers' terms and are not offered.

## How Critiqs protects your keys

- **Encrypted on the server:** When you save a key, Critiqs sends it to the backend once, encrypts it at rest with AES-256-GCM (bound to your user ID for **Your AI** or the project ID for project keys), and never returns it to any browser. The interface shows only the last four characters (such as `····9876`).
- **Provider authentication:** When you list models, test a connection, or run an AI request, the backend sends your key in request headers to authenticate with your chosen provider. When listing models before saving, the key goes to the backend for that request only and is not stored.
- **Endpoint safety:** Changing your provider or endpoint address without typing a new key removes the saved key so it is never sent to a different endpoint. Custom endpoints must use HTTPS, cannot follow redirects, and must be on the deployment's allowlist.
- **Prompt boundaries:** Critiqs never puts API keys, reviewer email addresses, captures, or other projects' threads into prompts sent to a model. Elements marked with `data-critiqs-mask` are omitted from mockup page descriptions.

On a team-owned Convex deployment, the operator must set `CRITIQS_AI_ENCRYPTION_KEY` before keys can be saved. See [Backends](/docs/backends).

## Who pays for AI

Organization admins and the person who created a project (while they remain a member of the organization) control how AI is billed for that project. Open **Tags and AI** in the **Comments** sidebar, select the **AI** tab, and choose an option under **Who pays**:

| Rule | Connection used for requests a reviewer starts | Who pays |
| --- | --- | --- |
| **Project pays, personal allowed** (default) | The reviewer's saved personal connection if ready; otherwise the project's connection | The reviewer (their home organization, or their own usage account on the default plan if they have no eligible home organization) if they saved their own AI choice; otherwise the project's organization |
| **Project pays** | Always the project's connection | The project's organization (or the project's own API key) |
| **Each person pays** | Always the reviewer's own connection (Critiqs AI by default, or their own API key) | Each reviewer (their home organization, or their own usage account on the default plan if they have no eligible home organization, or their own API key) |

A few rules apply across all settings:

- **Background work:** Automatic tag grouping has no individual requester behind it, so it always uses the project's AI connection. If the project has none, new tags stay ungrouped until organized manually.
- **AI off for the project:** Turning off the **AI for this project** switch stops every AI call in that project, including reviewers' personal connections, so no feedback leaves for any AI provider.
- **No silent fallback:** If a chosen connection fails or runs out of credits, Critiqs reports the error and never silently falls back to another connection or payer.
- **Allowed models:** Organization admins and the project creator (while a member) can limit which Critiqs AI models reviewers may pick under **Allowed models**. That limit applies only when the project pays; it never restricts a reviewer's own connection.
- **Missing personal AI:** Under **Each person pays**, if a deployment offers no Critiqs AI or a reviewer's saved key is not ready, Mockup mode refuses the turn with a **Set up your AI** button, and search runs as **Basic search** with a **Set up your AI** prompt.
