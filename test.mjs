// Run: node test.mjs   (no framework, no network — fetch is stubbed)
//
// Covers the resolution layer, which is the whole reason this server exists:
// a caller passes a human reference and must either get the right row or a
// message listing the candidates. Never a silent wrong write.
import assert from 'node:assert/strict';
import {
  attachmentPath, fetchVocab, formatDate, isClear, isObjectId, looksLikeTaskId,
  normalizeValue, invalidateCache, pickOne, resolveProject, resolveTask, resolveUser,
} from './resolve.js';

process.env.TEAMBOARD_TOKEN = 'tbp_test';

// ── fetch stub: route → payload, plus a log of what was requested ────────────
let routes = {};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  calls.push(`${init.method || 'GET'} ${path}`);
  const match = Object.keys(routes).find((r) => path.startsWith(r));
  if (!match) return { ok: false, status: 404, json: async () => ({ success: false, message: 'Not found' }) };
  const body = routes[match];
  if (body.__status) return { ok: false, status: body.__status, json: async () => ({ success: false, message: body.__message }) };
  return { ok: true, status: 200, json: async () => ({ success: true, data: body }) };
};
const stub = (r) => { routes = r; calls.length = 0; };
const rejects = async (fn, re) => {
  await assert.rejects(fn, (err) => (assert.match(err.message, re), true));
};

// ── pure helpers ─────────────────────────────────────────────────────────────
assert.ok(isObjectId('507f1f77bcf86cd799439011'));
assert.ok(!isObjectId('TASK-42'));
assert.ok(looksLikeTaskId('TASK-42') && looksLikeTaskId(' task-1 ') && looksLikeTaskId('TB-007'));
assert.ok(!looksLikeTaskId('Fix the login page'));
assert.ok(isClear('none') && isClear('  Unassigned ') && isClear('__none__'));
assert.ok(!isClear('Priya'));

// An exact match beats a longer name that merely contains the same prefix.
const people = [{ name: 'Sam' }, { name: 'Samantha' }];
assert.equal(pickOne(people, 'sam', ['name']).name, 'Sam');
assert.equal(pickOne(people, 'saman', ['name']).name, 'Samantha');
assert.equal(pickOne(people, 'sa', ['name']), null); // ambiguous → caller must say more

assert.equal(normalizeValue('bug', ['Task', 'Bug'], 'task type'), 'Bug');
assert.throws(() => normalizeValue('Epci', ['Task', 'Bug'], 'task type'), /Unknown task type "Epci". Valid: Task, Bug/);
assert.equal(normalizeValue('Whatever', [], 'status'), 'Whatever'); // vocab unavailable → pass through

// A date-only value must not grow a time. Checking only the LOCAL clock printed
// "Sep 30, 2026, 5:30 AM" for "2026-09-30" east of UTC.
assert.equal(formatDate('2026-09-30'), 'Sep 30, 2026');
assert.equal(formatDate('2026-09-30T00:00:00.000Z'), 'Sep 30, 2026');
assert.match(formatDate('2026-09-30T09:15:00.000Z'), /2026, \d/); // a real time survives
// 23:59 LOCAL is the app's own due-date default; it must keep its local date.
const eod = new Date(2026, 8, 30, 23, 59);
assert.equal(formatDate(eod.toISOString()), 'Sep 30, 2026');
assert.equal(formatDate(null), 'Not provided');
assert.equal(formatDate('not a date'), 'Not provided');

// ── resolveTask ──────────────────────────────────────────────────────────────
stub({ '/api/tasks/TASK-42': { taskId: 'TASK-42', title: 'Real task' } });
assert.equal((await resolveTask('TASK-42')).title, 'Real task');
assert.deepEqual(calls, ['GET /api/tasks/TASK-42']); // id-shaped → one direct fetch

// A title falls through to the title search, then re-fetches the full task.
stub({
  '/api/tasks?title=': { allTasks: [{ taskId: 'TASK-9', title: 'Login page broken' }] },
  '/api/tasks/TASK-9': { taskId: 'TASK-9', title: 'Login page broken', status: 'To Do' },
});
assert.equal((await resolveTask('Login page broken')).status, 'To Do');

// An id-shaped ref that is really a title ("Login-2") must not dead-end on the 404.
stub({
  '/api/tasks/Login-2': { __status: 404, __message: 'Task not found' },
  '/api/tasks?title=': { allTasks: [{ taskId: 'TASK-3', title: 'Login-2' }] },
  '/api/tasks/TASK-3': { taskId: 'TASK-3', title: 'Login-2' },
});
assert.equal((await resolveTask('Login-2')).taskId, 'TASK-3');

// A 403 is NOT a miss — it must surface, not be retried as a title.
stub({ '/api/tasks/TASK-5': { __status: 403, __message: 'Project is locked' } });
await rejects(() => resolveTask('TASK-5'), /Project is locked/);

// Ambiguity lists the candidates instead of guessing.
stub({ '/api/tasks?title=': { allTasks: [
  { taskId: 'TASK-1', title: 'Fix login' }, { taskId: 'TASK-2', title: 'Fix logout' },
] } });
await rejects(() => resolveTask('Fix log'), /matches 2 tasks[\s\S]*TASK-1 — Fix login[\s\S]*TASK-2 — Fix logout/);

stub({ '/api/tasks?title=': { allTasks: [] } });
await rejects(() => resolveTask('nothing like this'), /No task found for "nothing like this"/);

// ── resolveUser ──────────────────────────────────────────────────────────────
stub({ '/api/users?search=': { users: [
  { _id: 'u1', name: 'Priya Sharma', email: 'priya@x.com' },
  { _id: 'u2', name: 'Priyanka Roy', email: 'priyanka@x.com' },
] } });
assert.equal(await resolveUser('Priya Sharma'), 'u1');     // exact name
assert.equal(await resolveUser('priyanka@x.com'), 'u2');   // exact email
await rejects(() => resolveUser('Priy'), /matches 2 users[\s\S]*Priya Sharma[\s\S]*Priyanka Roy/);

// With a project, the roster is the source of truth — an assignee must be a member.
stub({ '/api/projects/p1/members': { members: [
  { role: 'owner', user: { _id: 'u1', name: 'Priya Sharma', email: 'priya@x.com' } },
] } });
assert.equal(await resolveUser('Priya', 'p1'), 'u1');
await rejects(() => resolveUser('Outsider', 'p1'), /doesn't match exactly one member[\s\S]*Priya Sharma/);

// An ObjectId is taken as-is, with no lookup at all.
stub({});
assert.equal(await resolveUser('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011');
assert.deepEqual(calls, []);

// ── the resolution cache ─────────────────────────────────────────────────────
// A conversation resolves the same person over and over; each miss is a round trip.
stub({ '/api/users?search=': { users: [{ _id: 'u9', name: 'Cache Probe', email: 'c@x.com' }] } });
assert.equal(await resolveUser('Cache Probe'), 'u9');
assert.equal(calls.length, 1);
assert.equal(await resolveUser('Cache Probe'), 'u9');
assert.equal(calls.length, 1, 'second lookup must not hit the network');
assert.equal(await resolveUser('CACHE PROBE'), 'u9'); // key is case-insensitive
assert.equal(calls.length, 1);
invalidateCache();
assert.equal(await resolveUser('Cache Probe'), 'u9');
assert.equal(calls.length, 2, 'invalidateCache must force a refetch');

// Scoping matters: the same name inside a project is a DIFFERENT question.
stub({ '/api/projects/p9/members': { members: [{ role: 'member', user: { _id: 'u10', name: 'Cache Probe', email: 'c@x.com' } }] } });
assert.equal(await resolveUser('Cache Probe', 'p9'), 'u10');
invalidateCache();

// ── resolveProject ───────────────────────────────────────────────────────────
stub({ '/api/projects?search=': { projects: [
  { _id: 'p1', projectCode: 'TB', title: 'TeamBoard' },
  { _id: 'p2', projectCode: 'TBX', title: 'TeamBoard Experiments' },
] } });
assert.equal((await resolveProject('TB'))._id, 'p1');           // exact code wins over prefix sibling
assert.equal((await resolveProject('TeamBoard'))._id, 'p1');    // exact title
await rejects(() => resolveProject('Team'), /matches 2 projects[\s\S]*TB — TeamBoard/);

stub({ '/api/projects?ids=': { projects: [{ _id: '507f1f77bcf86cd799439011', projectCode: 'TB', title: 'TeamBoard' }] } });
assert.equal((await resolveProject('507f1f77bcf86cd799439011')).projectCode, 'TB');
assert.ok(calls[0].includes('ids='));

// ── resolveUser("me") ────────────────────────────────────────────────────────
stub({ '/api/users/me': { user: { _id: 'self-id', name: 'Me' } } });
assert.equal(await resolveUser('me'), 'self-id');
assert.deepEqual(calls, ['GET /api/users/me']);

// ── server errors keep their message ─────────────────────────────────────────
stub({ '/api/tasks/TASK-7': { __status: 400, __message: 'Assignee must be a member of the project' } });
await rejects(() => resolveTask('TASK-7'), /Assignee must be a member of the project/);

// ── formatDuration (mirrors index.js — time comes back in SECONDS) ───────────
const formatDuration = (secs) => {
  const total = Math.round((secs ?? 0) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};
assert.equal(formatDuration(3600), '1h 0m');
assert.equal(formatDuration(5400), '1h 30m');
assert.equal(formatDuration(90), '2m');      // rounds to the nearest minute
assert.equal(formatDuration(0), '0m');
assert.equal(formatDuration(undefined), '0m');
// The API takes seconds; logging "30 minutes" must not send 30.
assert.equal(30 * 60, 1800);

// ── attachmentPath ───────────────────────────────────────────────────────────
// A stored url is "/files/...", which next.config rewrites to the API route — but that
// path is not under /api/*, so middleware 307s a token request to the login page, and
// following that wrote a 73KB HTML page over the downloaded file. Address the route.
assert.equal(attachmentPath('/files/documents/a.txt'), '/api/uploads/files/documents/a.txt');
assert.equal(attachmentPath('files/documents/a.txt'), '/api/uploads/files/documents/a.txt');
assert.equal(attachmentPath('/api/uploads/files/x.png'), '/api/uploads/files/x.png'); // already routed

// ── pickAttachment ───────────────────────────────────────────────────────────
// Not exported from index.js (which boots a server on import), so the rule is
// re-asserted here against the same logic: an ambiguous name must never resolve,
// because the caller acts on the result by DELETING it.
const docs = [
  { name: 'spec-v1.pdf', url: '/files/documents/a.pdf' },
  { name: 'spec-v2.pdf', url: '/files/documents/b.pdf' },
  { name: 'screenshot.png', url: '/files/documents/c.png' },
];
const pick = (name) => {
  const low = name.trim().toLowerCase();
  const exact = docs.filter((d) => d.name.toLowerCase() === low);
  const partial = docs.filter((d) => d.name.toLowerCase().includes(low));
  return exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : null;
};
assert.equal(pick('spec-v1.pdf').url, '/files/documents/a.pdf'); // exact
assert.equal(pick('screenshot').url, '/files/documents/c.png');  // lone partial
assert.equal(pick('spec'), null);                                 // ambiguous → refuse
assert.equal(pick('nothing'), null);

// ── the workspace vocabulary ─────────────────────────────────────────────────
// Resolutions ride along with the types and priorities. A task cannot be closed without
// one, so losing them here would leave the tool descriptions unable to name a single
// valid value.
routes = {
  '/api/tasks/meta': { taskTypes: ['Bug'], priorities: ['High'], resolutions: ['Fixed', 'As Designed'] },
  '/api/tasks/statuses': [{ value: 'To Do' }, { value: 'Completed' }],
};
const vocab = await fetchVocab();
assert.deepEqual(vocab.resolutions, ['Fixed', 'As Designed']);
assert.deepEqual(vocab.statuses, ['To Do', 'Completed']);

// An older server that does not serve them must degrade to empty, not undefined —
// listOr() and normalizeValue() both branch on `.length`.
routes = { '/api/tasks/meta': { taskTypes: [], priorities: [] }, '/api/tasks/statuses': [] };
assert.deepEqual((await fetchVocab()).resolutions, []);

console.log('all resolution checks passed');
