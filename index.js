#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  api, enc, fetchVocab, isClear, normalizeValue,
  resolveProject, resolveTask, resolveUser,
  displayName, formatDate, stripHtml, taskUrl,
} from './resolve.js';

if (!process.env.TEAMBOARD_TOKEN) {
  console.error('TEAMBOARD_TOKEN env var is required (a tbp_ personal access token).');
  process.exit(1);
}

const vocab = await fetchVocab();
const listOr = (values, fallback) => (values.length ? values.join(', ') : fallback);
const typesText = listOr(vocab.taskTypes, 'Task, Bug, Feature, Story, Improvement, Epic');
const prioritiesText = listOr(vocab.priorities, 'Blocker, Critical, Highest, High, Medium, Low, Minor');
const statusesText = listOr(vocab.statuses, 'To Do, In Progress, Done, Closed');

const text = (s) => ({ content: [{ type: 'text', text: s }] });

const server = new McpServer({ name: 'teamboard', version: '0.5.0' });

// Every handler funnels its errors into one MCP error result — the resolvers'
// ambiguity messages ("matches 3 users: …") are the useful half of the output.
const tool = (spec, handler) => server.registerTool(spec.name, spec, async (args) => {
  try {
    return await handler(args);
  } catch (err) {
    return { content: [{ type: 'text', text: err.message || String(err) }], isError: true };
  }
});

const TASK_REF = z.string().describe('Task ID (TASK-42) or the task title — a title is looked up for you');
const HTML_NOTE = 'Rich text: pass literal HTML (<h3>, <ul>, <li>, <strong>, <code>, <p>), not plain text with newlines.';

tool(
  {
    name: 'search_teamboard_tasks',
    title: 'Search TeamBoard tasks',
    description: [
      'Find tasks. `query` searches title, description, tags, comments, assignee and project.',
      'The filters combine (AND), so "my open bugs in TB" is assignee + status + type + project — no query needed.',
      'Call BEFORE creating a task to check for duplicates. Results include task IDs and URLs.',
      `Statuses: ${statusesText}. Priorities: ${prioritiesText}. Types: ${typesText}.`,
    ].join(' '),
    inputSchema: {
      query: z.string().optional().describe('Keyword(s) to search for'),
      assignee: z.string().optional().describe('Person\'s name or email, or "me" for yourself'),
      project: z.string().optional().describe('Project code or name'),
      status: z.array(z.string()).optional().describe(`Any of: ${statusesText}`),
      priority: z.array(z.string()).optional().describe(`Any of: ${prioritiesText}`),
      type: z.array(z.string()).optional().describe(`Any of: ${typesText}`),
      dueBefore: z.string().optional().describe('Only tasks due on or before this date (YYYY-MM-DD)'),
      dueAfter: z.string().optional().describe('Only tasks due on or after this date (YYYY-MM-DD)'),
      jql: z.string().optional().describe(
        'Raw TeamBoard JQL for anything the filters above cannot express, e.g. '
        + 'status IN ("To Do", "In Progress") AND priority = High ORDER BY due ASC. '
        + 'Sortable fields are due, start, created, updated, priority, title, status, '
        + 'assignee — NOT the camelCase column names. The server reports its own errors.'
      ),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    },
  },
  async (args) => {
    // Array filters go over the wire JSON-encoded — the route does JSON.parse on each.
    const params = new URLSearchParams({ limit: String(args.limit ?? 10) });
    const addList = (key, values, allowed, label) => {
      if (!values?.length) return;
      params.set(key, JSON.stringify(values.map((v) => normalizeValue(v, allowed, label))));
    };

    if (args.query) params.set('search', args.query);
    if (args.jql) params.set('jql', args.jql);
    addList('status', args.status, vocab.statuses, 'status');
    addList('priority', args.priority, vocab.priorities, 'priority');
    addList('taskType', args.type, vocab.taskTypes, 'task type');
    if (args.assignee) params.set('assignedTo', JSON.stringify([await resolveUser(args.assignee)]));
    if (args.project) params.set('projectId', String((await resolveProject(args.project))._id));
    if (args.dueBefore) params.set('dueTo', args.dueBefore);
    if (args.dueAfter) params.set('dueFrom', args.dueAfter);

    if ([...params.keys()].length === 1) {
      throw new Error('Give me something to search on — a query, a filter, or jql.');
    }

    const data = await api(`/api/tasks?${params.toString()}`);
    const tasks = data?.allTasks ?? [];
    if (!tasks.length) return text('No tasks matched.');
    const lines = tasks.map((t) => {
      const proj = t.project?.title ? ` (${t.project.title})` : '';
      const who = t.assignee?.name ? ` → ${t.assignee.name}` : '';
      return `- ${t.taskId} — ${t.title}${t.status ? ` [${t.status}]` : ''}${proj}${who}\n  ${taskUrl(t.taskId)}`;
    });
    return text(`Found ${tasks.length} task(s):\n${lines.join('\n')}`);
  }
);

tool(
  {
    name: 'get_teamboard_task',
    title: 'Get TeamBoard task details',
    description: 'Fetch full details for one task — description, status, priority, type, project, assignee, reporters, watchers, dates, progress, tags, and optionally its comments.',
    inputSchema: {
      task: TASK_REF,
      withComments: z.boolean().optional().describe('Also include the comment thread'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    const reporters = (t.owners ?? []).map(displayName).filter(Boolean).join(', ');
    const watchers = (t.watchers ?? []).map(displayName).filter(Boolean).join(', ');
    const tags = (t.tags ?? []).map(displayName).filter(Boolean).join(', ');

    const lines = [
      `${t.taskId} — ${t.title}`,
      `Type: ${t.taskType || 'Task'}  Status: ${t.status || 'To Do'}  Priority: ${t.priority || 'None'}  Progress: ${t.progress ?? 0}%`,
      `Project: ${t.project?.title || 'None'}${t.project?.projectCode ? ` (${t.project.projectCode})` : ''}`,
      `Assignee: ${t.assignee?.name || 'Unassigned'}`,
      `Reporters: ${reporters || 'None'}`,
      ...(watchers ? [`Watchers: ${watchers}`] : []),
      `Start Date: ${formatDate(t.startDate)}`,
      `Due Date: ${formatDate(t.endDate)}`,
      ...(t.parentTask ? [`Parent: ${t.parentTask.taskId} — ${t.parentTask.title}`] : []),
      ...(tags ? [`Tags: ${tags}`] : []),
      '',
      'Description:',
      t.description ? stripHtml(t.description) : '(none)',
    ];

    if (args.withComments) {
      const data = await api(`/api/comments?taskId=${enc(t.taskId)}&limit=50`);
      const comments = data?.comments ?? (Array.isArray(data) ? data : []);
      lines.push('', `Comments (${comments.length}):`);
      for (const c of comments) {
        lines.push(`- ${displayName(c.author) || 'Unknown'} (${formatDate(c.createdAt)}): ${stripHtml(c.content || '')}`);
      }
      if (!comments.length) lines.push('(none)');
    }

    lines.push('', taskUrl(t.taskId));
    return text(lines.join('\n'));
  }
);

tool(
  {
    name: 'list_teamboard_projects',
    title: 'List TeamBoard projects',
    description: 'List the projects you can see, with their project codes — use this to find the code for create_teamboard_task.',
    inputSchema: {
      query: z.string().optional().describe('Filter by project name or code'),
    },
  },
  async (args) => {
    const { projects = [] } = await api(`/api/projects?search=${enc(args.query ?? '')}&limit=50`);
    if (!projects.length) return text('No projects found.');
    const lines = projects.map((p) => `- ${p.projectCode} — ${p.title}${p.status ? ` [${p.status}]` : ''}${p.isLocked ? ' (locked)' : ''}`);
    return text(`${projects.length} project(s):\n${lines.join('\n')}`);
  }
);

tool(
  {
    name: 'list_teamboard_users',
    title: 'List TeamBoard users',
    description: "Look up people by name or email. Pass `project` to list only that project's members — a task assignee must be a member of the task's project.",
    inputSchema: {
      query: z.string().optional().describe('Name, email or username fragment'),
      project: z.string().optional().describe("Project code or name — restricts the list to that project's members"),
    },
  },
  async (args) => {
    if (args.project) {
      const project = await resolveProject(args.project);
      const { members = [] } = await api(`/api/projects/${enc(project._id)}/members`);
      const q = args.query?.trim().toLowerCase();
      const rows = members
        .map((m) => ({ ...m.user, memberRole: m.role }))
        .filter((u) => !q || [u.name, u.email, u.username].some((v) => v?.toLowerCase().includes(q)));
      if (!rows.length) return text(`No members of ${project.projectCode} match that.`);
      const lines = rows.map((u) => `- ${u.name} <${u.email}>${u.memberRole ? ` [${u.memberRole}]` : ''}`);
      return text(`${rows.length} member(s) of ${project.projectCode} — ${project.title}:\n${lines.join('\n')}`);
    }
    const { users = [] } = await api(`/api/users?search=${enc(args.query ?? '')}&limit=50&userStatus=active`);
    if (!users.length) return text('No users found.');
    const lines = users.map((u) => `- ${u.name} <${u.email}>${u.position ? ` — ${u.position}` : ''}`);
    return text(`${users.length} user(s):\n${lines.join('\n')}`);
  }
);

tool(
  {
    name: 'create_teamboard_task',
    title: 'Create TeamBoard task',
    description: [
      'Create a task in TeamBoard.',
      'FIRST call search_teamboard_tasks to check for duplicates; if found, confirm with the user.',
      'Ask the user for: title, project, type and priority.',
      `Types: ${typesText}.`,
      `Priorities: ${prioritiesText}.`,
    ].join(' '),
    inputSchema: {
      title: z.string(),
      project: z.string().describe('Project code (e.g. TB, TP5) or project name'),
      type: z.string().describe(`One of: ${typesText}`),
      priority: z.string().describe(`One of: ${prioritiesText}`),
      description: z.string().optional().describe(HTML_NOTE),
      assignee: z.string().optional().describe("Person's name or email — must be a member of the project"),
      reporters: z.array(z.string()).optional().describe('Reporter names or emails (defaults to you)'),
      status: z.string().optional().describe(`One of: ${statusesText}`),
      startDate: z.string().optional().describe('YYYY-MM-DD or ISO datetime'),
      dueDate: z.string().optional().describe("YYYY-MM-DD or ISO datetime (the task's Due Date)"),
      tags: z.array(z.string()).optional().describe('Tag names (single words, case-sensitive)'),
    },
  },
  async (args) => {
    const project = await resolveProject(args.project);
    const taskData = {
      title: args.title,
      projectId: String(project._id),
      taskType: normalizeValue(args.type, vocab.taskTypes, 'task type'),
      priority: normalizeValue(args.priority, vocab.priorities, 'priority'),
      ...(args.status ? { status: normalizeValue(args.status, vocab.statuses, 'status') } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.assignee ? { assigneeId: await resolveUser(args.assignee, String(project._id)) } : {}),
      ...(args.reporters?.length
        ? { ownerIds: await Promise.all(args.reporters.map((r) => resolveUser(r))) }
        : {}),
      ...(args.startDate ? { startDate: args.startDate } : {}),
      ...(args.dueDate ? { endDate: args.dueDate } : {}),
      ...(args.tags?.length ? { tags: args.tags } : {}),
    };

    const form = new FormData();
    form.append('taskData', JSON.stringify(taskData));
    const task = await api('/api/tasks', { method: 'POST', body: form });

    if (!task?.taskId) throw new Error('Task created but no taskId returned.');
    return text(`Created ${task.taskId} in ${task.project?.title ?? project.title}\n${taskUrl(task.taskId)}`);
  }
);

tool(
  {
    name: 'edit_teamboard_task',
    title: 'Edit TeamBoard task',
    description: [
      'Update any field of an existing task. Identify the task by ID (TASK-42) or by title.',
      'People and projects are given by name — no IDs needed.',
      `Statuses: ${statusesText}. Priorities: ${prioritiesText}. Types: ${typesText}.`,
      'Pass "none" to assignee/project/parent/type to clear it.',
    ].join(' '),
    inputSchema: {
      task: TASK_REF,
      title: z.string().optional(),
      description: z.string().optional().describe(`Replaces the description. ${HTML_NOTE}`),
      status: z.string().optional().describe(`One of: ${statusesText}`),
      priority: z.string().optional().describe(`One of: ${prioritiesText}`),
      type: z.string().optional().describe(`One of: ${typesText}, or "none"`),
      assignee: z.string().optional().describe('Person\'s name or email, or "none" to unassign. Must be a project member.'),
      reporters: z.array(z.string()).optional().describe('Replaces the reporter list (names or emails)'),
      startDate: z.string().optional().describe('YYYY-MM-DD or ISO datetime'),
      dueDate: z.string().optional().describe("YYYY-MM-DD or ISO datetime (the task's Due Date)"),
      progress: z.number().int().min(0).max(100).optional(),
      tags: z.array(z.string()).optional().describe('REPLACES all tags on the task'),
      project: z.string().optional().describe('Move to this project (code or name), or "none" to detach. Changes the task ID.'),
      parent: z.string().optional().describe('Parent task ID or title, or "none" to unlink'),
      addWatcher: z.string().optional().describe('Person to start watching the task'),
      removeWatcher: z.string().optional().describe('Person to stop watching the task'),
      clarification: z.string().optional().describe('Required (10+ chars, 2+ words) when moving an active task to In Progress or changing its due date'),
      trackerDecision: z.enum(['foreground', 'background', 'foreground_demote', 'foreground_stop']).optional()
        .describe('Only if the server reports the assignee already has a running timer'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    const form = new FormData();
    const changed = [];
    const set = (key, value, label) => { form.append(key, value); changed.push(label ?? key); };

    // The task's project decides who may be assigned; a project move in the same
    // call moves that goalpost, so resolve the new project first.
    let projectId = t.project?._id ? String(t.project._id) : undefined;
    if (args.project !== undefined) {
      if (isClear(args.project)) {
        projectId = undefined;
        set('projectId', '__none__', 'project');
      } else {
        const project = await resolveProject(args.project);
        projectId = String(project._id);
        set('projectId', projectId, 'project');
      }
    }

    if (args.title !== undefined) set('title', args.title);
    if (args.description !== undefined) set('description', args.description);
    if (args.status !== undefined) set('status', normalizeValue(args.status, vocab.statuses, 'status'));
    if (args.priority !== undefined) set('priority', normalizeValue(args.priority, vocab.priorities, 'priority'));
    if (args.type !== undefined) {
      set('taskType', isClear(args.type) ? '__none__' : normalizeValue(args.type, vocab.taskTypes, 'task type'), 'type');
    }
    if (args.assignee !== undefined) {
      set('assigneeId', isClear(args.assignee) ? '__none__' : await resolveUser(args.assignee, projectId), 'assignee');
    }
    if (args.reporters !== undefined) {
      const ids = await Promise.all(args.reporters.map((r) => resolveUser(r)));
      set('ownerIds', JSON.stringify(ids), 'reporters');
    }
    if (args.startDate !== undefined) set('startDate', args.startDate, 'start date');
    if (args.dueDate !== undefined) set('endDate', args.dueDate, 'due date');
    if (args.progress !== undefined) set('progress', String(args.progress));
    if (args.tags !== undefined) set('tags', JSON.stringify(args.tags), 'tags');
    if (args.parent !== undefined) {
      set('parentTaskId', isClear(args.parent) ? '__none__' : String((await resolveTask(args.parent))._id), 'parent');
    }
    if (args.addWatcher !== undefined) set('watcherAdd', await resolveUser(args.addWatcher), 'watchers');
    if (args.removeWatcher !== undefined) set('watcherRemove', await resolveUser(args.removeWatcher), 'watchers');
    if (args.clarification !== undefined) form.append('clarification', args.clarification);
    if (args.trackerDecision !== undefined) form.append('trackerDecision', args.trackerDecision);

    if (!changed.length) throw new Error('Nothing to update — pass at least one field to change.');

    const updated = await api(`/api/tasks/${enc(t.taskId)}`, { method: 'PATCH', body: form });
    const taskId = updated?.taskId || t.taskId;
    return text(`Updated ${taskId} (${[...new Set(changed)].join(', ')}).\n${taskUrl(taskId)}`);
  }
);

tool(
  {
    name: 'comment_teamboard_task',
    title: 'Comment on a TeamBoard task',
    description: `Post a comment on a task. ${HTML_NOTE}`,
    inputSchema: {
      task: TASK_REF,
      comment: z.string().describe(`The comment body. ${HTML_NOTE}`),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    await api('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: t.taskId, content: args.comment }),
    });
    return text(`Commented on ${t.taskId}.\n${taskUrl(t.taskId)}`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => { console.error(err); process.exit(1); });
