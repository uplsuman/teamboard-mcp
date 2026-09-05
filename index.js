#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  api, apiRaw, attachmentPath, enc, fetchVocab, isClear, normalizeValue, pickOne,
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

// An activity's old/new value is whatever the field held: rich-text HTML for a
// description or comment, and an object for a link. Interpolating it straight in
// printed raw markup and "[object Object]".
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json',
  zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeFor = (name) => MIME_BY_EXT[name.split('.').pop()?.toLowerCase()] || 'application/octet-stream';

// Durations come back in seconds.
const formatDuration = (secs) => {
  const total = Math.round((secs ?? 0) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};

function historyValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  const flat = typeof value === 'object' ? JSON.stringify(value) : stripHtml(String(value));
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

// Saved filters are addressed by name; the API maps _id → id in its responses.
async function listFilters() {
  const data = await api('/api/saved-filters');
  return data?.filters ?? (Array.isArray(data) ? data : []);
}

async function resolveFilter(name) {
  const rows = await listFilters();
  const hit = pickOne(rows, name, ['name']);
  if (!hit) {
    throw new Error(`No single saved filter matches "${name}".`
      + (rows.length ? `\nYours:\n${rows.map((f) => `- ${f.name}`).join('\n')}` : ''));
  }
  return hit;
}

// Attachments are addressed by name, not by the storage url the caller cannot know.
// Deleting the wrong file is unrecoverable, so an ambiguous name lists instead.
function pickAttachment(task, name) {
  const docs = task.documents ?? [];
  if (!docs.length) throw new Error(`${task.taskId} has no attachments.`);
  const low = String(name).trim().toLowerCase();
  const key = (d) => d.url?.split('/').pop() ?? '';
  const exact = docs.filter((d) => d.name?.toLowerCase() === low || key(d).toLowerCase() === low);
  const partial = docs.filter((d) => d.name?.toLowerCase().includes(low) || key(d).toLowerCase().includes(low));
  const hit = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : null;
  if (!hit) {
    // Two files can share a name, so list the unique storage key alongside it —
    // that is what disambiguates them.
    throw new Error(`"${name}" matches ${partial.length || docs.length} attachments on ${task.taskId}:\n`
      + docs.map((d) => `- ${d.name}  (key: ${key(d)})`).join('\n'));
  }
  return hit;
}

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
      savedFilter: z.string().optional()
        .describe('Run a saved filter by name (list them with list_teamboard_filters). Its JQL is used unless `jql` is also given.'),
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

    // An explicit jql wins, so "run my filter but only High priority" stays possible
    // by combining savedFilter with the plain filters below.
    const savedJql = args.savedFilter ? (await resolveFilter(args.savedFilter)).filters?.jql : undefined;
    const jql = args.jql ?? savedJql;
    if (args.savedFilter && !savedJql && !args.jql) {
      throw new Error(`Saved filter "${args.savedFilter}" has no JQL stored — it was built with the visual filter UI.`);
    }
    if (jql) params.set('jql', jql);
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
    description: [
      'Fetch one task: description, status, priority, type, project, assignee, reporters,',
      'watchers, dates, progress, tags — plus any of its comments, subtasks, linked tasks,',
      'attachments or change history via `include` (each costs one extra request).',
      'Comment ids are printed so they can be passed to edit/delete.',
    ].join(' '),
    inputSchema: {
      task: TASK_REF,
      include: z.array(z.enum(['comments', 'subtasks', 'links', 'attachments', 'history', 'time']))
        .optional().describe('Extra sections to load'),
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

    const want = new Set(args.include ?? []);
    const section = (label, rows) => {
      lines.push('', `${label} (${rows.length}):`, ...(rows.length ? rows : ['(none)']));
    };

    if (want.has('comments')) {
      const data = await api(`/api/comments?taskId=${enc(t.taskId)}&limit=50`);
      const comments = data?.comments ?? (Array.isArray(data) ? data : []);
      section('Comments', comments.flatMap((c) => [
        // The id is what edit_teamboard_comment / delete_teamboard_comment need.
        `- [${c._id}] ${displayName(c.author) || 'Unknown'} (${formatDate(c.createdAt)}): ${stripHtml(c.content || '')}`,
        ...(c.replies ?? []).map((r) => `    ↳ [${r._id}] ${displayName(r.author) || 'Unknown'}: ${stripHtml(r.content || '')}`),
      ]));
    }

    if (want.has('subtasks')) {
      const subtasks = await api(`/api/tasks/${enc(t.taskId)}/subtasks`);
      section('Subtasks', (subtasks ?? []).map((st) =>
        `- ${st.taskId} — ${st.title} [${st.status}]${st.assignee?.name ? ` → ${st.assignee.name}` : ''} ${st.progress ?? 0}%`));
    }

    if (want.has('links')) {
      const links = await api(`/api/tasks/${enc(t.taskId)}/links`);
      section('Linked tasks', (links ?? []).map((l) =>
        `- ${l.linkType.replace(/_/g, ' ')}: ${l.task?.taskId} — ${l.task?.title} [${l.task?.status}]`));
    }

    if (want.has('attachments')) {
      section('Attachments', (t.documents ?? []).map((d) =>
        `- ${d.name} (${d.fileType || 'file'}, ${Math.round((d.size ?? 0) / 1024)} KB, added ${formatDate(d.uploadedAt)})`));
    }

    if (want.has('history')) {
      const activities = await api(`/api/tasks/${enc(t.taskId)}/activities?limit=30`);
      section('History', (activities ?? []).map((a) => {
        const change = a.meta?.field
          ? ` (${a.meta.field}: ${historyValue(a.meta.oldValue)} → ${historyValue(a.meta.newValue)})`
          : '';
        return `- ${formatDate(a.createdAt)} ${displayName(a.actor) || 'Someone'}: ${a.message}${change}`;
      }));
    }

    if (want.has('time')) {
      const data = await api(`/api/tasks/${enc(t.taskId)}/time-logs`);
      const logs = data?.logs ?? (Array.isArray(data) ? data : []);
      section('Time logs', logs.map((l) =>
        `- ${formatDuration(l.duration)} ${displayName(l.user) || ''} ${formatDate(l.startTime)}`
        + `${l.isManual ? ' (manual)' : ''}${l.approvalStatus && l.approvalStatus !== 'approved' ? ` [${l.approvalStatus}]` : ''}`
        + `${l.description ? ` — ${stripHtml(l.description)}` : ''}`));
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
      replyTo: z.string().optional()
        .describe('Comment id to reply to — makes this a threaded reply instead of a new top-level comment. Ids come from get_teamboard_task include: ["comments"].'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    await api('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: t.taskId,
        content: args.comment,
        ...(args.replyTo ? { parentId: args.replyTo } : {}),
      }),
    });
    return text(`${args.replyTo ? 'Replied' : 'Commented'} on ${t.taskId}.\n${taskUrl(t.taskId)}`);
  }
);

const LINK_TYPES = [
  'blocks', 'blocked_by', 'clones', 'cloned_by', 'splits_into', 'splits_from',
  'causes', 'caused_by', 'duplicate_of', 'relates_to',
];

tool(
  {
    name: 'create_teamboard_subtask',
    title: 'Create a TeamBoard subtask',
    description: `Add a subtask under an existing task. It inherits the parent's project. Types: ${typesText}. Priorities: ${prioritiesText}.`,
    inputSchema: {
      parent: TASK_REF,
      title: z.string(),
      description: z.string().optional().describe(HTML_NOTE),
      type: z.string().optional().describe(`One of: ${typesText} (default Task)`),
      priority: z.string().optional().describe(`One of: ${prioritiesText}`),
      assignee: z.string().optional().describe("Person's name or email — must be a member of the parent's project"),
      dueDate: z.string().optional().describe('YYYY-MM-DD or ISO datetime'),
    },
  },
  async (args) => {
    const parent = await resolveTask(args.parent);
    const projectId = parent.project?._id ? String(parent.project._id) : undefined;

    const subtaskData = {
      title: args.title,
      taskType: args.type ? normalizeValue(args.type, vocab.taskTypes, 'task type') : 'Task',
      ...(args.priority ? { priority: normalizeValue(args.priority, vocab.priorities, 'priority') } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.assignee ? { assigneeId: await resolveUser(args.assignee, projectId) } : {}),
      ...(args.dueDate ? { endDate: args.dueDate } : {}),
    };

    // FormData with a JSON blob, same shape as task creation.
    const form = new FormData();
    form.append('subtaskData', JSON.stringify(subtaskData));
    const created = await api(`/api/tasks/${enc(parent.taskId)}/subtasks`, { method: 'POST', body: form });

    const id = created?.taskId ?? created?.subtask?.taskId;
    return text(`Created subtask ${id ?? '(id not returned)'} under ${parent.taskId}.\n${taskUrl(id ?? parent.taskId)}`);
  }
);

tool(
  {
    name: 'link_teamboard_tasks',
    title: 'Link two TeamBoard tasks',
    description: `Create a typed relationship between two tasks. The inverse link is implied — linking A blocks B means B is blocked_by A. Types: ${LINK_TYPES.join(', ')}.`,
    inputSchema: {
      task: TASK_REF,
      target: z.string().describe('The other task — ID or title'),
      type: z.enum(LINK_TYPES).describe('How `task` relates TO `target`'),
    },
  },
  async (args) => {
    const [from, to] = [await resolveTask(args.task), await resolveTask(args.target)];
    await api(`/api/tasks/${enc(from.taskId)}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkType: args.type, targetTaskId: to.taskId }),
    });
    return text(`${from.taskId} ${args.type.replace(/_/g, ' ')} ${to.taskId}.\n${taskUrl(from.taskId)}`);
  }
);

tool(
  {
    name: 'unlink_teamboard_tasks',
    title: 'Remove a link between TeamBoard tasks',
    description: 'Remove the relationship between two tasks, whichever direction it was created in.',
    inputSchema: {
      task: TASK_REF,
      target: z.string().describe('The task on the other end of the link — ID or title'),
    },
  },
  async (args) => {
    const [from, to] = [await resolveTask(args.task), await resolveTask(args.target)];
    const links = (await api(`/api/tasks/${enc(from.taskId)}/links`)) ?? [];
    const hit = links.find((l) => l.task?.taskId === to.taskId);
    if (!hit) {
      const listed = links.map((l) => `- ${l.linkType}: ${l.task?.taskId}`).join('\n');
      throw new Error(`${from.taskId} has no link to ${to.taskId}.${listed ? `\nExisting links:\n${listed}` : ''}`);
    }
    await api(`/api/tasks/${enc(from.taskId)}/links/${enc(hit._id)}`, { method: 'DELETE' });
    return text(`Removed the link between ${from.taskId} and ${to.taskId}.`);
  }
);

tool(
  {
    name: 'edit_teamboard_comment',
    title: 'Edit a TeamBoard comment',
    description: `Rewrite one of your own comments (an admin may edit any). Get the id from get_teamboard_task with include: ["comments"]. ${HTML_NOTE}`,
    inputSchema: {
      commentId: z.string().describe('The comment id shown in square brackets by get_teamboard_task'),
      comment: z.string().describe(`The replacement text. ${HTML_NOTE}`),
    },
  },
  async (args) => {
    await api(`/api/comments/${enc(args.commentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: args.comment }),
    });
    return text('Comment updated.');
  }
);

tool(
  {
    name: 'delete_teamboard_comment',
    title: 'Delete a TeamBoard comment',
    description: 'Delete one of your own comments (an admin may delete any). Get the id from get_teamboard_task with include: ["comments"].',
    inputSchema: {
      commentId: z.string().describe('The comment id shown in square brackets by get_teamboard_task'),
    },
  },
  async (args) => {
    await api(`/api/comments/${enc(args.commentId)}`, { method: 'DELETE' });
    return text('Comment deleted.');
  }
);

tool(
  {
    name: 'add_teamboard_attachment',
    title: 'Attach a file to a TeamBoard task',
    description: 'Upload a local file and attach it to a task.',
    inputSchema: {
      task: TASK_REF,
      filePath: z.string().describe('Absolute path of the local file to upload'),
      name: z.string().optional().describe('Name to store it under (defaults to the file name)'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    const bytes = await readFile(args.filePath);
    const filename = args.name || basename(args.filePath);

    // The task PATCH takes attachments in a `file` field, alongside any other edit.
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeFor(filename) }), filename);
    await api(`/api/tasks/${enc(t.taskId)}`, { method: 'PATCH', body: form });

    return text(`Attached ${filename} to ${t.taskId}.\n${taskUrl(t.taskId)}`);
  }
);

tool(
  {
    name: 'download_teamboard_attachment',
    title: 'Download a TeamBoard attachment',
    description: 'Save a task attachment to a local file. List them with get_teamboard_task include: ["attachments"].',
    inputSchema: {
      task: TASK_REF,
      name: z.string().describe('Attachment name, or any distinctive part of it'),
      saveTo: z.string().optional().describe('Directory to save into (defaults to the current directory)'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    const doc = pickAttachment(t, args.name);
    const res = await apiRaw(attachmentPath(doc.url));
    const target = join(args.saveTo || process.cwd(), basename(doc.name));
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
    return text(`Saved ${doc.name} from ${t.taskId} to ${target}`);
  }
);

tool(
  {
    name: 'delete_teamboard_attachment',
    title: 'Remove a TeamBoard attachment',
    description: 'Detach a file from a task and delete it from storage.',
    inputSchema: {
      task: TASK_REF,
      name: z.string().describe('Attachment name, or any distinctive part of it'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    const doc = pickAttachment(t, args.name);

    const form = new FormData();
    form.append('deleteAttachment', doc.url);
    await api(`/api/tasks/${enc(t.taskId)}`, { method: 'PATCH', body: form });

    return text(`Removed ${doc.name} from ${t.taskId}.`);
  }
);

tool(
  {
    name: 'log_teamboard_time',
    title: 'Log time on a TeamBoard task',
    description: 'Record work already done. Manual entries start as PENDING approval — only approved time counts toward a task total. Minimum one minute.',
    inputSchema: {
      task: TASK_REF,
      minutes: z.number().int().min(1).describe('How long the work took, in minutes'),
      description: z.string().optional().describe('What was done'),
      startedAt: z.string().optional().describe('When the work started (ISO datetime; defaults to now)'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    const startTime = args.startedAt ? new Date(args.startedAt) : new Date();
    const endTime = new Date(startTime.getTime() + args.minutes * 60_000);

    await api(`/api/tasks/${enc(t.taskId)}/time-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The API takes SECONDS.
      body: JSON.stringify({
        duration: args.minutes * 60,
        description: args.description ?? '',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      }),
    });
    return text(`Logged ${formatDuration(args.minutes * 60)} on ${t.taskId} (pending approval).\n${taskUrl(t.taskId)}`);
  }
);

tool(
  {
    name: 'start_teamboard_timer',
    title: 'Start the timer on a TeamBoard task',
    description: 'Start tracking time. You can only run one foreground timer at a time — starting another pauses it. Note that moving a task INTO an in-progress status starts its timer automatically, so this is for tracking without a status change.',
    inputSchema: {
      task: TASK_REF,
      mode: z.enum(['foreground', 'background']).optional()
        .describe('background runs alongside your foreground timer (default foreground)'),
      trackerDecision: z.enum(['foreground', 'background', 'foreground_demote', 'foreground_stop']).optional()
        .describe('Only if the server reports you already have a timer running'),
    },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    await api(`/api/tasks/${enc(t.taskId)}/time-logs/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.trackerDecision ? { trackerDecision: args.trackerDecision } : {}),
      }),
    });
    return text(`Timer running on ${t.taskId}.\n${taskUrl(t.taskId)}`);
  }
);

tool(
  {
    name: 'stop_teamboard_timer',
    title: 'Stop the timer on a TeamBoard task',
    description: 'Pause tracking and bank the elapsed time. Segments under a minute are discarded.',
    inputSchema: { task: TASK_REF },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    await api(`/api/tasks/${enc(t.taskId)}/time-logs/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return text(`Timer stopped on ${t.taskId}.\n${taskUrl(t.taskId)}`);
  }
);

tool(
  {
    name: 'my_teamboard_timers',
    title: 'What am I tracking right now',
    description: 'List your running timers — foreground, background and project-level.',
    inputSchema: {},
  },
  async () => {
    const data = await api('/api/trackers');
    const rows = [
      ...(data?.foreground ? [{ ...data.foreground, kind: 'foreground' }] : []),
      ...(data?.background ?? []).map((r) => ({ ...r, kind: 'background' })),
      ...(data?.projects ?? []).map((r) => ({ ...r, kind: 'project' })),
    ];
    if (!rows.length) return text('Nothing is being tracked right now.');
    // A tracker row nests its subject: { task: {taskId, title} } or { project: {...} }.
    return text(rows.map((r) => {
      const what = r.task?.taskId
        ? `${r.task.taskId} — ${r.task.title}`
        : r.project
          ? `${r.project.projectCode} — ${r.project.title} (project)`
          : '(no subject)';
      return `- [${r.kind}] ${what} — ${formatDuration(r.elapsedSecs)} so far, since ${formatDate(r.startTime)}`;
    }).join('\n'));
  }
);

tool(
  {
    name: 'list_teamboard_tags',
    title: 'List TeamBoard tags',
    description: 'The tag vocabulary in use across the workspace. Tag names are case-sensitive — reuse one from here rather than inventing a variant.',
    inputSchema: {},
  },
  async () => {
    const tags = await api('/api/tasks/tags');
    const names = (Array.isArray(tags) ? tags : tags?.tags ?? []).map((t) => t.name ?? t).filter(Boolean);
    if (!names.length) return text('No tags yet.');
    return text(`${names.length} tag(s):\n${names.map((n) => `- ${n}`).join('\n')}`);
  }
);

tool(
  {
    name: 'search_teamboard',
    title: 'Search all of TeamBoard',
    description: 'One query across tasks, projects, people, departments and saved filters. Use search_teamboard_tasks when you only want tasks and want to filter them.',
    inputSchema: { query: z.string().describe('What to look for') },
  },
  async (args) => {
    const d = await api(`/api/search?q=${enc(args.query)}`);
    const blocks = [
      ['Tasks', (d?.tasks ?? []).map((t) =>
        `- ${t.taskId} — ${t.title}${t.status ? ` [${t.status}]` : ''}${t.project?.title ? ` (${t.project.title})` : ''}`)],
      // Global search returns `code`, not `projectCode` like /api/projects does.
      ['Projects', (d?.projects ?? []).map((p) => `- ${p.code ? `${p.code} — ` : ''}${p.title}`)],
      ['People', (d?.people ?? []).map((u) => `- ${u.name}${u.email ? ` <${u.email}>` : ''}`)],
      ['Departments', (d?.departments ?? []).map((x) => `- ${x.name}`)],
      ['Saved filters', (d?.filters ?? []).map((f) => `- ${f.name}`)],
    ].filter(([, rows]) => rows.length);

    if (!blocks.length) return text(`Nothing matched "${args.query}".`);
    return text(blocks.map(([label, rows]) => `${label}:\n${rows.join('\n')}`).join('\n\n'));
  }
);

tool(
  {
    name: 'list_teamboard_filters',
    title: 'List saved filters',
    description: 'Your saved task filters and any shared with you. Run one with search_teamboard_tasks { savedFilter: "<name>" }.',
    inputSchema: {},
  },
  async () => {
    const rows = await listFilters();
    if (!rows.length) return text('No saved filters.');
    return text(rows.map((f) =>
      `- ${f.name}${f.description ? ` — ${f.description}` : ''}${f.filters?.jql ? `\n  ${f.filters.jql}` : ''}`
    ).join('\n'));
  }
);

tool(
  {
    name: 'save_teamboard_filter',
    title: 'Save a filter',
    description: 'Store a JQL query under a name so it can be run again. Saving over an existing name replaces its query.',
    inputSchema: {
      name: z.string().describe('What to call it'),
      jql: z.string().describe('The JQL this filter runs, e.g. assignee = currentUser() AND status = "In Progress"'),
      description: z.string().optional(),
    },
  },
  async (args) => {
    const existing = (await listFilters()).find((f) => f.name?.toLowerCase() === args.name.trim().toLowerCase());
    const payload = {
      name: args.name,
      ...(args.description ? { description: args.description } : {}),
      filters: { jql: args.jql },
    };

    if (existing) {
      await api(`/api/saved-filters/${enc(existing.id ?? existing._id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return text(`Updated saved filter "${args.name}".`);
    }
    await api('/api/saved-filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return text(`Saved filter "${args.name}".`);
  }
);

tool(
  {
    name: 'delete_teamboard_filter',
    title: 'Delete a saved filter',
    description: 'Remove one of your saved filters by name.',
    inputSchema: { name: z.string() },
  },
  async (args) => {
    const hit = await resolveFilter(args.name);
    await api(`/api/saved-filters/${enc(hit.id ?? hit._id)}`, { method: 'DELETE' });
    return text(`Deleted saved filter "${hit.name}".`);
  }
);

tool(
  {
    name: 'delete_teamboard_task',
    title: 'Delete a TeamBoard task',
    description: 'Permanently remove a task (admin only). This cannot be undone — confirm with the user first, and prefer setting the status to Cancelled or Closed.',
    inputSchema: { task: TASK_REF },
  },
  async (args) => {
    const t = await resolveTask(args.task);
    await api(`/api/tasks/${enc(t.taskId)}`, { method: 'DELETE' });
    return text(`Deleted ${t.taskId} — ${t.title}.`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => { console.error(err); process.exit(1); });
