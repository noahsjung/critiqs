---
"critiqs-react": minor
---

Replies now email everyone in their thread: whoever started it, replied in it, or was mentioned in it. People a reply mentions get their mention email instead, and the person replying is never emailed. Reviewers can turn reply emails off with "Email me about new replies in threads I'm in" in Email notifications; muting a project mutes both kinds, and an email's unsubscribe link now stops both. Coding agents can reply as the signed-in reviewer with the MCP server's new `critiqs_reply` tool, mentioning people by name or author ID; the thread, exports, the reading tools, and emails show these replies as "via coding agent". Deploy the matching backend: it adds reply emails, the agent mark, and `agentReplies` to `/critiqs/config`, and self-hosted SQLite databases migrate to schema 7 on start.
