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
let selected = null; // { listName, id } — the task the toolbar buttons act on
let datePickerOpen = false; // whether the "send to Calendar" popover is open
let currentTab = "tasks";
let suppressClickUntil = 0; // guards the ghost "click" that follows a real drag

const el = {
  configBanner: document.getElementById("config-banner"),
  configInput: document.getElementById("config-input"),
  configSave: document.getElementById("config-save"),
  configError: document.getElementById("config-error"),
  syncStatus: document.getElementById("sync-status"),
  tabs: document.getElementById("tabs"),
  toolbar: document.getElementById("toolbar"),
  tbAdd: document.getElementById("tb-add"),
  tbComplete: document.getElementById("tb-complete"),
  tbDelete: document.getElementById("tb-delete"),
  tbSendCalendar: document.getElementById("tb-send-calendar"),
  tbSendTasks: document.getElementById("tb-send-tasks"),
  tbEdit: document.getElementById("tb-edit"),
  tbResurrect: document.getElementById("tb-resurrect"),
  addTaskPanel: document.getElementById("add-task-panel"),
  newTaskInput: document.getElementById("new-task-input"),
  confirmAddBtn: document.getElementById("confirm-add-btn"),
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

// insertIndex is the target position counted among the OTHER tasks (i.e.
// the list with the dragged task already removed) — see computeDropIndex.
function moveTaskTo(id, insertIndex) {
  const fromIndex = state.tasks.findIndex((t) => t.id === id);
  if (fromIndex === -1 || fromIndex === insertIndex) return;
  const [task] = state.tasks.splice(fromIndex, 1);
  const clamped = Math.max(0, Math.min(insertIndex, state.tasks.length));
  state.tasks.splice(clamped, 0, task);
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

/* ---------- task text rendering (hanging indent) ---------- */

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
    lineEl.textContent = line.slice(leading);
    container.append(lineEl);
  }
}

/* ---------- rendering ---------- */

function render() {
  renderTasks();
  renderCalendar();
  renderCompleted();
  renderDeleted();
  updateToolbar();
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
  datePickerOpen = false;
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

/* ---------- drag to reorder (Tasks tab only) ---------- */

// Midpoints of the OTHER (non-dragged) rows, captured once when the drag
// engages — i.e. before the drop-line exists. Re-measuring live on every
// move would be wrong: once the line is inserted it pushes later siblings
// down, which would shift their midpoints and make the line "stick" short
// of where the pointer actually is.
function captureSiblingMidpoints(listEl, draggedLi) {
  const siblings = [...listEl.children].filter(
    (elm) => elm !== draggedLi && !elm.classList.contains("drop-line")
  );
  return siblings.map((elm) => {
    const rect = elm.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
}

// Index is counted among the OTHER (non-dragged) tasks — i.e. where the
// dragged item would land if spliced into that list.
function dropIndexForY(midpoints, clientY) {
  for (let i = 0; i < midpoints.length; i++) {
    if (clientY < midpoints[i]) return i;
  }
  return midpoints.length;
}

function positionDropLine(listEl, index, draggedLi) {
  let line = listEl.querySelector(".drop-line");
  if (!line) {
    line = document.createElement("li");
    line.className = "drop-line";
    line.setAttribute("aria-hidden", "true");
  }
  const siblings = [...listEl.children].filter(
    (elm) => elm !== draggedLi && elm !== line
  );
  listEl.insertBefore(line, siblings[index] || null);
}

function removeDropLine(listEl) {
  listEl.querySelector(".drop-line")?.remove();
}

function attachDragReorder(li, task) {
  li.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, textarea")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const listEl = el.tasksList;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const isTouch = e.pointerType !== "mouse";
    let longPressTimer = null;
    let engaged = false;
    let dropIndex = null;
    let siblingMidpoints = null;

    function engage() {
      engaged = true;
      li.classList.add("dragging");
      siblingMidpoints = captureSiblingMidpoints(listEl, li);
      try { li.setPointerCapture(pointerId); } catch { /* ignore */ }
    }

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      const dy = ev.clientY - startY;
      if (!engaged) {
        if (!isTouch && Math.abs(dy) > 4) {
          engage();
        } else if (isTouch && Math.abs(dy) > 10) {
          // Moved before the long-press fired — treat as a normal scroll.
          clearTimeout(longPressTimer);
          cleanup();
          return;
        } else {
          return;
        }
      }
      ev.preventDefault();
      li.style.transform = `translateY(${dy}px)`;
      dropIndex = dropIndexForY(siblingMidpoints, ev.clientY);
      positionDropLine(listEl, dropIndex, li);
    }

    function finish(shouldDrop) {
      clearTimeout(longPressTimer);
      if (engaged) {
        try { li.releasePointerCapture(pointerId); } catch { /* ignore */ }
        li.classList.remove("dragging");
        li.style.transform = "";
        removeDropLine(listEl);
        if (shouldDrop && dropIndex !== null) {
          moveTaskTo(task.id, dropIndex);
        }
        suppressClickUntil = Date.now() + 300;
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

    if (isTouch) {
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

  const doSave = () => {
    editingKey = null;
    editTaskText(listName, task.id, textarea.value);
  };

  const textarea = document.createElement("textarea");
  textarea.rows = Math.max(2, task.text.split("\n").length);
  textarea.value = task.text;
  attachSmartTextarea(textarea, { onSubmit: doSave });

  const actions = document.createElement("div");
  actions.className = "task-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", doSave);
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

/* ---------- toolbar ---------- */

const TOOLBAR_ACTIONS_BY_TAB = {
  tasks: ["complete", "delete", "send-calendar", "edit"],
  calendar: ["complete", "delete", "send-tasks", "edit"],
  completed: [],
  deleted: ["resurrect"],
};

function toolbarActionButtons() {
  return {
    complete: el.tbComplete,
    delete: el.tbDelete,
    "send-calendar": el.tbSendCalendar,
    "send-tasks": el.tbSendTasks,
    edit: el.tbEdit,
    resurrect: el.tbResurrect,
  };
}

function updateToolbar() {
  const allowed = new Set(TOOLBAR_ACTIONS_BY_TAB[currentTab] || []);
  for (const [action, btn] of Object.entries(toolbarActionButtons())) {
    const isRelevant = allowed.has(action);
    btn.classList.toggle("hidden", !isRelevant);
    btn.disabled = !isRelevant || !selected;
  }
  renderDatePickerPopover();
}

function buildDatePicker(onConfirm, onCancel) {
  const template = document.getElementById("date-picker-template");
  const node = template.content.firstElementChild.cloneNode(true);
  const input = node.querySelector(".date-picker-input");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  input.value = tomorrow.toLocaleDateString("en-CA");
  input.min = todayLocal();

  node.querySelector(".date-picker-confirm").addEventListener("click", () => {
    if (!input.value) return;
    onConfirm(input.value);
  });
  node.querySelector(".date-picker-cancel").addEventListener("click", onCancel);
  return node;
}

function renderDatePickerPopover() {
  el.toolbar.querySelector(".date-picker")?.remove();
  if (!datePickerOpen || !selected) return;
  const { listName, id } = selected;
  if (!state[listName]?.some((t) => t.id === id)) {
    datePickerOpen = false;
    return;
  }
  el.toolbar.append(
    buildDatePicker(
      (date) => {
        selected = null;
        datePickerOpen = false;
        moveToCalendar(id, date);
      },
      () => {
        datePickerOpen = false;
        render();
      }
    )
  );
}

el.tbComplete.addEventListener("click", () => {
  if (!selected) return;
  const { listName, id } = selected;
  selected = null;
  completeTask(listName, id);
});

el.tbDelete.addEventListener("click", () => {
  if (!selected) return;
  const { listName, id } = selected;
  selected = null;
  deleteTask(listName, id);
});

el.tbSendCalendar.addEventListener("click", () => {
  if (!selected) return;
  datePickerOpen = !datePickerOpen;
  render();
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
  const task = state[listName]?.find((t) => t.id === id);
  const row = document.querySelector(`.task-item[data-task-id="${id}"]`);
  const textNode = row?.querySelector(".task-text");
  if (!task || !textNode) return;
  selected = null;
  startEdit(listName, task, textNode);
  updateToolbar();
});

el.tbResurrect.addEventListener("click", () => {
  if (!selected) return;
  const { id } = selected;
  selected = null;
  restoreFromDeleted(id);
});

/* ---------- list rendering ---------- */

function renderTasks() {
  if (editingKey && editingKey.startsWith("tasks:")) return;
  const list = el.tasksList;
  list.innerHTML = "";
  el.tasksEmpty.classList.toggle("hidden", state.tasks.length > 0);

  state.tasks.forEach((task) => {
    const li = buildTaskRow("tasks", task);
    list.append(li);
    attachDragReorder(li, task);
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
      ul.append(buildTaskRow("calendar", task));
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
    const textWrap = document.createElement("div");
    textWrap.className = "task-text";
    renderTaskTextInto(textWrap, task.text);
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `Completed ${formatTimestamp(task.completedAt)}`;
    li.append(textWrap, meta);
    list.append(li);
  });
}

function renderDeleted() {
  const list = el.deletedList;
  list.innerHTML = "";
  el.deletedEmpty.classList.toggle("hidden", state.deleted.length > 0);

  state.deleted.forEach((task) => {
    const metaText = `Deleted ${formatTimestamp(task.deletedAt)} (from ${task.sourceList === "calendar" ? "Calendar" : "Tasks"})`;
    list.append(buildTaskRow("deleted", task, metaText));
  });
}

/* ---------- tabs ---------- */

el.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(`${btn.dataset.tab}-panel`).classList.add("active");
  currentTab = btn.dataset.tab;
  selected = null;
  datePickerOpen = false;
  render();
});

/* ---------- add task ---------- */

function submitNewTask() {
  addTask(el.newTaskInput.value);
  el.newTaskInput.value = "";
  autoResizeTextarea(el.newTaskInput);
  el.newTaskInput.blur(); // dismiss the on-screen keyboard on mobile
  el.addTaskPanel.classList.add("hidden");
}

attachSmartTextarea(el.newTaskInput, { onSubmit: submitNewTask });
el.confirmAddBtn.addEventListener("click", submitNewTask);

el.tbAdd.addEventListener("click", () => {
  const nowHidden = el.addTaskPanel.classList.toggle("hidden");
  if (nowHidden) {
    el.newTaskInput.blur();
  } else {
    el.newTaskInput.focus();
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
