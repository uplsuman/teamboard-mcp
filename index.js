#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = (process.env.TEAMBOARD_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.TEAMBOARD_TOKEN;

if (!TOKEN) {
  console.error('TEAMBOARD_TOKEN env var is required (a tbp_ personal access token).');
  process.exit(1);
}

const authHeaders = { Authorization: `Bearer ${TOKEN}` };``

// ── startup: fetch static options once ───────────────────────────────────────
async function fetchTaskOptions() {
  const res = await fetch(`${BASE_URL}/api/tasks/meta`, { headers: authHeaders });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) return { taskTypes: [], priorities: [] };
  return { taskTypes: json.data?.taskTypes ?? [], priorities: json.data?.priorities ?? [] };
}

const { taskTypes, priorities } = await fetchTaskOptions();
const typesText = taskTypes.length ? taskTypes.join(', ') : 'Task, Bug, Feature, Story, Improvement, Epic';
const prioritiesText = priorities.length ? priorities.join(', ') : 'Blocker, Critical, Highest, High, Medium, Low, Minor';

// ── server ────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'teamboard', version: '0.4.0' });

server.registerTool(
  'search_teamboard_tasks',
  {
    title: 'Search TeamBoard tasks',
    description: 'Search tasks by keyword (title). Call BEFORE creating to check for duplicates. Results include task URLs.',
    inputSchema: {
      query: z.string().describe('Keyword(s) to search for'),
    },
  },
  async (args) => {
    const params = new URLSearchParams({ search: args.query, limit: '10' });
    const res = await fetch(`${BASE_URL}/api/tasks?${params.toString()}`, { headers: authHeaders });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.message || `GET /api/tasks failed (${res.status})`);
    const d = json.data;
    const tasks = Array.isArray(d) ? d : (d?.allTasks ?? d?.tasks ?? d?.items ?? []);

    if (!tasks.length) {
      return { content: [{ type: 'text', text: `No tasks found matching "${args.query}".` }] };
    }
    const lines = tasks.map((t) => {
      const proj = t.project && typeof t.project === 'object' ? (t.project.title ?? t.project.name) : undefined;
      const url = `${BASE_URL}/task?id=${t.taskId}`;
      return `- ${t.taskId} — ${t.title}${t.status ? ` [${t.status}]` : ''}${proj ? ` (${proj})` : ''} [DB_ID: ${t._id}]\n  ${url}`;
    });
    return { content: [{ type: 'text', text: `Found ${tasks.length} task(s):\n${lines.join('\n')}` }] };
  }
);

const stripHtml = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const formatDate = (iso) => {
  if (!iso) return 'Not provided';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Not provided';
  // A due date landing exactly on midnight has no meaningful time set (TB-041 default).
  const hasTime = !(d.getHours() === 23 && d.getMinutes() === 59) && !(d.getHours() === 0 && d.getMinutes() === 0);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    ...(hasTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
};

server.registerTool(
  'get_teamboard_task',
  {
    title: 'Get TeamBoard task details',
    description: 'Fetch full details for a single TeamBoard task by ID — description, status, priority, type, project, assignee, reporters, dates, progress, and tags.',
    inputSchema: {
      taskId: z.string().describe('The task ID (e.g. TB-042) or database ObjectId'),
    },
  },
  async (args) => {
    const res = await fetch(`${BASE_URL}/api/tasks/${args.taskId}`, { headers: authHeaders });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      return { content: [{ type: 'text', text: `Fetch failed (${res.status}): ${json.message || 'unknown error'}` }], isError: true };
    }
    const t = json.data;
    const url = `${BASE_URL}/task?id=${t.taskId}`;
    const project = t.project && typeof t.project === 'object' ? (t.project.title ?? t.project.projectCode) : undefined;
    const assignee = t.assignee && typeof t.assignee === 'object' ? t.assignee.name : undefined;
    const reporters = Array.isArray(t.owners) ? t.owners.map((o) => (typeof o === 'object' ? o.name : o)).join(', ') : undefined;
    const parent = t.parentTask && typeof t.parentTask === 'object' ? `${t.parentTask.taskId} — ${t.parentTask.title}` : undefined;
    const tags = Array.isArray(t.tags) ? t.tags.map((tag) => (typeof tag === 'object' ? tag.name : tag)).join(', ') : undefined;

    const lines = [
      `${t.taskId} — ${t.title}`,
      `Type: ${t.taskType || 'Task'}  Status: ${t.status || 'To Do'}  Priority: ${t.priority || 'None'}  Progress: ${t.progress ?? 0}%`,
      `Project: ${project || 'None'}`,
      `Assignee: ${assignee || 'Unassigned'}`,
      `Reporters: ${reporters || 'None'}`,
      `Start Date: ${formatDate(t.startDate)}`,
      `Due Date: ${formatDate(t.endDate)}`,
      ...(parent ? [`Parent: ${parent}`] : []),
      ...(tags ? [`Tags: ${tags}`] : []),
      '',
      'Description:',
      t.description ? stripHtml(t.description) : '(none)',
      '',
      url,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.registerTool(
  'create_teamboard_task',
  {
    title: 'Create TeamBoard task',
    description: [
      'Create a task in TeamBoard.',
      'FIRST call search_teamboard_tasks to check for duplicates; if found, confirm with the user.',
      'Ask the user to provide: title, projectCode (the short code shown next to the project name, e.g. TB, TP5), type, and priority.',
      `Types: ${typesText}.`,
      `Priorities: ${prioritiesText}.`,
    ].join(' '),
    inputSchema: {
      title: z.string(),
      projectCode: z.string().describe('Project code, e.g. TB or TP5'),
      type: z.string().describe(`One of: ${typesText}`),
      priority: z.string().describe(`One of: ${prioritiesText}`),
      description: z.string().optional(),
      assignee: z.string().optional().describe('User id to assign'),
      dueDate: z.string().optional().describe('Due date ISO string, maps to task end date'),
    },
  },
  async (args) => {
    const taskData = {
      title: args.title,
      projectCode: args.projectCode,
      taskType: args.type,
      priority: args.priority,
      ...(args.description ? { description: args.description } : {}),
      ...(args.assignee ? { assigneeId: args.assignee } : {}),
      ...(args.dueDate ? { endDate: args.dueDate } : {}),
    };

    const form = new FormData();
    form.append('taskData', JSON.stringify(taskData));

    const res = await fetch(`${BASE_URL}/api/tasks`, { method: 'POST', headers: authHeaders, body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      return { content: [{ type: 'text', text: `Create failed (${res.status}): ${json.message || 'unknown error'}` }], isError: true };
    }
    const task = json.data;
    const taskId = task?.taskId;
    if (!taskId) {
      return { content: [{ type: 'text', text: 'Task created but no taskId returned.' }], isError: true };
    }
    const projectTitle = task?.project?.title ?? args.projectCode;
    const url = `${BASE_URL}/task?id=${taskId}`;
    return { content: [{ type: 'text', text: `Created ${taskId} in ${projectTitle}\n${url}` }] };
  }
);

server.registerTool(
  'edit_teamboard_task',
  {
    title: 'Edit TeamBoard task',
    description: 'Edit a task in TeamBoard. You can update the title and/or description of the task.',
    inputSchema: {
      taskId: z.string().describe('The ID of the task to edit (e.g. TASK-123 or database ObjectId)'),
      title: z.string().optional().describe('The new title for the task'),
      description: z.string().optional().describe('The new description for the task'),
    },
  },
  async (args) => {
    if (!args.title && !args.description) {
      return {
        content: [{ type: 'text', text: 'Error: You must provide at least a title or a description to update.' }],
        isError: true,
      };
    }

    const form = new FormData();
    if (args.title) form.append('title', args.title);
    if (args.description) form.append('description', args.description);

    const res = await fetch(`${BASE_URL}/api/tasks/${args.taskId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: form,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      return {
        content: [{ type: 'text', text: `Edit failed (${res.status}): ${json.message || 'unknown error'}` }],
        isError: true,
      };
    }

    const task = json.data;
    const taskId = task?.taskId || args.taskId;
    const url = `${BASE_URL}/task?id=${taskId}`;
    return {
      content: [{ type: 'text', text: `Task ${taskId} updated successfully.\n${url}` }]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(err => { console.error(err); process.exit(1); });
