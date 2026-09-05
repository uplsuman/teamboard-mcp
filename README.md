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
| `search_teamboard_tasks` | Find tasks by keyword and/or filters — `assignee` (incl. `"me"`), `project`, `status[]`, `priority[]`, `type[]`, `dueBefore`, `dueAfter` — or raw `jql`. Call before creating, to catch duplicates. |
| `get_teamboard_task` | Full detail for one task, plus any of `include: ["comments","subtasks","links","attachments","history"]`. Comment ids are printed for the edit/delete tools. |
| `create_teamboard_task` | Create a task. Project by code or name, assignee/reporters by name. |
| `edit_teamboard_task` | Update title, description, status, priority, type, assignee, reporters, dates, progress, tags, project, parent task, watchers. |
| `create_teamboard_subtask` | Add a subtask under a task; inherits the parent's project. |
| `link_teamboard_tasks` / `unlink_teamboard_tasks` | Typed relationships: blocks, blocked_by, clones, cloned_by, splits_into, splits_from, causes, caused_by, duplicate_of, relates_to. The inverse is implied. |
| `comment_teamboard_task` | Post a comment (HTML). |
| `edit_teamboard_comment` / `delete_teamboard_comment` | Change or remove a comment by id — your own, or any as an admin. |
| `add_teamboard_attachment` | Upload a local file onto a task. |
| `download_teamboard_attachment` | Save an attachment to a local file. |
| `delete_teamboard_attachment` | Detach a file and delete it from storage. |
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

Attachments are addressed by **name**, never by their storage URL, and an ambiguous
name lists the candidates rather than picking one — deleting the wrong file is not
recoverable.

## Requires

TeamBoard with personal-access-token support on `/api/tasks`, `/api/tasks/meta`,
`/api/tasks/statuses`, `/api/tasks/:id/{subtasks,links,activities}`, `/api/projects`,
`/api/projects/:id/members`, `/api/users`, `/api/users/me`, `/api/comments`,
`/api/comments/:id` and `/api/uploads/*` (TB `dev` after Sep 2026).
