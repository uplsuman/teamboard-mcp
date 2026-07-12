# edit_teamboard_task MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `edit_teamboard_task` MCP tool to the TeamBoard MCP server to support editing a task's title and description.

**Architecture:** Register `edit_teamboard_task` in `teamboard-mcp/index.js` using `@modelcontextprotocol/sdk/server/mcp.js`. It will perform a `PATCH` request using `FormData` to `${BASE_URL}/api/tasks/[taskId]`.

**Tech Stack:** Node.js (ESM), `@modelcontextprotocol/sdk`, `zod`.

## Global Constraints
- Node version >= 18.
- Use `FormData` to send the payload to the TeamBoard API.
- Require either `title` or `description` to be provided.
- Always use `file://` scheme markdown links for files and classes/functions.

---

### Task 1: Add edit_teamboard_task Tool to index.js

**Files:**
- Modify: `index.js:60-110`

**Interfaces:**
- Consumes: `BASE_URL` and `authHeaders` from `index.js`.
- Produces: `edit_teamboard_task` MCP tool.

- [ ] **Step 1: Write the tool registration and logic in index.js**
  We will add the new tool registration inside `index.js` after the `create_teamboard_task` tool.

- [ ] **Step 2: Commit changes**
  Run:
  ```bash
  git add index.js
  git commit -m "feat: add edit_teamboard_task tool to MCP server"
  ```

---

### Task 2: Verification

**Files:**
- Create: `scratch/test_edit_task.js`

**Interfaces:**
- Consumes: The `edit_teamboard_task` tool or its underlying API call logic.

- [ ] **Step 1: Create a test script**
  Create a temporary node script that tests the `PATCH` endpoint or imports and verifies the tool logic directly.
  
- [ ] **Step 2: Run the test script and verify**
  Run:
  ```bash
  node scratch/test_edit_task.js
  ```
  Expected: Outputs verification results for title and description updates.

- [ ] **Step 3: Remove the scratch file**
  Run:
  ```bash
  rm scratch/test_edit_task.js
  ```
