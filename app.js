import { firebaseConfig as fileConfig } from "./config.js";

// Firebase is loaded lazily (see connectFirebase) so a network hiccup or
// blocked CDN request can't take down the rest of the app — task entry,
// tabs, and editing all work purely client-side already.
const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
const FIREBASE_FIRESTORE_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
const FIREBASE_AUTH_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const INDENT = "    "; // 4 spaces per indent level
const APP_VERSION = "26";

/* ---------- config resolution ---------- */

function isPlaceholderConfig(cfg) {
  return !cfg || !cfg.apiKey || String(cfg.apiKey).startsWith("YOUR_");
}

function loadStoredConfig() {
  try {
    const raw = localStorage.getItem("firebaseConfigOverride");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function resolveConfig() {
  if (!isPlaceholderConfig(fileConfig)) return fileConfig;
  const stored = loadStoredConfig();
  if (stored && !isPlaceholderConfig(stored)) return stored;
  return null;
}

/* ---------- state ---------- */

let state = { tasks: [], calendar: [], completed: [], deleted: [] };
let db = null;
let docRef = null;
let fb = null; // holds { onSnapshot, runTransaction, doc } once the SDK loads
let auth = null;
let authMod = null; // the firebase-auth module itself, once loaded
let authUser = null; // current signed-in user (anonymous or Google-linked)
let unsubscribeSnapshot = null; // detaches the previous doc's listener when the uid changes
let dataLoaded = false; // true once the current user's doc has produced its first snapshot
let editingKey = null; // "listName:id" while a task is being edited inline
let selected = null; // { listName, id } — the task the toolbar buttons act on
let pendingPopover = null; // "send-calendar" | "complete-recurring" | "pause" | null
let currentTab = "tasks";
let suppressClickUntil = 0; // guards the ghost "click" that follows a real drag

const el = {
  configBanner: document.getElementById("config-banner"),
  configInput: document.getElementById("config-input"),
  configSave: document.getElementById("config-save"),
  configError: document.getElementById("config-error"),
  syncStatus: document.getElementById("sync-status"),
  appVersion: document.getElementById("app-version"),
  tabs: document.getElementById("tabs"),
  appHeader: document.querySelector(".app-header"),
  appTop: document.getElementById("app-top"),
  tbAccount: document.getElementById("tb-account"),
  tbAdd: document.getElementById("tb-add"),
  tbComplete: document.getElementById("tb-complete"),
  tbDelete: document.getElementById("tb-delete"),
  tbSendCalendar: document.getElementById("tb-send-calendar"),
  tbPause: document.getElementById("tb-pause"),
  tbInProgress: document.getElementById("tb-inprogress"),
  tbSendTasks: document.getElementById("tb-send-tasks"),
  tbEdit: document.getElementById("tb-edit"),
  tbResurrect: document.getElementById("tb-resurrect"),
  addTaskPanel: document.getElementById("add-task-panel"),
  newTaskInput: document.getElementById("new-task-input"),
  confirmAddBtn: document.getElementById("confirm-add-btn"),
  cancelAddBtn: document.getElementById("cancel-add-btn"),
  addTaskError: document.getElementById("add-task-error"),
  tasksList: document.getElementById("tasks-list"),
  tasksEmpty: document.getElementById("tasks-empty"),
  calendarList: document.getElementById("calendar-list"),
  calendarEmpty: document.getElementById("calendar-empty"),
  completedList: document.getElementById("completed-list"),
  completedEmpty: document.getElementById("completed-empty"),
  deletedList: document.getElementById("deleted-list"),
  deletedEmpty: document.getElementById("deleted-empty"),
  main: document.getElementById("main"),
  tbSearch: document.getElementById("tb-search"),
  searchPanel: document.getElementById("search-panel"),
  searchInput: document.getElementById("search-input"),
  searchCloseBtn: document.getElementById("search-close-btn"),
  searchResults: document.getElementById("search-results"),
  searchEmpty: document.getElementById("search-empty"),
};

/* ---------- utils ---------- */

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function todayLocal() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}

function formatDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function formatTimestamp(iso) {
  const dt = new Date(iso);
  return dt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- recurring tasks: [[Daily]], [[Weekly]], [[Tuesdays]], ... ---------- */

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Reads the first [[...]] marker in a task's text and returns either a
// recurrence descriptor, "prompt" (for [[Recurring]], where the user picks
// the next date themselves), or null (no marker, or one we don't recognize).
function parseRecurrence(text) {
  const match = text.match(/\[\[([^[\]]+)\]\]/);
  if (!match) return null;
  const raw = match[1].trim().toLowerCase();
  if (raw === "recurring") return "prompt";
  if (["daily", "weekly", "monthly", "yearly"].includes(raw)) return { type: raw };
  if (raw === "start of month" || raw === "first day of month") return { type: "start-of-month" };
  if (raw === "start of year" || raw === "first day of year") return { type: "start-of-year" };
  const weekdayMatch = raw.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s$/);
  if (weekdayMatch) return { type: "weekday", weekday: WEEKDAY_NAMES.indexOf(weekdayMatch[1]) };
  const everyNMatch = raw.match(/^every (\d+) days?$/);
  if (everyNMatch) {
    const n = parseInt(everyNMatch[1], 10);
    if (n > 0) return { type: "every-n-days", n };
  }
  const everyNMonthsMatch = raw.match(/^every (\d+) months?$/);
  if (everyNMonthsMatch) {
    const n = parseInt(everyNMonthsMatch[1], 10);
    if (n > 0) return { type: "every-n-months", n };
  }
  return null;
}

// Distinguishes "no [[...]] marker at all" (fine, not recurring) from
// "there's one but we don't recognize it" (a likely typo) — parseRecurrence
// alone returns null for both, which isn't enough to validate on save.
// Returns the raw bracket contents (for the error message) or null if the
// text is fine either way.
function findUnrecognizedRecurrenceMarker(text) {
  const match = text.match(/\[\[([^[\]]+)\]\]/);
  if (!match) return null;
  return parseRecurrence(text) === null ? match[1].trim() : null;
}

// Shown alongside the "not recognized" error so fixing a typo (or just not
// knowing the exact wording) doesn't mean hunting through the README.
const RECURRENCE_HELP =
  "Valid recurrences: [[Daily]], [[Weekly]], [[Monthly]], [[Yearly]], " +
  "[[Every N days]], [[Every N months]], [[Start of Month]] (or " +
  "[[First Day of Month]]), [[Start of Year]] (or [[First Day of Year]]), " +
  "[[<Weekday>s]] (e.g. [[Tuesdays]]), [[Recurring]].";

// Adds calendar months to a date, clamping the day into the target month
// (e.g. Jan 31 + 1 month -> Feb 28) instead of letting it roll into the
// month after, which is what plain Date day-overflow would otherwise do.
function addMonthsClamped(date, monthsToAdd) {
  const targetIndex = date.getMonth() + monthsToAdd;
  const targetYear = date.getFullYear() + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), daysInTargetMonth));
}

// fromYmd is the completion date ("today"); returns the next occurrence as
// a YYYY-MM-DD string.
function computeNextDate(recurrence, fromYmd) {
  const [y, m, d] = fromYmd.split("-").map(Number);
  const from = new Date(y, m - 1, d);
  let next;
  switch (recurrence.type) {
    case "daily":
      next = new Date(y, m - 1, d + 1);
      break;
    case "weekly":
      next = new Date(y, m - 1, d + 7);
      break;
    case "every-n-days":
      next = new Date(y, m - 1, d + recurrence.n);
      break;
    case "every-n-months":
      next = addMonthsClamped(from, recurrence.n);
      break;
    case "monthly":
      next = addMonthsClamped(from, 1);
      break;
    case "yearly":
      next = addMonthsClamped(from, 12);
      break;
    case "start-of-month":
      next = new Date(y, m, 1); // m is 1-indexed already, so this is next month's 1st
      break;
    case "start-of-year":
      next = new Date(y + 1, 0, 1);
      break;
    case "weekday":
      next = new Date(y, m - 1, d + 1);
      while (next.getDay() !== recurrence.weekday) {
        next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1);
      }
      break;
    default:
      next = from;
  }
  return next.toLocaleDateString("en-CA");
}

/* ---------- data model: one flat, prioritised list ---------- */

// state.tasks is a single flat array in priority order — index 0 is the
// most important thing on the list, full stop. A paused task stays in that
// array at its own priority and just carries a `blocker` string naming the
// folder it's paused under; folders themselves are never stored. They're
// derived at render time (displayTasks): a folder appears at the position
// of its highest-priority member and lists its members in priority order.
// That's what makes "the folder jumps to wherever its most important task
// is" happen by construction — take a task out, move it, put it back, and
// the folder follows — and it means anything outside the app that wants to
// reprioritise (a nightly script, say) only ever has to sort one list.
//
// Older documents stored folders inline as { type: "folder", blocker,
// tasks: [...] }. normalizeTasks flattens those on the way in — each member
// gets the folder's blocker and takes the folder's slot — and every write
// goes out flat, so a document migrates itself the first time it's saved.
function folderKey(blocker) {
  return String(blocker || "").trim().toLowerCase();
}

function folderIdFor(blocker) {
  return `folder:${folderKey(blocker)}`;
}

function normalizeTasks(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "folder") {
      for (const child of Array.isArray(entry.tasks) ? entry.tasks : []) {
        if (!child || typeof child !== "object") continue;
        const { type, tasks, ...rest } = child; // a folder can't nest another
        out.push({ ...rest, blocker: entry.blocker });
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

function normalizeState(data) {
  return {
    tasks: normalizeTasks(data?.tasks),
    calendar: Array.isArray(data?.calendar) ? data.calendar : [],
    completed: Array.isArray(data?.completed) ? data.completed : [],
    deleted: Array.isArray(data?.deleted) ? data.deleted : [],
  };
}

// What the Tasks tab actually shows: the flat list, with each folder's
// members gathered under one synthetic { type: "folder" } entry that sits
// where the first (highest-priority) of them is. The synthetic entry's id
// is derived from the folder's name, so it's stable across renders and
// devices and can be what `selected` points at.
function displayTasks(tasks = state.tasks) {
  const out = [];
  const folders = new Map();
  for (const task of tasks) {
    const key = folderKey(task.blocker);
    if (!key) {
      out.push(task);
      continue;
    }
    let folder = folders.get(key);
    if (!folder) {
      folder = { type: "folder", id: folderIdFor(task.blocker), blocker: String(task.blocker).trim(), tasks: [] };
      folders.set(key, folder);
      out.push(folder);
    }
    folder.tasks.push(task);
  }
  return out;
}

// Looks an id up the way the UI sees it — in Tasks a folder id resolves to
// its synthetic entry and a task id to the task, folded or not.
function findEntry(listName, id) {
  if (listName === "tasks") return displayTasks().find((t) => t.id === id) || null;
  return state[listName]?.find((t) => t.id === id) || null;
}

// The flat-list id that "before/after this row" means. For a folder row
// that's its top member, since that member's slot is the folder's slot.
function anchorIdOf(entry) {
  if (!entry) return null;
  return entry.type === "folder" ? (entry.tasks[0]?.id ?? null) : entry.id;
}

/* ---------- persistence: an action log replayed inside a transaction ---------- */

// Why not just setDoc(state)? Because that overwrites the WHOLE document
// with whatever this tab last saw, and this tab is not the only writer:
// another device, an offline tab that just reconnected, or a script
// reprioritising the list overnight may all have changed the document since
// this tab last heard from it. A stale whole-document save silently undoes
// every one of those changes (this really happened: a phone that had sat in
// the background saved its old list straight over a fresh reorder).
//
// So instead every user action is recorded as a small replayable op
// ({ type, args } — see OPS), applied to local state immediately so the UI
// responds at once, and persisted by a Firestore transaction that reads the
// document as it is NOW, replays the queued ops onto that, and writes the
// result. Firestore re-runs the transaction if the document changes under
// it, so two writers' changes interleave instead of clobbering each other.
//
// Ops are written to be idempotent and to cope with a changed world (the
// task is gone, the anchor it was dropped next to has moved) by doing the
// sensible thing or nothing. That's also what lets the pending queue be
// re-applied on top of every incoming snapshot — so the list never flickers
// back to its pre-action state while a write is in flight — and what makes
// it safe to replay a queue that was persisted across a reload or an
// offline stretch. Ids and timestamps are generated by the caller and
// passed in as args, so a replay produces exactly the same result.
let pendingOps = []; // applied locally, not yet committed; oldest first
let queueStorageKey = null; // per-account localStorage key holding pendingOps
let flushing = false;
let flushRetryTimer = null;
let flushRetryDelayMs = 2000;

function takeFrom(st, listName, id) {
  const list = st[listName];
  if (!Array.isArray(list)) return null;
  const idx = list.findIndex((t) => t.id === id);
  return idx === -1 ? null : list.splice(idx, 1)[0];
}

// Moves `task` to sit just before `beforeId`, failing that just after
// `afterId`, failing that nowhere (the op is dropped: both anchors have
// left the list, so the intended position no longer exists).
function placeTask(st, task, beforeId, afterId) {
  const others = st.tasks.filter((t) => t.id !== task.id);
  let idx = -1;
  if (beforeId != null) idx = others.findIndex((t) => t.id === beforeId);
  if (idx === -1 && afterId != null) {
    const after = others.findIndex((t) => t.id === afterId);
    if (after !== -1) idx = after + 1;
  }
  if (idx === -1) {
    if (beforeId != null || afterId != null) return;
    idx = others.length;
  }
  st.tasks = [...others.slice(0, idx), task, ...others.slice(idx)];
}

// Pausing under a name that already exists as a folder (case-insensitively)
// joins that folder, keeping its existing spelling — so "home" and "Home"
// never become two folders.
function canonicalBlocker(st, blocker) {
  const key = folderKey(blocker);
  const existing = st.tasks.find((t) => folderKey(t.blocker) === key);
  return existing ? String(existing.blocker).trim() : String(blocker).trim();
}

const OPS = {
  addTask(st, { id, text, createdAt }) {
    if (st.tasks.some((t) => t.id === id)) return;
    st.tasks.unshift({ id, text, createdAt });
  },

  setInProgress(st, { id, value }) {
    const task = st.tasks.find((t) => t.id === id);
    if (task) task.inProgress = !!value;
  },

  // nextDate/nextId, when given, also spin off a fresh copy of the task
  // into Calendar for that date — used for recurring tasks. Only when the
  // task was actually here to complete: a replay (or the same completion
  // arriving from another device) must not create the spin-off twice.
  completeTask(st, { listName, id, at, nextId, nextDate }) {
    const task = takeFrom(st, listName, id);
    if (!task) return;
    // inProgress and blocker only mean something inside the Tasks list —
    // strip them so a resurrected task doesn't silently come back flagged
    // or paused from whenever it left, without you having decided that.
    const { targetDate, sentAt, inProgress, blocker, ...rest } = task;
    st.completed.unshift({ ...rest, completedAt: at });
    if (nextDate && nextId && !st.calendar.some((t) => t.id === nextId)) {
      st.calendar.push({ id: nextId, text: task.text, createdAt: at, targetDate: nextDate, sentAt: at });
    }
  },

  deleteTask(st, { listName, id, at }) {
    const task = takeFrom(st, listName, id);
    if (!task) return;
    const { inProgress, blocker, ...rest } = task; // see completeTask
    st.deleted.unshift({ ...rest, deletedAt: at, sourceList: listName });
  },

  permanentlyDeleteTask(st, { id }) {
    takeFrom(st, "deleted", id);
  },

  moveToCalendar(st, { id, targetDate, at }) {
    const task = takeFrom(st, "tasks", id);
    if (!task) return;
    const { inProgress, blocker, ...rest } = task; // see completeTask
    st.calendar.push({ ...rest, targetDate, sentAt: at });
  },

  moveToTasks(st, { id }) {
    const task = takeFrom(st, "calendar", id);
    if (!task) return;
    const { targetDate, sentAt, ...rest } = task;
    st.tasks.unshift(rest);
  },

  restoreFromDeleted(st, { id }) {
    const task = takeFrom(st, "deleted", id);
    if (!task) return;
    const { deletedAt, sourceList, ...rest } = task;
    if (sourceList === "calendar" && rest.targetDate) {
      st.calendar.push(rest);
    } else {
      const { targetDate, sentAt, ...clean } = rest;
      st.tasks.unshift(clean);
    }
  },

  // Unlike restoreFromDeleted, this always goes to the top of Tasks — a
  // completed task doesn't carry a Calendar date to return to.
  resurrectCompletedTask(st, { id }) {
    const task = takeFrom(st, "completed", id);
    if (!task) return;
    const { completedAt, ...rest } = task;
    st.tasks.unshift(rest);
  },

  // The task keeps its priority slot; only its folder membership changes.
  // A paused (blocked) task isn't work you're actively doing, so the
  // in-progress flag comes off on the way in.
  pauseTask(st, { id, blocker }) {
    const task = st.tasks.find((t) => t.id === id);
    if (!task || !folderKey(blocker)) return;
    task.blocker = canonicalBlocker(st, blocker);
    delete task.inProgress;
  },

  // Back out of its folder, keeping its priority slot — so it reappears
  // exactly where it ranked, not at the top. (Move it from there if that's
  // not where it belongs any more.)
  resumeTask(st, { id }) {
    const task = st.tasks.find((t) => t.id === id);
    if (task) delete task.blocker;
  },

  // Renaming to a name another folder already has merges the two, the same
  // way pausing under an existing name joins that folder.
  renameFolder(st, { key, blocker }) {
    const name = String(blocker).trim();
    if (!key || !name) return;
    const target = canonicalBlocker(st, name);
    for (const task of st.tasks) {
      if (folderKey(task.blocker) === key) task.blocker = target;
    }
  },

  moveTask(st, { id, beforeId, afterId }) {
    const task = st.tasks.find((t) => t.id === id);
    if (task) placeTask(st, task, beforeId, afterId);
  },

  editTaskText(st, { listName, id, text }) {
    const task = st[listName]?.find((t) => t.id === id);
    if (task) task.text = text;
  },

  // Restoring a backup really does mean "replace everything" — the one op
  // that's deliberately a whole-document write.
  replaceState(st, { tasks, calendar, completed, deleted }) {
    st.tasks = normalizeTasks(tasks);
    st.calendar = calendar;
    st.completed = completed;
    st.deleted = deleted;
  },

  // Calendar items whose date has arrived move back to the top of Tasks.
  promoteDue(st, { today }) {
    const due = st.calendar.filter((t) => t.targetDate <= today);
    if (due.length === 0) return;
    st.calendar = st.calendar.filter((t) => t.targetDate > today);
    const promoted = due.map(({ targetDate, sentAt, ...rest }) => rest);
    st.tasks.unshift(...promoted.reverse());
  },
};

function applyOp(st, op) {
  const fn = OPS[op?.type];
  if (fn) fn(st, op.args || {});
}

function withPendingOps(base) {
  if (pendingOps.length === 0) return base;
  const st = JSON.parse(JSON.stringify(base));
  for (const op of pendingOps) applyOp(st, op);
  return st;
}

function persistQueue() {
  if (!queueStorageKey) return;
  try {
    if (pendingOps.length === 0) localStorage.removeItem(queueStorageKey);
    else localStorage.setItem(queueStorageKey, JSON.stringify(pendingOps));
  } catch (err) {
    console.warn("Couldn't persist pending changes", err);
  }
}

function loadQueue(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((op) => op && OPS[op.type]) : [];
  } catch {
    return [];
  }
}

// The one entry point every mutation goes through: apply locally, queue,
// persist the queue, repaint, and start (or keep) flushing.
function commit(type, args) {
  // Acting before the first snapshot has arrived would be acting on an
  // empty list that isn't really the list — the UI keeps that from
  // happening (tbAdd is disabled, nothing is selectable), this is the
  // backstop.
  if (!dataLoaded) return;
  const op = { type, args };
  applyOp(state, op);
  pendingOps.push(op);
  persistQueue();
  render();
  flushOps();
}

function scheduleFlushRetry() {
  clearTimeout(flushRetryTimer);
  flushRetryTimer = setTimeout(() => {
    flushRetryTimer = null;
    flushOps();
  }, flushRetryDelayMs);
  flushRetryDelayMs = Math.min(flushRetryDelayMs * 2, 60 * 1000);
}

async function flushOps() {
  if (flushing || !docRef || !db || !fb || !dataLoaded || pendingOps.length === 0) return;
  flushing = true;
  clearTimeout(flushRetryTimer);
  flushRetryTimer = null;
  const queue = pendingOps; // the array this flush drains — attachUserDoc may swap in another
  const batch = queue.slice();
  const ref = docRef;
  try {
    await fb.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const st = normalizeState(data);
      for (const op of batch) applyOp(st, op);
      // Spread `data` first so fields this app doesn't know about (left by
      // other tools) survive the write. rev/updatedAt are bookkeeping for
      // those tools, nothing here reads them.
      tx.set(ref, {
        ...data,
        ...st,
        rev: (Number(data.rev) || 0) + 1,
        updatedAt: new Date().toISOString(),
      });
    });
    queue.splice(0, batch.length); // ops added while in flight stay queued
    if (queue === pendingOps) persistQueue();
    flushRetryDelayMs = 2000;
    if (pendingOps.length === 0 && navigator.onLine !== false) setSyncStatus("");
  } catch (err) {
    console.error("Save failed", err);
    // Offline is reported by the snapshot listener already; only shout
    // when a save fails while apparently connected.
    if (navigator.onLine !== false) setSyncStatus("Save failed — retrying…", true);
    scheduleFlushRetry();
  } finally {
    flushing = false;
    // Anything queued while this flush was in flight goes out right away;
    // after a failure the retry timer owns the next attempt instead.
    if (pendingOps.length > 0 && !flushRetryTimer) flushOps();
  }
}

function setSyncStatus(msg, isError = false) {
  el.syncStatus.textContent = msg;
  el.syncStatus.classList.toggle("error", isError);
}

/* ---------- due-date promotion ---------- */

// Runs on every snapshot and once a minute. Goes through the same op queue
// as everything else, so it's replayed onto the live document rather than
// racing it — and only gets queued when there's actually something due,
// so an idle app queues nothing.
function promoteDueTasksIfNeeded() {
  if (!dataLoaded) return;
  const today = todayLocal();
  if (!state.calendar.some((t) => t.targetDate <= today)) return;
  commit("promoteDue", { today });
}

/* ---------- mutations ---------- */

// Each of these is a thin wrapper: generate any ids/timestamps here (so a
// replay is deterministic — see the persistence comment) and hand off to
// commit(). The data changes themselves live in OPS above.

function addTask(text) {
  if (!text.trim()) return;
  commit("addTask", { id: uuid(), text, createdAt: new Date().toISOString() });
}

// A lightweight status flag for the Tasks list only — just marks which of
// several things you're actively juggling right now, distinct from Pause's
// "blocked on something" meaning. Stripped whenever a task leaves Tasks.
function toggleInProgress(id) {
  const task = findEntry("tasks", id);
  if (!task || task.type === "folder") return;
  commit("setInProgress", { id, value: !task.inProgress });
}

// nextDate (YYYY-MM-DD), when given, also spins off a fresh copy of the
// task into Calendar for that date — used for recurring tasks.
function completeTask(listName, id, nextDate) {
  const at = new Date().toISOString();
  commit("completeTask", { listName, id, at, nextDate: nextDate || null, nextId: nextDate ? uuid() : null });
}

function deleteTask(listName, id) {
  commit("deleteTask", { listName, id, at: new Date().toISOString() });
}

// Deleting a task that's already in Deleted removes it for good, rather
// than looping it back into Deleted with a new timestamp.
function permanentlyDeleteTask(id) {
  commit("permanentlyDeleteTask", { id });
}

function moveToCalendar(id, targetDate) {
  commit("moveToCalendar", { id, targetDate, at: new Date().toISOString() });
}

function moveToTasks(id) {
  commit("moveToTasks", { id });
}

function restoreFromDeleted(id) {
  commit("restoreFromDeleted", { id });
}

function resurrectCompletedTask(id) {
  commit("resurrectCompletedTask", { id });
}

// Pausing tags the task with the blocker it's waiting on; it stays at its
// own priority and shows up inside that folder (which appears at the slot
// of its top member — see displayTasks). Joins an existing folder of that
// name, case-insensitively, or starts a new one.
function pauseTask(id, blockerName) {
  const trimmed = blockerName.trim();
  if (!trimmed) return;
  commit("pauseTask", { id, blocker: trimmed });
}

// Renames a blocker folder. If another folder already has that name
// (case-insensitively), the two merge — mirrors how pausing a second task
// with the same blocker joins the existing folder rather than making a
// duplicate. Either way the renamed/merged folder stays selected.
function renameFolder(folderId, newBlocker) {
  const trimmed = newBlocker.trim();
  if (!trimmed) return;
  const folder = findEntry("tasks", folderId);
  if (!folder || folder.type !== "folder") return;
  selected = { listName: "tasks", id: folderIdFor(trimmed) };
  commit("renameFolder", { key: folderKey(folder.blocker), blocker: trimmed });
}

// Moves a task back out of its folder. It keeps its priority slot — so it
// reappears where it ranked, not at the top. An emptied folder disappears
// on its own (nothing is left to derive it from); render() drops a
// selection that no longer resolves.
function resumeTask(taskId) {
  commit("resumeTask", { id: taskId });
}

// Used by dragging a task straight onto a folder — same destination as
// pauseTask, but the folder is already known, so no name-matching needed.
function addTaskToFolder(taskId, folderId) {
  const folder = findEntry("tasks", folderId);
  if (!folder || folder.type !== "folder") return;
  commit("pauseTask", { id: taskId, blocker: folder.blocker });
}

// insertIndex is the target position counted among the OTHER display rows
// (i.e. the Tasks tab with the dragged row already removed) — see
// dropIndexForY. Translated into flat-list anchors (the row it should land
// before, and the one it should land after, as fallback) so the op still
// means the same thing if the list has changed by the time it's committed.
// Only task rows get here: folder rows aren't draggable (see attachDragReorder).
function moveEntryTo(entry, insertIndex) {
  if (entry.type === "folder") return;
  const others = displayTasks().filter((t) => t.id !== entry.id);
  const beforeId = anchorIdOf(others[insertIndex]);
  const afterId = anchorIdOf(others[insertIndex - 1]);
  commit("moveTask", { id: entry.id, beforeId, afterId });
}

function editTaskText(listName, id, newText) {
  commit("editTaskText", { listName, id, text: newText });
}

/* ---------- smart textarea: Tab and ">" indentation ---------- */

// Touch devices have no Alt key and rely on the on-screen keyboard's return
// key to insert newlines, so the Enter-submits/Alt+Enter-newlines swap below
// only applies when the primary input is a physical keyboard.
const IS_TOUCH_PRIMARY = window.matchMedia("(pointer: coarse)").matches;

function autoResizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

function attachSmartTextarea(textarea, { onSubmit } = {}) {
  let composing = false;
  textarea.addEventListener("compositionstart", () => (composing = true));
  textarea.addEventListener("compositionend", () => (composing = false));

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      insertAtCursor(textarea, INDENT);
      autoResizeTextarea(textarea);
      return;
    }
    if (e.key === "Enter" && !composing && !IS_TOUCH_PRIMARY && onSubmit) {
      e.preventDefault();
      if (e.altKey) {
        // Browsers generally don't insert a character while Alt is held
        // (same as other Alt+key combos), so insert the newline ourselves.
        insertAtCursor(textarea, "\n");
        autoResizeTextarea(textarea);
      } else {
        onSubmit();
      }
    }
  });

  textarea.addEventListener("input", () => {
    if (!composing) {
      const pos = textarea.selectionStart;
      if (pos > 0 && textarea.value[pos - 1] === ">") {
        if (pos > 1 && textarea.value[pos - 2] === "\\") {
          textarea.value = textarea.value.slice(0, pos - 2) + ">" + textarea.value.slice(pos);
          setCursor(textarea, pos - 1);
        } else {
          textarea.value = textarea.value.slice(0, pos - 1) + INDENT + textarea.value.slice(pos);
          setCursor(textarea, pos - 1 + INDENT.length);
        }
      }
    }
    autoResizeTextarea(textarea);
  });

  autoResizeTextarea(textarea);
}

function insertAtCursor(el, text) {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  setCursor(el, start + text.length);
}

function setCursor(el, pos) {
  el.selectionStart = el.selectionEnd = pos;
}

/* ---------- task text rendering (hanging indent, line highlights) ---------- */

// A highlighted line is stored as its content wrapped in "==...==" — plain,
// visible text (like the [[...]] recurrence markers) rather than a separate
// field, so it round-trips through the textarea and syncs as part of the
// task's ordinary text.
function isLineHighlighted(rest) {
  return rest.length >= 4 && rest.startsWith("==") && rest.endsWith("==");
}

function lineDisplayText(rest) {
  return isLineHighlighted(rest) ? rest.slice(2, -2) : rest;
}

// Leaves blank lines alone — there's nothing meaningful to mark.
function toggleLineHighlightText(line) {
  const leading = line.match(/^ */)[0].length;
  const indent = line.slice(0, leading);
  const rest = line.slice(leading);
  if (rest === "") return line;
  return isLineHighlighted(rest) ? indent + rest.slice(2, -2) : indent + "==" + rest + "==";
}

// Each logical line (split on \n) becomes its own block so a line that
// wraps onto a second visual row hangs one indent level deeper than the
// line's own leading whitespace — this only needs a per-line text-indent/
// padding trick, not per-character measurement.
function renderTaskTextInto(container, text) {
  container.innerHTML = "";
  for (const line of text.split("\n")) {
    const leading = line.match(/^ */)[0].length;
    const lineEl = document.createElement("div");
    lineEl.className = "task-line";
    lineEl.style.paddingLeft = leading + INDENT.length + "ch";
    lineEl.style.textIndent = -INDENT.length + "ch";
    const rest = line.slice(leading);
    const displayText = lineDisplayText(rest);
    if (displayText === "") {
      // A completely empty div collapses to zero height in most browsers —
      // this is what was silently swallowing blank lines between \n\n.
      lineEl.appendChild(document.createElement("br"));
    } else if (isLineHighlighted(rest)) {
      const mark = document.createElement("span");
      mark.className = "text-highlight";
      mark.textContent = displayText;
      lineEl.appendChild(mark);
    } else {
      lineEl.textContent = displayText;
    }
    container.append(lineEl);
  }
}

// Fills the clickable line-picker shown while the "Highlight" toggle is on
// during editing — same rendering as the read-only view, just with each
// line wired up to flip its own highlight marker.
function buildHighlightView(container, text, onLineClick) {
  renderTaskTextInto(container, text);
  [...container.children].forEach((lineEl, i) => {
    lineEl.classList.add("highlight-clickable");
    lineEl.addEventListener("click", () => onLineClick(i));
  });
}

/* ---------- rendering ---------- */

function render() {
  // A selection can stop resolving under us — the folder it pointed at
  // emptied and vanished, or another device completed the task. Clear it
  // rather than leave the toolbar armed for something that isn't there.
  if (selected && !findEntry(selected.listName, selected.id)) selected = null;
  renderTasks();
  renderCalendar();
  renderCompleted();
  renderDeleted();
  updateToolbar();
  el.tbAccount.classList.toggle("linked", !!authUser && !authUser.isAnonymous);
  // Adding a task before the first snapshot arrives would have nothing to
  // merge with once it does — commit() already refuses to act in that
  // window (see its comment), so disable the entry point too rather than
  // let someone type a task that then silently fails to persist.
  el.tbAdd.disabled = !dataLoaded;
  if (!el.searchPanel.classList.contains("hidden")) renderSearchResults();
}

function makeIconBtn(icon, title, onClick, extraClass = "") {
  const btn = document.createElement("button");
  btn.className = "icon-btn " + extraClass;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.textContent = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

function isSelected(listName, id) {
  return !!selected && selected.listName === listName && selected.id === id;
}

function selectTask(listName, id) {
  selected = isSelected(listName, id) ? null : { listName, id };
  pendingPopover = null;
  render();
}

// Builds a row for the Tasks, Calendar, and Deleted lists — the ones where
// tapping a task selects it so the toolbar buttons can act on it. Completed
// is a read-only log and builds its rows separately.
function buildTaskRow(listName, task, metaText) {
  const li = document.createElement("li");
  li.className = "task-item selectable";
  li.dataset.taskId = task.id;
  if (isSelected(listName, task.id)) li.classList.add("selected");
  if (task.inProgress) li.classList.add("in-progress");

  const textWrap = document.createElement("div");
  textWrap.className = "task-text";
  renderTaskTextInto(textWrap, task.text);
  li.append(textWrap);

  if (metaText) {
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = metaText;
    li.append(meta);
  }

  li.addEventListener("click", (e) => {
    if (e.target.closest("button, textarea")) return; // e.g. Save/Cancel while editing
    if (editingKey) return;
    if (Date.now() < suppressClickUntil) return; // ghost click right after a drag
    selectTask(listName, task.id);
  });

  return li;
}

// Inline rename field for a folder's blocker name — same trigger (the
// toolbar's edit button) and the same editingKey mechanism as task text
// editing, just a plain text field instead of the smart textarea since a
// blocker name is always a single short line.
function buildFolderRenameField(folder) {
  const wrap = document.createElement("div");
  wrap.className = "task-edit-area";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "folder-rename-input";
  input.value = folder.blocker;

  const doSave = () => {
    editingKey = null;
    renameFolder(folder.id, input.value);
  };
  const doCancel = () => {
    editingKey = null;
    selected = { listName: "tasks", id: folder.id };
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      doCancel();
    }
  });

  const actions = document.createElement("div");
  actions.className = "task-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", doSave);
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", doCancel);
  actions.append(saveBtn, cancelBtn);
  wrap.append(input, actions);
  return wrap;
}

// Swaps a folder's label for the rename field in place, the same way
// startEdit does for task text — editingKey blocks renderTasks() from
// rebuilding the list out from under an in-progress edit, so entering edit
// mode has to happen via direct DOM surgery rather than a normal render().
function startFolderRename(folder, labelNode) {
  editingKey = `tasks:${folder.id}`;
  const container = labelNode.parentElement;
  const field = buildFolderRenameField(folder);
  container.replaceChild(field, labelNode);
  const input = field.querySelector(".folder-rename-input");
  input.focus();
  input.select();
}

// A folder is "open" exactly when it's selected — no separate expanded-state
// tracking needed, and it collapses for free whenever selection moves
// elsewhere. Its own toolbar actions are all disabled except edit, which
// renames the folder instead of any of its tasks; the only thing you can do
// with its contents is resume one back to Tasks.
function buildFolderRow(folder) {
  const isOpen = isSelected("tasks", folder.id);
  const li = document.createElement("li");
  li.className = "task-item folder selectable";
  li.dataset.taskId = folder.id;
  if (isOpen) li.classList.add("selected");

  const textWrap = document.createElement("div");
  textWrap.className = "task-text";
  const label = document.createElement("div");
  label.className = "task-line folder-label";
  label.textContent = `🗂️ ${folder.blocker} (${folder.tasks.length})`;
  textWrap.append(label);
  li.append(textWrap);

  li.addEventListener("click", (e) => {
    if (e.target.closest("button, input")) return;
    if (Date.now() < suppressClickUntil) return;
    selectTask("tasks", folder.id);
  });

  if (isOpen) {
    const sub = document.createElement("ul");
    sub.className = "task-list folder-contents";
    for (const child of folder.tasks) {
      const childLi = document.createElement("li");
      childLi.className = "task-item folder-child";
      childLi.dataset.taskId = child.id;
      const childText = document.createElement("div");
      childText.className = "task-text";
      renderTaskTextInto(childText, child.text);
      childLi.append(childText, makeIconBtn("▶️", "Resume", () => resumeTask(child.id)));
      sub.append(childLi);
    }
    li.append(sub);
  }

  return li;
}

/* ---------- drag to reorder (Tasks tab only) ---------- */

// Midpoints of the OTHER (non-dragged) rows, captured once when the drag
// engages — i.e. before the drop-line exists. Re-measuring live on every
// move would be wrong: once the line is inserted it pushes later siblings
// down, which would shift their midpoints and make the line "stick" short
// of where the pointer actually is. Stored as page-absolute Y (+scrollY)
// rather than viewport-relative, so they stay correct across the auto-scroll
// that can now happen mid-drag — a plain getBoundingClientRect() value would
// go stale the moment the page scrolls out from under a stationary pointer.
function captureSiblingMidpoints(listEl, draggedLi) {
  const siblings = [...listEl.children].filter(
    (elm) => elm !== draggedLi && !elm.classList.contains("drop-line")
  );
  return siblings.map((elm) => {
    const rect = elm.getBoundingClientRect();
    return rect.top + window.scrollY + rect.height / 2;
  });
}

// Index is counted among the OTHER (non-dragged) tasks — i.e. where the
// dragged item would land if spliced into that list. pageY is page-absolute
// (clientY + scrollY), matching the midpoints above.
function dropIndexForY(midpoints, pageY) {
  for (let i = 0; i < midpoints.length; i++) {
    if (pageY < midpoints[i]) return i;
  }
  return midpoints.length;
}

// One Y position per possible drop index (there are siblings.length + 1 of
// them — before the first, between each pair, after the last), relative to
// listEl's own top. Captured once at engage, same as the midpoints above,
// and for the same reason: nothing should move mid-drag, dragged item
// included, so these positions stay valid for the whole gesture.
function captureGapPositions(listEl, draggedLi) {
  const siblings = [...listEl.children].filter(
    (elm) => elm !== draggedLi && !elm.classList.contains("drop-line")
  );
  const listTop = listEl.getBoundingClientRect().top;
  const rects = siblings.map((elm) => elm.getBoundingClientRect());
  const gaps = [];
  for (let i = 0; i <= rects.length; i++) {
    let y;
    if (rects.length === 0) y = listTop;
    else if (i === 0) y = rects[0].top;
    else if (i === rects.length) y = rects[rects.length - 1].bottom;
    else y = (rects[i - 1].bottom + rects[i].top) / 2;
    gaps.push(y - listTop);
  }
  return gaps;
}

// The line is an absolutely-positioned overlay (see CSS), not a real flex
// item — moving it never reflows the tasks around it.
function showDropLine(listEl, topPx) {
  let line = listEl.querySelector(".drop-line");
  if (!line) {
    line = document.createElement("li");
    line.className = "drop-line";
    line.setAttribute("aria-hidden", "true");
    listEl.append(line);
  }
  line.style.top = `${topPx}px`;
}

function removeDropLine(listEl) {
  listEl.querySelector(".drop-line")?.remove();
}

// Folder rows to drop a (non-folder) task directly into, captured once at
// engage like everything else above. Empty when the dragged item is itself
// a folder — folders don't merge into other folders via drag. top/bottom are
// page-absolute (+scrollY), same reasoning as captureSiblingMidpoints.
function captureFolderTargets(listEl, draggedLi, draggedTask) {
  if (draggedTask.type === "folder") return [];
  return [...listEl.children]
    .filter((elm) => elm !== draggedLi && elm.classList.contains("folder"))
    .map((elm) => {
      const rect = elm.getBoundingClientRect();
      return { id: elm.dataset.taskId, top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY };
    });
}

function setDropTargetFolder(listEl, folderId) {
  for (const elm of listEl.querySelectorAll(".task-item.folder")) {
    elm.classList.toggle("drop-target", elm.dataset.taskId === folderId);
  }
}

function clearDropTargetFolder(listEl) {
  listEl.querySelector(".folder.drop-target")?.classList.remove("drop-target");
}

/* ---------- auto-scroll while dragging, and momentum after a manual scroll ---------- */

const EDGE_ZONE = 70; // px from the visible top/bottom edge that triggers auto-scroll while dragging
const MAX_AUTOSCROLL_SPEED = 16; // px per animation frame at the very edge

// A page-absolute Y a scroll-driven auto-scroll or momentum fling can't
// exceed, matching the browser's own scroll clamping — window.scrollTo
// already clamps, but computing this lets both features stop cleanly
// instead of endlessly scheduling frames once they've hit the end.
function maxScrollY() {
  return document.documentElement.scrollHeight - window.innerHeight;
}

// Lets a fresh touch cancel a fling still in progress from a previous one —
// the natural "tap to stop" most native scroll views have. Module-level
// since it isn't scoped to any one row's drag gesture.
let momentumRAF = null;
function stopMomentumScroll() {
  if (momentumRAF) {
    cancelAnimationFrame(momentumRAF);
    momentumRAF = null;
  }
}

// pxPerMs is signed velocity at the moment of release. Decays it by
// friction every frame until it's imperceptible, continuing the scroll
// the way a touch scroll keeps gliding after you lift your finger instead
// of stopping dead — this app takes over scrolling with touch-action:none
// on task rows (see attachDragReorder), so it has to reproduce that itself
// rather than getting it for free from the browser.
function startMomentumScroll(pxPerMs) {
  stopMomentumScroll();
  const FRICTION = 0.95; // per-frame decay
  const MIN_SPEED = 0.02; // px/ms — below this it's not worth another frame
  let velocity = pxPerMs;
  let lastTime = performance.now();

  function step(now) {
    const dt = now - lastTime;
    lastTime = now;
    velocity *= FRICTION;
    if (Math.abs(velocity) < MIN_SPEED) {
      momentumRAF = null;
      return;
    }
    const next = Math.max(0, Math.min(maxScrollY(), window.scrollY + velocity * dt));
    if (next === window.scrollY) {
      momentumRAF = null; // hit the top or bottom of the page
      return;
    }
    window.scrollTo(0, next);
    momentumRAF = requestAnimationFrame(step);
  }
  momentumRAF = requestAnimationFrame(step);
}

// A folder row can't be dragged: its position is defined as its top
// member's position, so moving it directly would have to rewrite its
// members' priorities, which is exactly what the folder isn't meant to do.
// Re-rank the task inside it instead (resume, drag, pause again). The
// handler still attaches to folder rows so a touch that starts on one
// scrolls the page like any other row (task rows have touch-action: none).
function attachDragReorder(li, task) {
  const canDrag = task.type !== "folder";
  li.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, textarea")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopMomentumScroll(); // a new touch always takes over from a fling in progress

    const listEl = el.tasksList;
    const startY = e.clientY;
    let lastY = e.clientY;
    let lastMoveTime = performance.now();
    let scrollVelocity = 0; // px/ms, for momentum once a manual scroll is released
    const pointerId = e.pointerId;
    const isTouch = e.pointerType !== "mouse";
    let longPressTimer = null;
    let engaged = false;
    let manualScrolling = false; // pre-engage swipe decided to be a scroll, not a drag
    let dropIndex = null;
    let dropFolderId = null; // set instead of dropIndex while hovering a folder
    let siblingMidpoints = null;
    let gapPositions = null;
    let folderTargets = null;
    let lastClientY = null; // last real pointer position, reused by the auto-scroll loop below
    let autoScrollSpeed = 0; // px per frame, signed; 0 means not auto-scrolling
    let autoScrollRAF = null;

    function engage() {
      engaged = true;
      li.classList.add("dragging");
      siblingMidpoints = captureSiblingMidpoints(listEl, li);
      gapPositions = captureGapPositions(listEl, li);
      folderTargets = captureFolderTargets(listEl, li, task);
      try { li.setPointerCapture(pointerId); } catch { /* ignore */ }
    }

    // Shared between real pointer moves and the auto-scroll loop below (which
    // re-runs this each frame using the last known pointer position, since
    // the page moving under a still finger changes the target the same way
    // the finger moving would).
    function updateDropTarget(clientY) {
      const pageY = clientY + window.scrollY;
      const hovered = folderTargets.find((f) => pageY >= f.top && pageY <= f.bottom);
      if (hovered) {
        dropIndex = null;
        dropFolderId = hovered.id;
        removeDropLine(listEl);
        setDropTargetFolder(listEl, hovered.id);
        return;
      }
      dropFolderId = null;
      clearDropTargetFolder(listEl);
      dropIndex = dropIndexForY(siblingMidpoints, pageY);
      showDropLine(listEl, gapPositions[dropIndex]);
    }

    // Dragging near the top or bottom of the visible area scrolls the page,
    // the way most drag-to-reorder lists do — otherwise a task could never
    // be dragged to a position that isn't already on screen. Speed ramps up
    // the closer the pointer is to the edge. Runs via its own rAF loop so it
    // keeps going while the pointer holds still near the edge, not just on
    // each new pointermove.
    function updateAutoScroll(clientY) {
      const headerBottom = el.appTop.getBoundingClientRect().bottom;
      const viewportHeight = window.innerHeight;
      if (clientY < headerBottom + EDGE_ZONE) {
        const depth = Math.min(1, (headerBottom + EDGE_ZONE - clientY) / EDGE_ZONE);
        autoScrollSpeed = -Math.ceil(MAX_AUTOSCROLL_SPEED * depth);
      } else if (clientY > viewportHeight - EDGE_ZONE) {
        const depth = Math.min(1, (clientY - (viewportHeight - EDGE_ZONE)) / EDGE_ZONE);
        autoScrollSpeed = Math.ceil(MAX_AUTOSCROLL_SPEED * depth);
      } else {
        autoScrollSpeed = 0;
      }

      if (autoScrollSpeed !== 0 && autoScrollRAF === null) {
        const step = () => {
          if (autoScrollSpeed === 0) {
            autoScrollRAF = null;
            return;
          }
          const next = Math.max(0, Math.min(maxScrollY(), window.scrollY + autoScrollSpeed));
          window.scrollTo(0, next);
          if (lastClientY !== null) updateDropTarget(lastClientY);
          autoScrollRAF = requestAnimationFrame(step);
        };
        autoScrollRAF = requestAnimationFrame(step);
      } else if (autoScrollSpeed === 0 && autoScrollRAF !== null) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
      }
    }

    function stopAutoScroll() {
      autoScrollSpeed = 0;
      if (autoScrollRAF) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
      }
    }

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;

      if (manualScrolling) {
        // Task rows have touch-action:none (see CSS) so the browser never
        // starts its own scroll for a touch that began on one — we emulate
        // it ourselves once a pre-engage swipe turns out to be a scroll,
        // rather than a deliberate long-press-then-drag. Tracking velocity
        // here is what lets the scroll keep gliding after release instead
        // of just stopping — see startMomentumScroll.
        const now = performance.now();
        const dy = lastY - ev.clientY;
        const dt = now - lastMoveTime;
        window.scrollBy(0, dy);
        if (dt > 0) scrollVelocity = dy / dt;
        lastY = ev.clientY;
        lastMoveTime = now;
        return;
      }

      const dy = ev.clientY - startY;
      if (!engaged) {
        if (!isTouch && !canDrag) {
          return;
        } else if (!isTouch && Math.abs(dy) > 4) {
          engage();
        } else if (isTouch && Math.abs(dy) > 10) {
          // Moved before the long-press fired — treat as a normal scroll.
          clearTimeout(longPressTimer);
          manualScrolling = true;
          window.scrollBy(0, lastY - ev.clientY);
          lastY = ev.clientY;
          lastMoveTime = performance.now();
          return;
        } else {
          return;
        }
      }
      ev.preventDefault();

      lastClientY = ev.clientY;
      updateAutoScroll(ev.clientY);
      updateDropTarget(ev.clientY);
    }

    function finish(shouldDrop) {
      clearTimeout(longPressTimer);
      stopAutoScroll();
      if (engaged) {
        try { li.releasePointerCapture(pointerId); } catch { /* ignore */ }
        li.classList.remove("dragging");
        removeDropLine(listEl);
        clearDropTargetFolder(listEl);
        if (shouldDrop && dropFolderId) {
          addTaskToFolder(task.id, dropFolderId);
        } else if (shouldDrop && dropIndex !== null) {
          moveEntryTo(task, dropIndex);
        }
        suppressClickUntil = Date.now() + 300;
      } else if (manualScrolling) {
        startMomentumScroll(scrollVelocity);
      }
      cleanup();
    }

    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      finish(true);
    }

    function onCancel(ev) {
      if (ev.pointerId !== pointerId) return;
      finish(false);
    }

    function cleanup() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);

    if (isTouch && canDrag) {
      longPressTimer = setTimeout(engage, 400);
    }
  });
}

/* ---------- inline editing (triggered from the toolbar) ---------- */

function startEdit(listName, task, textNode) {
  editingKey = `${listName}:${task.id}`;
  const container = textNode.parentElement;
  const editWrap = document.createElement("div");
  editWrap.className = "task-edit-area";

  const errorMsg = document.createElement("p");
  errorMsg.className = "field-error hidden";

  const doSave = () => {
    const badMarker = findUnrecognizedRecurrenceMarker(textarea.value);
    if (badMarker) {
      errorMsg.textContent = `"[[${badMarker}]]" isn't a recognized recurrence — fix or remove it to save. ${RECURRENCE_HELP}`;
      errorMsg.classList.remove("hidden");
      return;
    }
    editingKey = null;
    selected = { listName, id: task.id };
    editTaskText(listName, task.id, textarea.value);
  };

  const textarea = document.createElement("textarea");
  textarea.rows = 1; // just a pre-JS fallback — attachSmartTextarea auto-fits the real height
  textarea.value = task.text;
  attachSmartTextarea(textarea, { onSubmit: doSave });
  textarea.addEventListener("input", () => errorMsg.classList.add("hidden"));

  // Highlight mode swaps the textarea for a rendered, click-to-toggle view
  // of the same text — clicking a line flips its "==...==" marker directly
  // in textarea.value, which stays the single source of truth either way,
  // so Save/Cancel and the recurrence check don't need to know which view
  // is currently showing.
  const highlightView = document.createElement("div");
  highlightView.className = "task-highlight-view hidden";

  function rebuildHighlightView() {
    buildHighlightView(highlightView, textarea.value, (i) => {
      const lines = textarea.value.split("\n");
      lines[i] = toggleLineHighlightText(lines[i]);
      textarea.value = lines.join("\n");
      rebuildHighlightView();
    });
  }

  const actions = document.createElement("div");
  actions.className = "task-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", doSave);
  const highlightBtn = document.createElement("button");
  highlightBtn.type = "button";
  highlightBtn.textContent = "Highlight";
  highlightBtn.addEventListener("click", () => {
    const highlightMode = textarea.classList.toggle("hidden");
    highlightView.classList.toggle("hidden", !highlightMode);
    highlightBtn.classList.toggle("active", highlightMode);
    if (highlightMode) {
      rebuildHighlightView();
    } else {
      autoResizeTextarea(textarea);
      textarea.focus();
    }
  });
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    editingKey = null;
    selected = { listName, id: task.id };
    render();
  });
  actions.append(saveBtn, highlightBtn, cancelBtn);
  editWrap.append(textarea, highlightView, errorMsg, actions);

  container.replaceChild(editWrap, textNode);
  // Re-measure now that the textarea is actually laid out in the live DOM —
  // scrollHeight on a still-detached element (as it was inside
  // attachSmartTextarea above) isn't reliable.
  autoResizeTextarea(textarea);
  textarea.focus();
}

/* ---------- toolbar ---------- */

const TOOLBAR_ACTIONS_BY_TAB = {
  tasks: ["complete", "delete", "send-calendar", "pause", "in-progress", "edit"],
  calendar: ["complete", "delete", "send-tasks", "edit"],
  completed: ["resurrect"],
  deleted: ["resurrect", "delete"],
};

function toolbarActionButtons() {
  return {
    complete: el.tbComplete,
    delete: el.tbDelete,
    "send-calendar": el.tbSendCalendar,
    "send-tasks": el.tbSendTasks,
    pause: el.tbPause,
    "in-progress": el.tbInProgress,
    edit: el.tbEdit,
    resurrect: el.tbResurrect,
  };
}

function updateToolbar() {
  const allowed = new Set(TOOLBAR_ACTIONS_BY_TAB[currentTab] || []);
  const selectedTask = selected && findEntry(selected.listName, selected.id);
  // Only "edit" (renaming the folder itself) applies to a folder selection —
  // everything else here is about its contents, via the per-child Resume
  // button.
  const selectedIsFolder = !!selectedTask && selectedTask.type === "folder";
  for (const [action, btn] of Object.entries(toolbarActionButtons())) {
    const isRelevant = allowed.has(action);
    btn.classList.toggle("hidden", !isRelevant);
    btn.disabled = !isRelevant || !selected || (selectedIsFolder && action !== "edit");
  }
  // Reflects the selected task's own state, the way Highlight's button does
  // during editing — not just whether the action is available right now.
  el.tbInProgress.classList.toggle("active", !!selectedTask && !!selectedTask.inProgress);
  const deleteLabel = currentTab === "deleted" ? "Delete Permanently" : "Delete";
  el.tbDelete.title = deleteLabel;
  el.tbDelete.setAttribute("aria-label", deleteLabel);
  renderActionPopover();
}

function buildDatePicker(onConfirm, onCancel) {
  const template = document.getElementById("date-picker-template");
  const node = template.content.firstElementChild.cloneNode(true);
  const input = node.querySelector(".date-picker-input");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  input.value = tomorrow.toLocaleDateString("en-CA");
  input.min = todayLocal();

  // Picking a date submits immediately — no separate confirm click needed.
  // The checkmark stays as a fallback for accepting the pre-filled default
  // without touching the field (some browsers don't fire "change" unless
  // the value actually changes).
  input.addEventListener("change", () => {
    if (input.value) onConfirm(input.value);
  });
  node.querySelector(".date-picker-confirm").addEventListener("click", () => {
    if (!input.value) return;
    onConfirm(input.value);
  });
  node.querySelector(".date-picker-cancel").addEventListener("click", onCancel);
  return node;
}

function buildPausePicker(existingFolders, onConfirm, onCancel) {
  const template = document.getElementById("pause-picker-template");
  const node = template.content.firstElementChild.cloneNode(true);
  const input = node.querySelector(".pause-picker-input");

  const trySubmit = () => {
    const value = input.value.trim();
    if (value) onConfirm(value);
  };
  node.querySelector(".pause-picker-confirm").addEventListener("click", trySubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      trySubmit();
    }
  });
  node.querySelector(".pause-picker-cancel").addEventListener("click", onCancel);

  const foldersWrap = node.querySelector(".pause-picker-folders");
  for (const folder of existingFolders) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pause-folder-pill";
    pill.textContent = folder.blocker;
    pill.addEventListener("click", () => onConfirm(folder.blocker));
    foldersWrap.append(pill);
  }
  return node;
}

/* ---------- account popover: sign-in state + JSON backup ---------- */

function serializeBackup() {
  return JSON.stringify(state, null, 2);
}

function isValidBackupShape(obj) {
  return !!obj && ["tasks", "calendar", "completed", "deleted"].every((k) => Array.isArray(obj[k]));
}

function applyBackup(obj) {
  commit("replaceState", {
    tasks: obj.tasks,
    calendar: obj.calendar,
    completed: obj.completed,
    deleted: obj.deleted,
  });
}

// A plain-text export/import round trip — handy as a general backup, and
// specifically how existing data gets carried over onto a newly signed-in
// account (there's no automatic migration, since guessing which uid "should"
// inherit old data isn't safe to do automatically).
function buildBackupSection() {
  const wrap = document.createElement("div");
  wrap.className = "account-backup";

  const label = document.createElement("p");
  label.className = "account-hint";
  label.textContent = "Back up your list as text, or restore from a backup.";
  wrap.append(label);

  const row = document.createElement("div");
  row.className = "account-actions";
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export";
  const importBtn = document.createElement("button");
  importBtn.textContent = "Import";
  row.append(exportBtn, importBtn);
  wrap.append(row);

  const exportArea = document.createElement("div");
  exportArea.className = "account-backup-area hidden";
  const exportTextarea = document.createElement("textarea");
  exportTextarea.readOnly = true;
  exportTextarea.rows = 6;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(exportTextarea.value);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    } catch {
      exportTextarea.select(); // clipboard API unavailable — let them copy manually
    }
  });
  exportArea.append(exportTextarea, copyBtn);
  wrap.append(exportArea);

  const importArea = document.createElement("div");
  importArea.className = "account-backup-area hidden";
  const importTextarea = document.createElement("textarea");
  importTextarea.rows = 6;
  importTextarea.placeholder = "Paste an exported backup here";
  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.textContent = "Load backup";
  const importError = document.createElement("p");
  importError.className = "field-error hidden";
  loadBtn.addEventListener("click", () => {
    let parsed;
    try {
      parsed = JSON.parse(importTextarea.value);
    } catch {
      importError.textContent = "That doesn't look like valid backup JSON.";
      importError.classList.remove("hidden");
      return;
    }
    if (!isValidBackupShape(parsed)) {
      importError.textContent = "That JSON doesn't look like a to-do backup.";
      importError.classList.remove("hidden");
      return;
    }
    if (!window.confirm("Replace this device's current list with the pasted backup? This can't be undone.")) {
      return;
    }
    pendingPopover = null;
    applyBackup(parsed);
  });
  importArea.append(importTextarea, loadBtn, importError);
  wrap.append(importArea);

  exportBtn.addEventListener("click", () => {
    importArea.classList.add("hidden");
    const nowHidden = exportArea.classList.toggle("hidden");
    if (!nowHidden) {
      exportTextarea.value = serializeBackup();
      exportTextarea.select();
    }
  });
  importBtn.addEventListener("click", () => {
    exportArea.classList.add("hidden");
    importArea.classList.toggle("hidden");
  });

  return wrap;
}

function buildAccountPopover() {
  const wrap = document.createElement("div");
  wrap.className = "account-popover";

  // Unlike the other popovers, this one isn't tied to a task, so there's no
  // natural action that closes it — it needs its own explicit close button
  // (matching search's) rather than relying on re-tapping the toolbar icon.
  const header = document.createElement("div");
  header.className = "account-popover-header";
  const title = document.createElement("strong");
  title.textContent = "Account";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "account-close-btn";
  closeBtn.title = "Close";
  closeBtn.textContent = "❌";
  closeBtn.addEventListener("click", () => {
    pendingPopover = null;
    render();
  });
  header.append(title, closeBtn);
  wrap.append(header);

  const status = document.createElement("p");
  status.className = "account-status";
  const authRow = document.createElement("div");
  authRow.className = "account-actions";

  if (!authUser) {
    status.textContent = "Connecting…";
  } else if (authUser.isAnonymous) {
    status.textContent = "Using a guest list on this device only.";
    const googleBtn = document.createElement("button");
    googleBtn.textContent = "Sign in with Google";
    googleBtn.addEventListener("click", () => {
      pendingPopover = null;
      render();
      signInWithGoogleUpgrade();
    });
    authRow.append(googleBtn);
  } else {
    status.textContent = `Signed in as ${authUser.email || authUser.displayName || "your Google account"}.`;
    const signOutBtn = document.createElement("button");
    signOutBtn.textContent = "Sign out";
    signOutBtn.addEventListener("click", () => {
      pendingPopover = null;
      render();
      signOutAccount();
    });
    authRow.append(signOutBtn);
  }
  wrap.append(status, authRow);

  if (authUser && authUser.isAnonymous) {
    const hint = document.createElement("p");
    hint.className = "account-hint";
    hint.textContent = "Saves this list to your Google account so you can pick it up on other devices.";
    wrap.append(hint);
  }

  wrap.append(document.createElement("hr"), buildBackupSection());
  return wrap;
}

function renderActionPopover() {
  el.appHeader.querySelector(".date-picker, .pause-picker, .account-popover")?.remove();
  // Unlike the others below, the account popover isn't about a selected
  // task — it's always available regardless of what (if anything) is
  // selected.
  if (pendingPopover === "account") {
    el.appHeader.append(buildAccountPopover());
    return;
  }
  if (!pendingPopover || !selected) return;
  const { listName, id } = selected;
  if (!findEntry(listName, id)) {
    pendingPopover = null;
    return;
  }

  if (pendingPopover === "send-calendar") {
    el.appHeader.append(
      buildDatePicker(
        (date) => {
          selected = null;
          pendingPopover = null;
          moveToCalendar(id, date);
        },
        () => {
          pendingPopover = null;
          render();
        }
      )
    );
  } else if (pendingPopover === "complete-recurring") {
    el.appHeader.append(
      buildDatePicker(
        (date) => {
          selected = null;
          pendingPopover = null;
          completeTask(listName, id, date);
        },
        () => {
          pendingPopover = null;
          render();
        }
      )
    );
  } else if (pendingPopover === "pause") {
    const existingFolders = displayTasks().filter((t) => t.type === "folder");
    el.appHeader.append(
      buildPausePicker(
        existingFolders,
        (blockerName) => {
          selected = null;
          pendingPopover = null;
          pauseTask(id, blockerName);
        },
        () => {
          pendingPopover = null;
          render();
        }
      )
    );
  }
}

el.tbAccount.addEventListener("click", () => {
  pendingPopover = pendingPopover === "account" ? null : "account";
  render();
});

el.tbComplete.addEventListener("click", () => {
  if (!selected) return;
  const { listName, id } = selected;
  const task = findEntry(listName, id);
  if (!task) return;
  const recurrence = parseRecurrence(task.text);
  if (recurrence === "prompt") {
    pendingPopover = "complete-recurring";
    render();
    return;
  }
  selected = null;
  const nextDate = recurrence ? computeNextDate(recurrence, todayLocal()) : null;
  completeTask(listName, id, nextDate);
});

el.tbDelete.addEventListener("click", () => {
  if (!selected) return;
  const { listName, id } = selected;
  selected = null;
  if (listName === "deleted") {
    permanentlyDeleteTask(id);
  } else {
    deleteTask(listName, id);
  }
});

el.tbSendCalendar.addEventListener("click", () => {
  if (!selected) return;
  pendingPopover = pendingPopover === "send-calendar" ? null : "send-calendar";
  render();
});

el.tbPause.addEventListener("click", () => {
  if (!selected) return;
  pendingPopover = pendingPopover === "pause" ? null : "pause";
  render();
});

el.tbInProgress.addEventListener("click", () => {
  if (!selected) return;
  toggleInProgress(selected.id);
});

el.tbSendTasks.addEventListener("click", () => {
  if (!selected) return;
  const { id } = selected;
  selected = null;
  moveToTasks(id);
});

el.tbEdit.addEventListener("click", () => {
  if (!selected) return;
  const { listName, id } = selected;
  const task = findEntry(listName, id);
  if (!task) return;
  const row = document.querySelector(`.task-item[data-task-id="${id}"]`);
  if (task.type === "folder") {
    const labelNode = row?.querySelector(".folder-label");
    if (!labelNode) return;
    selected = null;
    startFolderRename(task, labelNode);
    updateToolbar();
    return;
  }
  const textNode = row?.querySelector(".task-text");
  if (!textNode) return;
  selected = null;
  startEdit(listName, task, textNode);
  updateToolbar();
});

el.tbResurrect.addEventListener("click", () => {
  if (!selected) return;
  const { listName, id } = selected;
  selected = null;
  if (listName === "completed") {
    resurrectCompletedTask(id);
  } else {
    restoreFromDeleted(id);
  }
});

/* ---------- list rendering ---------- */

// Shows "Loading…" instead of the tab's real empty message until the first
// snapshot for the current account has arrived — otherwise a brand new
// sign-in or account switch flashes "No tasks" for a moment, which reads as
// "my data is gone" rather than "still loading".
function updateEmptyMessage(emptyEl, hasItems, emptyText) {
  if (!dataLoaded) {
    emptyEl.textContent = "Loading…";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.textContent = emptyText;
    emptyEl.classList.toggle("hidden", hasItems);
  }
}

function renderTasks() {
  if (editingKey && editingKey.startsWith("tasks:")) return;
  const list = el.tasksList;
  list.innerHTML = "";
  updateEmptyMessage(el.tasksEmpty, state.tasks.length > 0, "No tasks. Tap ➕ above to add one.");

  displayTasks().forEach((task) => {
    if (task.type === "folder") {
      const li = buildFolderRow(task);
      list.append(li);
      attachDragReorder(li, task);
      return;
    }
    const li = buildTaskRow("tasks", task);
    list.append(li);
    attachDragReorder(li, task);
  });
}

function renderCalendar() {
  if (editingKey && editingKey.startsWith("calendar:")) return;
  const container = el.calendarList;
  container.innerHTML = "";
  updateEmptyMessage(el.calendarEmpty, state.calendar.length > 0, "No tasks scheduled.");

  const groups = {};
  for (const task of state.calendar) {
    (groups[task.targetDate] ||= []).push(task);
  }
  const dates = Object.keys(groups).sort();

  for (const date of dates) {
    const groupEl = document.createElement("div");
    groupEl.className = "calendar-group";
    const header = document.createElement("div");
    header.className = "calendar-group-header";
    header.textContent = formatDate(date);
    groupEl.append(header);

    const ul = document.createElement("ul");
    ul.className = "task-list";
    for (const task of groups[date]) {
      ul.append(buildTaskRow("calendar", task));
    }
    groupEl.append(ul);
    container.append(groupEl);
  }
}

function renderCompleted() {
  const list = el.completedList;
  list.innerHTML = "";
  updateEmptyMessage(el.completedEmpty, state.completed.length > 0, "No completed tasks yet.");

  state.completed.forEach((task) => {
    const metaText = `Completed ${formatTimestamp(task.completedAt)}`;
    list.append(buildTaskRow("completed", task, metaText));
  });
}

function renderDeleted() {
  const list = el.deletedList;
  list.innerHTML = "";
  updateEmptyMessage(el.deletedEmpty, state.deleted.length > 0, "Nothing deleted.");

  state.deleted.forEach((task) => {
    const metaText = `Deleted ${formatTimestamp(task.deletedAt)} (from ${task.sourceList === "calendar" ? "Calendar" : "Tasks"})`;
    list.append(buildTaskRow("deleted", task, metaText));
  });
}

/* ---------- tabs ---------- */

function activateTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`${tabName}-panel`).classList.add("active");
  currentTab = tabName;
  selected = null;
  pendingPopover = null;
}

el.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  activateTab(btn.dataset.tab);
  render();
});

/* ---------- add task ---------- */

function closeAddPanel() {
  el.newTaskInput.value = "";
  autoResizeTextarea(el.newTaskInput);
  el.newTaskInput.blur(); // dismiss the on-screen keyboard on mobile
  el.addTaskPanel.classList.add("hidden");
  el.addTaskError.classList.add("hidden");
}

function submitNewTask() {
  const badMarker = findUnrecognizedRecurrenceMarker(el.newTaskInput.value);
  if (badMarker) {
    el.addTaskError.textContent = `"[[${badMarker}]]" isn't a recognized recurrence — fix or remove it to add. ${RECURRENCE_HELP}`;
    el.addTaskError.classList.remove("hidden");
    return;
  }
  addTask(el.newTaskInput.value);
  closeAddPanel();
}

attachSmartTextarea(el.newTaskInput, { onSubmit: submitNewTask });
el.newTaskInput.addEventListener("input", () => el.addTaskError.classList.add("hidden"));
el.confirmAddBtn.addEventListener("click", submitNewTask);
el.cancelAddBtn.addEventListener("click", closeAddPanel);

el.tbAdd.addEventListener("click", () => {
  const nowHidden = el.addTaskPanel.classList.toggle("hidden");
  if (nowHidden) {
    el.newTaskInput.blur();
  } else {
    closeSearchPanel();
    el.newTaskInput.focus();
  }
});

/* ---------- search ---------- */

const SEARCH_LISTS = ["tasks", "calendar", "completed", "deleted"];

function getSearchScope() {
  return SEARCH_LISTS.filter((name) => document.getElementById(`search-scope-${name}`).checked);
}

function searchMetaFor(listName, task, folder) {
  if (folder) return `Tasks · Paused (${folder.blocker})`;
  switch (listName) {
    case "tasks": return "Tasks";
    case "calendar": return `Calendar · ${formatDate(task.targetDate)}`;
    case "completed": return `Completed · ${formatTimestamp(task.completedAt)}`;
    case "deleted": return `Deleted · ${formatTimestamp(task.deletedAt)}`;
    default: return "";
  }
}

function renderSearchResults() {
  const query = el.searchInput.value.trim().toLowerCase();
  const scope = getSearchScope();
  const results = [];
  for (const listName of scope) {
    for (const task of state[listName]) {
      if (query && !String(task.text || "").toLowerCase().includes(query)) continue;
      // A paused task is tagged with the folder it's under, and jumping to
      // it opens that folder (see jumpToTask).
      const folder =
        listName === "tasks" && folderKey(task.blocker)
          ? { id: folderIdFor(task.blocker), blocker: String(task.blocker).trim() }
          : null;
      results.push({ listName, task, folder });
    }
  }

  el.searchResults.innerHTML = "";
  el.searchEmpty.classList.toggle("hidden", results.length > 0);
  for (const { listName, task, folder } of results) {
    const li = document.createElement("li");
    li.className = "task-item selectable";
    if (task.inProgress) li.classList.add("in-progress");
    const textWrap = document.createElement("div");
    textWrap.className = "task-text";
    renderTaskTextInto(textWrap, task.text);
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = searchMetaFor(listName, task, folder);
    li.append(textWrap, meta);
    li.addEventListener("click", () => jumpToTask(listName, task.id, folder));
    el.searchResults.append(li);
  }
}

// Closes search, switches to the task's tab, selects it so the toolbar can
// act on it right away, and briefly flashes the row so it's easy to spot.
// For a paused task, "selecting" it means opening its folder instead — a
// folder's contents aren't individually selectable, only reachable by
// expanding it — and the flash still targets the task's own row inside.
function jumpToTask(listName, id, folder) {
  closeSearchPanel();
  activateTab(listName);
  selected = folder ? { listName: "tasks", id: folder.id } : { listName, id };
  render();

  requestAnimationFrame(() => {
    const row = document.querySelector(`.task-item[data-task-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("jump-flash");
    row.addEventListener("animationend", () => row.classList.remove("jump-flash"), { once: true });
  });
}

function openSearchPanel() {
  el.addTaskPanel.classList.add("hidden");
  for (const name of SEARCH_LISTS) {
    document.getElementById(`search-scope-${name}`).checked = name === currentTab;
  }
  el.searchInput.value = "";
  el.tabs.classList.add("hidden");
  el.main.classList.add("hidden");
  el.searchPanel.classList.remove("hidden");
  renderSearchResults();
  el.searchInput.focus();
}

function closeSearchPanel() {
  el.searchPanel.classList.add("hidden");
  el.tabs.classList.remove("hidden");
  el.main.classList.remove("hidden");
}

el.tbSearch.addEventListener("click", () => {
  if (el.searchPanel.classList.contains("hidden")) {
    openSearchPanel();
  } else {
    closeSearchPanel();
  }
});
el.searchCloseBtn.addEventListener("click", closeSearchPanel);
el.searchInput.addEventListener("input", renderSearchResults);
el.searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSearchPanel();
});
for (const name of SEARCH_LISTS) {
  document.getElementById(`search-scope-${name}`).addEventListener("change", renderSearchResults);
}

/* ---------- config banner ---------- */

el.configSave.addEventListener("click", () => {
  el.configError.textContent = "";
  let parsed;
  try {
    parsed = JSON.parse(el.configInput.value);
  } catch {
    el.configError.textContent = "That doesn't look like valid JSON.";
    return;
  }
  if (isPlaceholderConfig(parsed)) {
    el.configError.textContent = "Missing an apiKey — copy the full config object from Firebase.";
    return;
  }
  localStorage.setItem("firebaseConfigOverride", JSON.stringify(parsed));
  location.reload();
});

/* ---------- boot ---------- */

// Each signed-in user (anonymous or Google-linked) gets their own document
// at users/{uid}, instead of everyone sharing one — see attachUserDoc.
// Detaches the previous listener first, since this runs again whenever the
// signed-in uid changes (first sign-in, linking to Google, or switching to
// an already-linked account on a different device).
function attachUserDoc(uid) {
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }
  // Not loaded again until this (possibly new) doc actually produces a
  // snapshot — see the dataLoaded comment on commit() for why that guard
  // matters, and renderTasks/etc. for the "Loading…" state this drives.
  // Also clear state itself, so switching accounts can't flash the
  // previous account's tasks alongside the "Loading…" message if something
  // triggers a render before the new doc's first snapshot arrives.
  dataLoaded = false;
  state = { tasks: [], calendar: [], completed: [], deleted: [] };
  // Each account has its own queue of not-yet-committed changes (see the
  // persistence comment), kept in localStorage so a change made offline
  // survives a reload. Anything still queued for the previous account
  // stays persisted under its own key and is picked back up on return.
  queueStorageKey = `todoPendingOps:${uid}`;
  pendingOps = loadQueue(queueStorageKey);
  render(); // shows "Loading…" immediately instead of leaving the previous account's list on screen
  docRef = fb.doc(db, "users", uid);
  unsubscribeSnapshot = fb.onSnapshot(
    docRef,
    { includeMetadataChanges: true },
    (snap) => {
      dataLoaded = true;
      // The document as the server has it, with this tab's own not-yet-
      // committed changes replayed on top — so an in-flight edit never
      // flickers away and back, and a change made offline stays visible
      // until it's actually been merged in.
      state = withPendingOps(normalizeState(snap.exists() ? snap.data() : null));
      // fromCache means the SDK isn't currently reaching the server — a
      // reliable "you're offline" signal, unlike hasPendingWrites alone
      // (that's briefly true after any write even while fully online, just
      // from ordinary ack latency).
      if (snap.metadata.fromCache) {
        setSyncStatus(
          pendingOps.length > 0 || snap.metadata.hasPendingWrites
            ? "Offline — changes saved locally, will sync once back online"
            : "Offline — showing last synced data"
        );
      } else if (pendingOps.length === 0) {
        setSyncStatus(""); // connected and caught up
      }
      render();
      promoteDueTasksIfNeeded();
      if (!snap.metadata.fromCache) flushOps(); // back in touch with the server — drain anything queued
    },
    (err) => {
      console.error(err);
      setSyncStatus("Sync error — check console / Firestore rules", true);
    }
  );
}

// Every visitor gets an anonymous account automatically, so everyone's data
// is isolated from the start with no sign-up step. "Sign in with Google"
// (see signInWithGoogleUpgrade) is optional, for anyone who wants their list
// to follow them across devices instead of staying tied to one browser.
async function connectFirebase(config) {
  setSyncStatus("Connecting…");
  try {
    const [{ initializeApp }, firestoreMod, aMod] = await Promise.all([
      import(/* @vite-ignore */ FIREBASE_APP_URL),
      import(/* @vite-ignore */ FIREBASE_FIRESTORE_URL),
      import(/* @vite-ignore */ FIREBASE_AUTH_URL),
    ]);
    authMod = aMod;
    const app = initializeApp(config);
    db = firestoreMod.getFirestore(app);
    auth = authMod.getAuth(app);

    try {
      // Lets the app read cached data and queue writes while offline, and
      // syncs automatically once a connection comes back — including after
      // fully closing and reopening the app, since the queue is persisted
      // to IndexedDB rather than just held in memory for the page's
      // lifetime. Can fail if another tab already holds the persistence
      // lock, or the browser doesn't support it; the app still works
      // either way, it just won't retain queued writes across a reload.
      await firestoreMod.enableIndexedDbPersistence(db);
    } catch (err) {
      console.warn("Offline persistence not available", err.code || err);
    }

    fb = {
      onSnapshot: firestoreMod.onSnapshot,
      runTransaction: firestoreMod.runTransaction,
      doc: firestoreMod.doc,
    };
  } catch (err) {
    console.error("Failed to load Firebase SDK", err);
    setSyncStatus("Couldn't load Firebase — check your connection and reload", true);
    return;
  }

  authMod.onAuthStateChanged(auth, (user) => {
    authUser = user;
    render(); // refreshes the account popover / button if it's showing
    if (user) {
      attachUserDoc(user.uid);
    } else {
      authMod.signInAnonymously(auth).catch((err) => {
        console.error("Anonymous sign-in failed", err);
        setSyncStatus("Couldn't sign in — check your connection and reload", true);
      });
    }
  });

  setInterval(promoteDueTasksIfNeeded, 60 * 1000);
  // The snapshot listener also flushes once the SDK reconnects, but the
  // browser's own online event usually fires sooner.
  window.addEventListener("online", () => flushOps());
}

// Upgrades the current guest (anonymous) session to a Google account, or
// signs in directly if already past that. If this Google account is
// already linked to a DIFFERENT device's account, linking fails with
// "credential-already-in-use" — offer to switch to that existing account
// instead, which is what makes it possible to pick the same list back up
// on a second device.
async function signInWithGoogleUpgrade() {
  if (!auth || !authMod) return;
  const provider = new authMod.GoogleAuthProvider();
  try {
    if (auth.currentUser && auth.currentUser.isAnonymous) {
      await authMod.linkWithPopup(auth.currentUser, provider);
    } else {
      await authMod.signInWithPopup(auth, provider);
    }
  } catch (err) {
    if (err.code === "auth/credential-already-in-use") {
      const proceed = window.confirm(
        "This Google account already has a saved list from another device. Switch to it? " +
          "This device's current list will be replaced by that one."
      );
      if (proceed) {
        const cred = authMod.GoogleAuthProvider.credentialFromError(err);
        try {
          await authMod.signInWithCredential(auth, cred);
        } catch (err2) {
          console.error("Google sign-in failed", err2);
          setSyncStatus("Google sign-in failed — check console", true);
        }
      }
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      console.error("Google sign-in failed", err);
      setSyncStatus("Google sign-in failed — check console", true);
    }
  }
}

// Drops back to a fresh anonymous session on this device — onAuthStateChanged
// (see connectFirebase) notices the signed-out state and signs back in
// anonymously automatically, landing on a brand new empty guest list.
async function signOutAccount() {
  if (!auth || !authMod) return;
  try {
    await authMod.signOut(auth);
  } catch (err) {
    console.error("Sign-out failed", err);
  }
}

function boot() {
  el.appVersion.textContent = `v${APP_VERSION}`;
  render(); // paint empty state immediately, independent of Firebase
  const config = resolveConfig();
  if (!config) {
    el.configBanner.classList.remove("hidden");
    setSyncStatus("Not connected");
    return;
  }
  connectFirebase(config);
}

boot();

// Precaches the app shell (and the Firebase SDK files) so the app can
// still load with no connection at all, not just sync data once it's
// already open. Registered after boot so it doesn't compete with the
// page's own initial load.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  });
}
