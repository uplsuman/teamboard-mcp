# teamboard-mcp

MCP server for TeamBoard. Lets any MCP-aware client (Claude Code, etc.) read and
write TeamBoard tasks over the HTTP API.

**You never pass an ObjectId.** Tasks are referenced by `TASK-42` (any casing or
zero-padding) or by title; people by name, email or username; projects by code or
name. When a reference is ambiguous the tool returns the candidate list instead of
guessing — so an edit never lands on the wrong task or the wrong assignee.

## Usage (no install)

Add this to your Claude Code MCP config (`~/.claude.json`, or `.mcp.json` in any project):

```json
{
  "mcpServers": {
    "teamboard": {
      "command": "npx",
      "args": ["-y", "github:uplsuman/teamboard-mcp"],
      "env": {
        "TEAMBOARD_BASE_URL": "https://teamboard.utplco.com",
        "TEAMBOARD_TOKEN": "tbp_..."
      }
    }
  }
}
```

Generate the token in **TeamBoard → Profile → API Tokens**. Grant these scopes:
`tasks:read`, `tasks:write`, `projects:read`, `users:read`, `comments:write`.
MCP servers only pick up env changes on restart — run `/mcp` to reconnect after
changing the token.

## Tools

| Tool | What it does |
|---|---|
| `search_teamboard_tasks` | Keyword search across title, description, tags, comments, assignee, project. Call before creating, to catch duplicates. |
| `get_teamboard_task` | Full detail for one task, optionally with its comment thread. |
| `create_teamboard_task` | Create a task. Project by code or name, assignee/reporters by name. |
| `edit_teamboard_task` | Update title, description, status, priority, type, assignee, reporters, dates, progress, tags, project, parent task, watchers. |
| `comment_teamboard_task` | Post a comment (HTML). |
| `list_teamboard_projects` | Projects you can see, with their codes. |
| `list_teamboard_users` | People by name/email; pass `project` for just that project's members. |

Notes that bite:

- **Rich text is HTML.** `description` and `comment` take literal
  `<h3>/<ul>/<li>/<strong>/<code>` markup, not plain text with newlines.
- **An assignee must be a member of the task's project.** `list_teamboard_users`
  with `project` shows who is eligible; the assignee lookup is scoped to that
  roster, so a non-member name fails with the roster rather than picking someone.
- **`tags` replaces the whole list** — pass every tag you want to keep.
- **`"none"`** clears `assignee`, `project`, `parent` or `type`.
- **Statuses, priorities and task types are read from the workspace at startup**,
  so the tool descriptions list your real values and a typo is rejected locally.
- Moving a task to another project **changes its task id**; the tool reports the new one.
- Some server rules surface as tool errors and need a follow-up argument:
  `clarification` (10+ chars) when an active task's due date or status changes, and
  `trackerDecision` when the assignee already has a running timer.

## Development

```bash
pnpm install
node test.mjs            # resolution tests, no network (fetch is stubbed)

TEAMBOARD_BASE_URL=http://localhost:3000 TEAMBOARD_TOKEN=tbp_xxx node index.js
```

`resolve.js` holds the API client and the reference resolvers; `index.js` is only
tool definitions and formatting.

## Requires

TeamBoard with PAT support on `/api/tasks`, `/api/tasks/meta`, `/api/tasks/statuses`,
`/api/projects`, `/api/projects/:id/members`, `/api/users` and `/api/comments`
(TB `dev` after Sep 2026).
