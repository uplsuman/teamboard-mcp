// TeamBoard API client + the human-reference resolvers.
//
// The whole point of this module: an MCP caller says "TASK-42", "Login page
// broken", "Priya" or "TP5" — never a Mongo ObjectId, which it has no way to
// know. Everything here turns a human reference into what the API wants, and
// fails with the list of candidates when a reference is ambiguous.

export const BASE_URL = (process.env.TEAMBOARD_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export const enc = encodeURIComponent;

export async function api(path, init = {}) {
  const headers = { Authorization: `Bearer ${process.env.TEAMBOARD_TOKEN}`, ...init.headers };
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new ApiError(json.message || `${init.method || 'GET'} ${path} failed (${res.status})`, res.status);
  }
  return json.data;
}

export const isObjectId = (s) => /^[a-f\d]{24}$/i.test(s);
export const looksLikeTaskId = (s) => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(String(s).trim());

const CLEAR = new Set(['none', 'unassigned', 'unassign', 'clear', 'remove', 'null', '__none__']);
export const isClear = (s) => CLEAR.has(String(s).trim().toLowerCase());

const FIELDS = ['name', 'email', 'username'];
const low = (s) => String(s).trim().toLowerCase();

// Pick one row out of candidates: an exact field match wins, then a lone prefix
// match, then a lone candidate. Anything else is ambiguous — the caller must say more.
export function pickOne(candidates, ref, fields) {
  const low = String(ref).trim().toLowerCase();
  const vals = (c) => fields.map((f) => c[f]).filter(Boolean).map((v) => String(v).trim().toLowerCase());
  const exact = candidates.filter((c) => vals(c).includes(low));
  if (exact.length === 1) return exact[0];
  const prefix = candidates.filter((c) => vals(c).some((v) => v.startsWith(low)));
  if (prefix.length === 1) return prefix[0];
  if (candidates.length === 1) return candidates[0];
  return null;
}

export async function resolveTask(ref) {
  const r = String(ref).trim();
  if (isObjectId(r) || looksLikeTaskId(r)) {
    try {
      return await api(`/api/tasks/${enc(r)}`);
    } catch (err) {
      if (err.status !== 404) throw err; // 404 → it may have been a title like "Login-2"
    }
  }
  const data = await api(`/api/tasks?title=${enc(r)}&limit=10`);
  const list = data?.allTasks ?? [];
  if (!list.length) throw new Error(`No task found for "${ref}". Try search_teamboard_tasks first.`);
  const hit = pickOne(list, r, ['title', 'taskId']);
  if (!hit) {
    const lines = list.map((t) => `- ${t.taskId} — ${t.title}`).join('\n');
    throw new Error(`"${ref}" matches ${list.length} tasks. Pass the task ID:\n${lines}`);
  }
  return await api(`/api/tasks/${enc(hit.taskId)}`);
}

// Returns a user _id. `projectId` scopes the lookup to that project's roster,
// which is what task assignment actually requires.
export async function resolveUser(ref, projectId) {
  const r = String(ref).trim();
  if (isObjectId(r)) return r;

  if (projectId) {
    const { members = [] } = await api(`/api/projects/${enc(projectId)}/members`);
    const roster = members.map((m) => ({ ...m.user, memberRole: m.role }));
    // Narrow to rows that actually contain the reference BEFORE picking. The roster
    // is an unfiltered list, so pickOne's lone-candidate tier would otherwise hand
    // back the only member of a one-person project for any name at all.
    const matches = roster.filter((u) => FIELDS.some((f) => u[f]?.toLowerCase().includes(low(r))));
    const hit = pickOne(matches, r, FIELDS);
    if (hit) return String(hit._id);
    const lines = roster.map((u) => `- ${u.name} <${u.email}>`).join('\n');
    throw new Error(`"${ref}" doesn't match exactly one member of this project. Members:\n${lines || '(none)'}`);
  }

  const { users = [] } = await api(`/api/users?search=${enc(r)}&limit=20&userStatus=active`);
  if (!users.length) throw new Error(`No active user matches "${ref}".`);
  const hit = pickOne(users, r, FIELDS);
  if (!hit) {
    const lines = users.map((u) => `- ${u.name} <${u.email}>`).join('\n');
    throw new Error(`"${ref}" matches ${users.length} users. Be more specific:\n${lines}`);
  }
  return String(hit._id);
}

export async function resolveProject(ref) {
  const r = String(ref).trim();
  const query = isObjectId(r) ? `ids=${enc(r)}` : `search=${enc(r)}&limit=20`;
  const { projects = [] } = await api(`/api/projects?${query}`);
  if (!projects.length) throw new Error(`No project matches "${ref}". Use list_teamboard_projects.`);
  const hit = pickOne(projects, r, ['projectCode', 'title']);
  if (!hit) {
    const lines = projects.map((p) => `- ${p.projectCode} — ${p.title}`).join('\n');
    throw new Error(`"${ref}" matches ${projects.length} projects. Pass the project code:\n${lines}`);
  }
  return hit;
}

// The workspace's task types / priorities / statuses, fetched once at startup so
// tool descriptions carry the real values. A dead server must not stop the MCP
// from booting — the caller falls back to generic defaults.
export async function fetchVocab() {
  const [meta, statuses] = await Promise.all([
    api('/api/tasks/meta').catch(() => ({})),
    api('/api/tasks/statuses').catch(() => []),
  ]);
  return {
    taskTypes: meta?.taskTypes ?? [],
    priorities: meta?.priorities ?? [],
    statuses: (Array.isArray(statuses) ? statuses : []).map((s) => s.value).filter(Boolean),
  };
}

// Case-insensitive match against the workspace vocabulary; an unknown value is
// rejected with the valid list rather than written onto the task.
export function normalizeValue(value, allowed, label) {
  if (!allowed.length) return value; // vocabulary fetch failed — let the server judge
  const hit = allowed.find((a) => a.toLowerCase() === String(value).trim().toLowerCase());
  if (!hit) throw new Error(`Unknown ${label} "${value}". Valid: ${allowed.join(', ')}`);
  return hit;
}

export const stripHtml = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// A date-only value carries no meaningful time — it sits at midnight (a plain
// "2026-09-30" from this tool) or at 23:59 (the TB-041 due-date default). Which
// CLOCK made it a round number decides how to render it, and getting that wrong
// shifts the date by a day: "2026-09-30" is 00:00 UTC, which is 05:30 local in
// +05:30 (printed a bogus "5:30 AM") and the PREVIOUS EVENING in -07:00
// (printed Sep 29). So detect per clock and format in whichever one matched.
const roundTime = (h, m) => (h === 0 && m === 0) || (h === 23 && m === 59);

export const formatDate = (iso) => {
  if (!iso) return 'Not provided';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Not provided';

  const dateOnly = { month: 'short', day: 'numeric', year: 'numeric' };
  if (roundTime(d.getHours(), d.getMinutes())) return d.toLocaleString('en-US', dateOnly);
  if (roundTime(d.getUTCHours(), d.getUTCMinutes())) {
    return d.toLocaleString('en-US', { ...dateOnly, timeZone: 'UTC' });
  }
  return d.toLocaleString('en-US', { ...dateOnly, hour: 'numeric', minute: '2-digit' });
};

export const taskUrl = (taskId) => `${BASE_URL}/task?id=${taskId}`;
export const displayName = (v) => (v && typeof v === 'object' ? v.name : v);
