# teamboard-mcp

MCP server for TeamBoard. Lets any MCP-aware client (Claude Code, etc.) search and create tasks via the TeamBoard HTTP API.

## Usage (no install)

Add this to your Claude Code MCP config (`~/.claude/mcp.json` or `.mcp.json` in any project):

```json
{
    "mcpServers": {
    "teamboard": {
      "command": "npx",
      "args": [
        "-y",
        "github:uplsuman/teamboard-mcp"
      ],
      "env": {
        "TEAMBOARD_BASE_URL": "https://teamboard.utplco.com",
        "TEAMBOARD_TOKEN": ""
      }
    }
  }
}
```

Replace `your-org` with the actual GitHub org/user, and generate your token from **TeamBoard → Profile → API Tokens**.

## Tools

- **`search_teamboard_tasks`** — search tasks by keyword before creating (duplicate check). Returns task IDs and URLs.
- **`create_teamboard_task`** — create a task. Requires `title`, `projectCode` (e.g. `TB`), `type`, and `priority`. Optional: `description`, `assignee`, `dueDate`.

## Local setup (for development)

```bash
npm install
TEAMBOARD_BASE_URL=http://localhost:3000 TEAMBOARD_TOKEN=tbp_xxx node index.js
```
