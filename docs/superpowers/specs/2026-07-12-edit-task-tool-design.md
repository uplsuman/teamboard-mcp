# Design Spec: edit_teamboard_task MCP Tool

## Context
The TeamBoard MCP server currently supports task creation and searching, but lacks the ability to edit/update existing tasks. This design introduces the `edit_teamboard_task` tool, allowing AI assistants to edit a task's `title` and/or `description`.

## Proposed Solution
Register a new tool `edit_teamboard_task` in the `teamboard` MCP server. The tool will target the `PATCH /api/tasks/[taskId]` endpoint of the TeamBoard API.

### Tool Definition
- **Name:** `edit_teamboard_task`
- **Description:** `Edit a task in TeamBoard. You can update the title and/or description of the task.`
- **Input Schema:**
  - `taskId` (string, required): The ID of the task to edit.
  - `title` (string, optional): The new title for the task.
  - `description` (string, optional): The new description for the task.

### Implementation Logic
1. Verify that at least one of `title` or `description` is provided in the input arguments. If both are omitted, return an error.
2. Initialize `FormData`.
3. If `title` is provided, append it to the `FormData` object.
4. If `description` is provided, append it to the `FormData` object.
5. Send a `PATCH` request to `${BASE_URL}/api/tasks/${taskId}` with the `FormData` payload and authorization headers.
6. Handle response:
   - On success (`success: true`), return a message indicating the task was updated successfully along with the updated task URL.
   - On failure, throw or return an error message containing the API failure status/message.

## Verification Plan
1. Call the new `edit_teamboard_task` tool to update a task's title.
2. Call the new `edit_teamboard_task` tool to update a task's description.
3. Call the new `edit_teamboard_task` tool with both title and description.
4. Verify error handling when neither title nor description is provided.
