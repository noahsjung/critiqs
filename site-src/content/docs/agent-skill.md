---
title: Add the Critiqs agent skill
description: Install the Critiqs SKILL.md file so Claude Code, Codex, and Cursor know how to install Critiqs, read threads and mockups, and reply.
section: Agents
order: 2
---

The Critiqs agent skill is a `SKILL.md` file hosted at `https://critiqs.app/skills/critiqs/SKILL.md`. It teaches coding agents to check whether Critiqs is installed, connect the [MCP server](/docs/mcp) without asking for secrets, read open threads and mockups with their context, build fixes in your components, and reply in threads.

You can install the skill once for your user account (available in every repository) or commit it inside a repository so everyone on your team shares it.

## Claude Code

Install for your user account:

```sh
curl -fsSL https://critiqs.app/skills/critiqs/SKILL.md --create-dirs -o ~/.claude/skills/critiqs/SKILL.md
```

Or install inside one repository:

```sh
curl -fsSL https://critiqs.app/skills/critiqs/SKILL.md --create-dirs -o .claude/skills/critiqs/SKILL.md
```

## Codex

Install for your user account:

```sh
curl -fsSL https://critiqs.app/skills/critiqs/SKILL.md --create-dirs -o ~/.codex/skills/critiqs/SKILL.md
```

Or install inside one repository:

```sh
curl -fsSL https://critiqs.app/skills/critiqs/SKILL.md --create-dirs -o .agents/skills/critiqs/SKILL.md
```

Codex loads skills from `~/.codex/skills`, `~/.agents/skills` and a repository's `.agents/skills`. Start a new Codex session after you add one.

## Cursor

Cursor reads rules from `.cursor/rules` in your repository. A rule needs Cursor's own front matter, so download the skill and replace its first lines:

```sh
mkdir -p .cursor/rules
{ printf -- '---\ndescription: Read and answer Critiqs review feedback and build Critiqs mockups\nalwaysApply: false\n---\n'; curl -fsSL https://critiqs.app/skills/critiqs/SKILL.md | sed '1,/^---$/{/^---$/!d};1,/^---$/d'; } > .cursor/rules/critiqs.mdc
```

With `alwaysApply: false`, Cursor's agent reads the rule when a request matches its description, such as "check the Critiqs comments".

## Verify the setup

1. Configure the [Critiqs MCP server](/docs/mcp) in your agent client.
2. Sign your computer in once with `npx critiqs-react sign-in` (or let the agent call `critiqs_sign_in`).
3. Start a new session in your agent and ask it to check open Critiqs comments or mockups for your app.

## Update the skill

Re-run the same `curl` command at any time to fetch the latest `SKILL.md` from `https://critiqs.app/skills/critiqs/SKILL.md`.
