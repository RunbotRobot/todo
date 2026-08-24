import { firebaseConfig as fileConfig } from "./config.js";

// Firebase is loaded lazily (see connectFirebase) so a network hiccup or
// blocked CDN request can't take down the rest of the app — task entry,
// tabs, and editing all work purely client-side already.
const FIREBASE_APP_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
const FIREBASE_FIRESTORE_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const INDENT = "    "; // 4 spaces per indent level
const APP_VERSION = "11";

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
  tbAdd: document.getElementById("tb-add"),
  tbComplete: document.getElementById("tb-complete"),
  tbDelete: document.getElementById("tb-delete"),
  tbSendCalendar: document.getElementById("tb-send-calendar"),
  tbPause: document.getElementById("tb-pause"),
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
  if (raw === "start of month") return { type: "start-of-month" };
  if (raw === "start of year") return { type: "start-of-year" };
  const weekdayMatch = raw.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s$/);
  if (weekdayMatch) return { type: "weekday", weekday: WEEKDAY_NAMES.indexOf(weekdayMatch[1]) };
  const everyNMatch = raw.match(/^every (\d+) days?$/);
  if (everyNMatch) {
    const n = parseInt(everyNMatch[1], 10);
    if (n > 0) return { type: "every-n-days", n };
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

// nextDate (YYYY-MM-DD), when given, also spins off a fresh copy of the
// task into Calendar for that date — used for recurring tasks.
function completeTask(listName, id, nextDate) {
  const task = findAndRemove(listName, id);
  if (!task) return;
  const { targetDate, sentAt, ...rest } = task;
  state.completed.unshift({ ...rest, completedAt: new Date().toISOString() });
  if (nextDate) {
    state.calendar.push({
      id: uuid(),
      text: task.text,
      createdAt: new Date().toISOString(),
      targetDate: nextDate,
      sentAt: new Date().toISOString(),
    });
  }
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

// Deleting a task that's already in Deleted removes it for good, rather
// than looping it back into Deleted with a new timestamp.
function permanentlyDeleteTask(id) {
  if (!findAndRemove("deleted", id)) return;
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

// Unlike restoreFromDeleted, this always goes to the top of Tasks — a
// completed task doesn't carry a Calendar date to return to.
function resurrectCompletedTask(id) {
  const task = findAndRemove("completed", id);
  if (!task) return;
  const { completedAt, ...rest } = task;
  state.tasks.unshift(rest);
  render();
  saveState();
}

// Folders are just another kind of entry in state.tasks — { type: "folder",
// blocker, tasks: [...] } — so they sit inline with regular tasks, sync the
// same way, and don't need a whole new top-level list. Pausing removes the
// task from Tasks and either joins an existing folder for that blocker
// (case-insensitive match) or creates a new one.
function pauseTask(id, blockerName) {
  const trimmed = blockerName.trim();
  if (!trimmed) return;
  const task = findAndRemove("tasks", id);
  if (!task) return;
  const existing = state.tasks.find(
    (t) => t.type === "folder" && t.blocker.toLowerCase() === trimmed.toLowerCase()
  );
  if (existing) {
    existing.tasks.unshift(task);
  } else {
    state.tasks.unshift({
      id: uuid(),
      type: "folder",
      blocker: trimmed,
      createdAt: new Date().toISOString(),
      tasks: [task],
    });
  }
  render();
  saveState();
}

// Moves a task back out of its folder to the top of Tasks. Removes the
// folder itself once it's empty.
function resumeTask(folderId, taskId) {
  const folder = state.tasks.find((t) => t.id === folderId && t.type === "folder");
  if (!folder) return;
  const idx = folder.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return;
  const [task] = folder.tasks.splice(idx, 1);
  state.tasks.unshift(task);
  if (folder.tasks.length === 0) {
    findAndRemove("tasks", folderId);
    if (selected && selected.id === folderId) selected = null;
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
    const rest = line.slice(leading);
    if (rest === "") {
      // A completely empty div collapses to zero height in most browsers —
      // this is what was silently swallowing blank lines between \n\n.
      lineEl.appendChild(document.createElement("br"));
    } else {
      lineEl.textContent = rest;
    }
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

// A folder is "open" exactly when it's selected — no separate expanded-state
// tracking needed, and it collapses for free whenever selection moves
// elsewhere. Its own toolbar actions are all disabled (see updateToolbar);
// the only thing you can do with its contents is resume one back to Tasks.
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
    if (e.target.closest("button")) return;
    if (Date.now() < suppressClickUntil) return;
    selectTask("tasks", folder.id);
  });

  if (isOpen) {
    const sub = document.createElement("ul");
    sub.className = "task-list folder-contents";
    for (const child of folder.tasks) {
      const childLi = document.createElement("li");
      childLi.className = "task-item folder-child";
      const childText = document.createElement("div");
      childText.className = "task-text";
      renderTaskTextInto(childText, child.text);
      childLi.append(childText, makeIconBtn("▶️", "Resume", () => resumeTask(folder.id, child.id)));
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

function attachDragReorder(li, task) {
  li.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, textarea")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const listEl = el.tasksList;
    const startY = e.clientY;
    let lastY = e.clientY;
    const pointerId = e.pointerId;
    const isTouch = e.pointerType !== "mouse";
    let longPressTimer = null;
    let engaged = false;
    let manualScrolling = false; // pre-engage swipe decided to be a scroll, not a drag
    let dropIndex = null;
    let siblingMidpoints = null;
    let gapPositions = null;

    function engage() {
      engaged = true;
      li.classList.add("dragging");
      siblingMidpoints = captureSiblingMidpoints(listEl, li);
      gapPositions = captureGapPositions(listEl, li);
      try { li.setPointerCapture(pointerId); } catch { /* ignore */ }
    }

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;

      if (manualScrolling) {
        // Task rows have touch-action:none (see CSS) so the browser never
        // starts its own scroll for a touch that began on one — we emulate
        // it ourselves once a pre-engage swipe turns out to be a scroll,
        // rather than a deliberate long-press-then-drag.
        window.scrollBy(0, lastY - ev.clientY);
        lastY = ev.clientY;
        return;
      }

      const dy = ev.clientY - startY;
      if (!engaged) {
        if (!isTouch && Math.abs(dy) > 4) {
          engage();
        } else if (isTouch && Math.abs(dy) > 10) {
          // Moved before the long-press fired — treat as a normal scroll.
          clearTimeout(longPressTimer);
          manualScrolling = true;
          window.scrollBy(0, lastY - ev.clientY);
          lastY = ev.clientY;
          return;
        } else {
          return;
        }
      }
      ev.preventDefault();
      dropIndex = dropIndexForY(siblingMidpoints, ev.clientY);
      showDropLine(listEl, gapPositions[dropIndex]);
    }

    function finish(shouldDrop) {
      clearTimeout(longPressTimer);
      if (engaged) {
        try { li.releasePointerCapture(pointerId); } catch { /* ignore */ }
        li.classList.remove("dragging");
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

  const errorMsg = document.createElement("p");
  errorMsg.className = "field-error hidden";

  const doSave = () => {
    const badMarker = findUnrecognizedRecurrenceMarker(textarea.value);
    if (badMarker) {
      errorMsg.textContent = `"[[${badMarker}]]" isn't a recognized recurrence — fix or remove it to save.`;
      errorMsg.classList.remove("hidden");
      return;
    }
    editingKey = null;
    editTaskText(listName, task.id, textarea.value);
  };

  const textarea = document.createElement("textarea");
  textarea.rows = 1; // just a pre-JS fallback — attachSmartTextarea auto-fits the real height
  textarea.value = task.text;
  attachSmartTextarea(textarea, { onSubmit: doSave });
  textarea.addEventListener("input", () => errorMsg.classList.add("hidden"));

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
  editWrap.append(textarea, errorMsg, actions);

  container.replaceChild(editWrap, textNode);
  // Re-measure now that the textarea is actually laid out in the live DOM —
  // scrollHeight on a still-detached element (as it was inside
  // attachSmartTextarea above) isn't reliable.
  autoResizeTextarea(textarea);
  textarea.focus();
}

/* ---------- toolbar ---------- */

const TOOLBAR_ACTIONS_BY_TAB = {
  tasks: ["complete", "delete", "send-calendar", "pause", "edit"],
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
    edit: el.tbEdit,
    resurrect: el.tbResurrect,
  };
}

function updateToolbar() {
  const allowed = new Set(TOOLBAR_ACTIONS_BY_TAB[currentTab] || []);
  const selectedTask = selected && state[selected.listName]?.find((t) => t.id === selected.id);
  // None of these actions mean anything for a folder itself (yet) — only
  // its contents, via the per-child Resume button.
  const selectedIsFolder = !!selectedTask && selectedTask.type === "folder";
  for (const [action, btn] of Object.entries(toolbarActionButtons())) {
    const isRelevant = allowed.has(action);
    btn.classList.toggle("hidden", !isRelevant);
    btn.disabled = !isRelevant || !selected || selectedIsFolder;
  }
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

function renderActionPopover() {
  el.appHeader.querySelector(".date-picker, .pause-picker")?.remove();
  if (!pendingPopover || !selected) return;
  const { listName, id } = selected;
  if (!state[listName]?.some((t) => t.id === id)) {
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
    const existingFolders = state.tasks.filter((t) => t.type === "folder");
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

el.tbComplete.addEventListener("click", () => {
  if (!selected) return;
  const { listName, id } = selected;
  const task = state[listName]?.find((t) => t.id === id);
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
  const { listName, id } = selected;
  selected = null;
  if (listName === "completed") {
    resurrectCompletedTask(id);
  } else {
    restoreFromDeleted(id);
  }
});

/* ---------- list rendering ---------- */

function renderTasks() {
  if (editingKey && editingKey.startsWith("tasks:")) return;
  const list = el.tasksList;
  list.innerHTML = "";
  el.tasksEmpty.classList.toggle("hidden", state.tasks.length > 0);

  state.tasks.forEach((task) => {
    if (task.type === "folder") {
      list.append(buildFolderRow(task));
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
    const metaText = `Completed ${formatTimestamp(task.completedAt)}`;
    list.append(buildTaskRow("completed", task, metaText));
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
    el.addTaskError.textContent = `"[[${badMarker}]]" isn't a recognized recurrence — fix or remove it to add.`;
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

function searchMetaFor(listName, task) {
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
      if (task.type === "folder") continue; // no .text of its own to search
      if (!query || task.text.toLowerCase().includes(query)) {
        results.push({ listName, task });
      }
    }
  }

  el.searchResults.innerHTML = "";
  el.searchEmpty.classList.toggle("hidden", results.length > 0);
  for (const { listName, task } of results) {
    const li = document.createElement("li");
    li.className = "task-item selectable";
    const textWrap = document.createElement("div");
    textWrap.className = "task-text";
    renderTaskTextInto(textWrap, task.text);
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = searchMetaFor(listName, task);
    li.append(textWrap, meta);
    li.addEventListener("click", () => jumpToTask(listName, task.id));
    el.searchResults.append(li);
  }
}

// Closes search, switches to the task's tab, selects it so the toolbar can
// act on it right away, and briefly flashes the row so it's easy to spot.
function jumpToTask(listName, id) {
  closeSearchPanel();
  activateTab(listName);
  selected = { listName, id };
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
      setSyncStatus(""); // nothing to say when everything's fine
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
