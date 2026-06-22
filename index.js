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
const server = new McpServer({ name: 'teamboard', version: '0.3.0' });

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
      return `- ${t.taskId} — ${t.title}${t.status ? ` [${t.status}]` : ''}${proj ? ` (${proj})` : ''}\n  ${url}`;
    });
    return { content: [{ type: 'text', text: `Found ${tasks.length} task(s):\n${lines.join('\n')}` }] };
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(err => { console.error(err); process.exit(1); });
