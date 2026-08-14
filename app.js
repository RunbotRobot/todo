import { firebaseConfig as fileConfig } from "./config.js";

// Firebase is loaded lazily (see connectFirebase) so a network hiccup or
// blocked CDN request can't take down the rest of the app — task entry,
// tabs, and editing all work purely client-side already.
const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
const FIREBASE_FIRESTORE_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const INDENT = "    "; // 4 spaces per indent level

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
let fb = null; // holds { setDoc, onSnapshot, runTransaction } once the SDK loads
let editingKey = null; // "listName:id" while a task is being edited inline
let openDatePickerId = null;

const el = {
  configBanner: document.getElementById("config-banner"),
  configInput: document.getElementById("config-input"),
  configSave: document.getElementById("config-save"),
  configError: document.getElementById("config-error"),
  syncStatus: document.getElementById("sync-status"),
  tabs: document.getElementById("tabs"),
  newTaskInput: document.getElementById("new-task-input"),
  addTaskBtn: document.getElementById("add-task-btn"),
  tasksList: document.getElementById("tasks-list"),
  tasksEmpty: document.getElementById("tasks-empty"),
  calendarList: document.getElementById("calendar-list"),
  calendarEmpty: document.getElementById("calendar-empty"),
  completedList: document.getElementById("completed-list"),
  completedEmpty: document.getElementById("completed-empty"),
  deletedList: document.getElementById("deleted-list"),
  deletedEmpty: document.getElementById("deleted-empty"),
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

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------- persistence ---------- */

async function saveState() {
  if (!docRef || !fb) return;
  try {
    await fb.setDoc(docRef, state);
  } catch (err) {
    console.error("Save failed", err);
    setSyncStatus("Save failed — will retry on next change", true);
  }
}

function setSyncStatus(msg, isError = false) {
  el.syncStatus.textContent = msg;
  el.syncStatus.classList.toggle("error", isError);
}

/* ---------- due-date promotion ---------- */

async function promoteDueTasksIfNeeded() {
  if (!docRef || !fb) return;
  const today = todayLocal();
  try {
    await fb.runTransaction(db, async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists()) return;
      const data = snap.data();
      const calendar = data.calendar || [];
      const due = calendar.filter((t) => t.targetDate <= today);
      if (due.length === 0) return;
      const remaining = calendar.filter((t) => t.targetDate > today);
      const promoted = due.map((t) => {
        const { targetDate, sentAt, ...rest } = t;
        return rest;
      });
      const newTasks = [...promoted.reverse(), ...(data.tasks || [])];
      tx.set(docRef, { ...data, tasks: newTasks, calendar: remaining });
    });
  } catch (err) {
    console.error("Promotion check failed", err);
  }
}

/* ---------- mutations ---------- */

function addTask(text) {
  if (!text.trim()) return;
  state.tasks.unshift({ id: uuid(), text, createdAt: new Date().toISOString() });
  render();
  saveState();
}

function findAndRemove(listName, id) {
  const list = state[listName];
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  return list.splice(idx, 1)[0];
}

function completeTask(listName, id) {
  const task = findAndRemove(listName, id);
  if (!task) return;
  const { targetDate, sentAt, ...rest } = task;
  state.completed.unshift({ ...rest, completedAt: new Date().toISOString() });
  render();
  saveState();
}

function deleteTask(listName, id) {
  const task = findAndRemove(listName, id);
  if (!task) return;
  state.deleted.unshift({ ...task, deletedAt: new Date().toISOString(), sourceList: listName });
  render();
  saveState();
}

function moveToCalendar(id, targetDate) {
  const task = findAndRemove("tasks", id);
  if (!task) return;
  state.calendar.push({ ...task, targetDate, sentAt: new Date().toISOString() });
  render();
  saveState();
}

function moveToTasks(id) {
  const task = findAndRemove("calendar", id);
  if (!task) return;
  const { targetDate, sentAt, ...rest } = task;
  state.tasks.unshift(rest);
  render();
  saveState();
}

function restoreFromDeleted(id) {
  const task = findAndRemove("deleted", id);
  if (!task) return;
  const { deletedAt, sourceList, ...rest } = task;
  if (sourceList === "calendar" && rest.targetDate) {
    state.calendar.push(rest);
  } else {
    const { targetDate, sentAt, ...clean } = rest;
    state.tasks.unshift(clean);
  }
  render();
  saveState();
}

function moveTaskUp(id) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx <= 0) return;
  [state.tasks[idx - 1], state.tasks[idx]] = [state.tasks[idx], state.tasks[idx - 1]];
  render();
  saveState();
}

function moveTaskDown(id) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1 || idx >= state.tasks.length - 1) return;
  [state.tasks[idx + 1], state.tasks[idx]] = [state.tasks[idx], state.tasks[idx + 1]];
  render();
  saveState();
}

function editTaskText(listName, id, newText) {
  const task = state[listName].find((t) => t.id === id);
  if (!task) return;
  task.text = newText;
  render();
  saveState();
}

/* ---------- smart textarea: Tab and ">" indentation ---------- */

function attachSmartTextarea(textarea) {
  let composing = false;
  textarea.addEventListener("compositionstart", () => (composing = true));
  textarea.addEventListener("compositionend", () => (composing = false));

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      insertAtCursor(textarea, INDENT);
    }
  });

  textarea.addEventListener("input", () => {
    if (composing) return;
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
  });
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

/* ---------- rendering ---------- */

function render() {
  renderTasks();
  renderCalendar();
  renderCompleted();
  renderDeleted();
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

function buildTaskTextNode(listName, task) {
  const key = `${listName}:${task.id}`;
  const wrap = document.createElement("div");
  wrap.className = "task-text";
  wrap.textContent = task.text;
  wrap.title = "Click to edit";
  wrap.addEventListener("click", () => startEdit(listName, task, wrap));
  return wrap;
}

function startEdit(listName, task, textNode) {
  editingKey = `${listName}:${task.id}`;
  const container = textNode.parentElement;
  const editWrap = document.createElement("div");
  editWrap.className = "task-edit-area";

  const textarea = document.createElement("textarea");
  textarea.rows = Math.max(2, task.text.split("\n").length);
  textarea.value = task.text;
  attachSmartTextarea(textarea);

  const actions = document.createElement("div");
  actions.className = "task-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    editingKey = null;
    editTaskText(listName, task.id, textarea.value);
  });
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    editingKey = null;
    render();
  });
  actions.append(saveBtn, cancelBtn);
  editWrap.append(textarea, actions);

  container.replaceChild(editWrap, textNode);
  textarea.focus();
}

function buildDatePicker(task, onConfirm) {
  const template = document.getElementById("date-picker-template");
  const node = template.content.firstElementChild.cloneNode(true);
  const input = node.querySelector(".date-picker-input");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  input.value = tomorrow.toLocaleDateString("en-CA");
  input.min = todayLocal();

  node.querySelector(".date-picker-confirm").addEventListener("click", () => {
    if (!input.value) return;
    openDatePickerId = null;
    onConfirm(input.value);
  });
  node.querySelector(".date-picker-cancel").addEventListener("click", () => {
    openDatePickerId = null;
    render();
  });
  return node;
}

function renderTasks() {
  if (editingKey && editingKey.startsWith("tasks:")) return;
  const list = el.tasksList;
  list.innerHTML = "";
  el.tasksEmpty.classList.toggle("hidden", state.tasks.length > 0);

  state.tasks.forEach((task, idx) => {
    const li = document.createElement("li");
    li.className = "task-item";

    const reorderCol = document.createElement("div");
    reorderCol.className = "reorder-col";
    const upBtn = makeIconBtn("▲", "Move up", () => moveTaskUp(task.id), "small");
    const downBtn = makeIconBtn("▼", "Move down", () => moveTaskDown(task.id), "small");
    if (idx === 0) upBtn.disabled = true;
    if (idx === state.tasks.length - 1) downBtn.disabled = true;
    reorderCol.append(upBtn, downBtn);

    const textNode = buildTaskTextNode("tasks", task);

    const actionsCol = document.createElement("div");
    actionsCol.className = "actions-col";
    const actionsRow = document.createElement("div");
    actionsRow.className = "actions-row";
    actionsRow.append(
      makeIconBtn("✅", "Complete", () => completeTask("tasks", task.id)),
      makeIconBtn("🗑️", "Delete", () => deleteTask("tasks", task.id)),
      makeIconBtn("➡️", "Send to Calendar", (e) => {
        e.stopPropagation();
        openDatePickerId = openDatePickerId === task.id ? null : task.id;
        render();
      })
    );
    actionsCol.append(actionsRow);

    if (openDatePickerId === task.id) {
      actionsCol.append(buildDatePicker(task, (date) => moveToCalendar(task.id, date)));
    }

    li.append(reorderCol, textNode, actionsCol);
    list.append(li);
  });
}

function renderCalendar() {
  if (editingKey && editingKey.startsWith("calendar:")) return;
  const container = el.calendarList;
  container.innerHTML = "";
  el.calendarEmpty.classList.toggle("hidden", state.calendar.length > 0);

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
      const li = document.createElement("li");
      li.className = "task-item";
      const textNode = buildTaskTextNode("calendar", task);
      const actionsCol = document.createElement("div");
      actionsCol.className = "actions-col";
      const actionsRow = document.createElement("div");
      actionsRow.className = "actions-row";
      actionsRow.append(
        makeIconBtn("✅", "Complete", () => completeTask("calendar", task.id)),
        makeIconBtn("🗑️", "Delete", () => deleteTask("calendar", task.id)),
        makeIconBtn("⬅️", "Send back to Tasks", () => moveToTasks(task.id))
      );
      actionsCol.append(actionsRow);
      li.append(textNode, actionsCol);
      ul.append(li);
    }
    groupEl.append(ul);
    container.append(groupEl);
  }
}

function renderCompleted() {
  const list = el.completedList;
  list.innerHTML = "";
  el.completedEmpty.classList.toggle("hidden", state.completed.length > 0);

  state.completed.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task-item";
    const inner = document.createElement("div");
    inner.style.flex = "1";
    const textNode = document.createElement("div");
    textNode.className = "task-text";
    textNode.textContent = task.text;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `Completed ${formatTimestamp(task.completedAt)}`;
    inner.append(textNode, meta);
    li.append(inner);
    list.append(li);
  });
}

function renderDeleted() {
  if (editingKey && editingKey.startsWith("deleted:")) return;
  const list = el.deletedList;
  list.innerHTML = "";
  el.deletedEmpty.classList.toggle("hidden", state.deleted.length > 0);

  state.deleted.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task-item";
    const inner = document.createElement("div");
    inner.style.flex = "1";
    const textNode = document.createElement("div");
    textNode.className = "task-text";
    textNode.textContent = task.text;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `Deleted ${formatTimestamp(task.deletedAt)} (from ${task.sourceList === "calendar" ? "Calendar" : "Tasks"})`;
    inner.append(textNode, meta);

    const actionsCol = document.createElement("div");
    actionsCol.className = "actions-col";
    actionsCol.append(makeIconBtn("🧟", "Resurrect (restore)", () => restoreFromDeleted(task.id)));

    li.append(inner, actionsCol);
    list.append(li);
  });
}

/* ---------- tabs ---------- */

el.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`${btn.dataset.tab}-panel`).classList.add("active");
});

/* ---------- add task ---------- */

attachSmartTextarea(el.newTaskInput);
el.addTaskBtn.addEventListener("click", () => {
  addTask(el.newTaskInput.value);
  el.newTaskInput.value = "";
  el.newTaskInput.focus();
});
el.newTaskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    el.addTaskBtn.click();
  }
});

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

async function connectFirebase(config) {
  setSyncStatus("Connecting…");
  let mod;
  try {
    const [{ initializeApp }, firestoreMod] = await Promise.all([
      import(/* @vite-ignore */ FIREBASE_APP_URL),
      import(/* @vite-ignore */ FIREBASE_FIRESTORE_URL),
    ]);
    mod = firestoreMod;
    const app = initializeApp(config);
    db = mod.getFirestore(app);
    docRef = mod.doc(db, "todoApp", "main");
    fb = { setDoc: mod.setDoc, onSnapshot: mod.onSnapshot, runTransaction: mod.runTransaction };
  } catch (err) {
    console.error("Failed to load Firebase SDK", err);
    setSyncStatus("Couldn't load Firebase — check your connection and reload", true);
    return;
  }

  fb.onSnapshot(
    docRef,
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        state = {
          tasks: data.tasks || [],
          calendar: data.calendar || [],
          completed: data.completed || [],
          deleted: data.deleted || [],
        };
      } else {
        state = { tasks: [], calendar: [], completed: [], deleted: [] };
      }
      setSyncStatus("Synced");
      render();
      promoteDueTasksIfNeeded();
    },
    (err) => {
      console.error(err);
      setSyncStatus("Sync error — check console / Firestore rules", true);
    }
  );

  setInterval(promoteDueTasksIfNeeded, 60 * 1000);
}

function boot() {
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
