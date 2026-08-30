# To-Do

A simple, browser-based to-do list that syncs across devices — no build
step, just static files plus a free Firebase database. Everyone who opens
it gets their own private list automatically (see [Accounts](#accounts)
below), so it's safe to share the link and let people poke around without
touching each other's — or your — data.

A small version badge (`v1`, `v2`, ...) sits next to the title so you can
tell whether the page you're looking at has picked up the latest deploy;
it's bumped by hand in `app.js` (`APP_VERSION`) whenever something changes.

The title, toolbar, and tabs stay pinned to the top as you scroll. The
text next to the title is normally blank — it only says something when
sync isn't in its normal state (connecting, offline, an error).

Tabs show "Loading…" instead of their normal empty message until your
data actually arrives — otherwise a brand new sign-in or a fast reload
could flash "No tasks", which reads as "it's gone" rather than "still
loading". Adding a task is disabled during that window too, since there'd
be nothing yet to merge it with once your real list shows up.

## Tabs

- **Tasks** — your sorted list. New tasks go to the top. Drag a task
  (click-drag on desktop, press-and-hold-then-drag on touch) to reorder;
  a line shows where it'll land.
- **Calendar** — tasks you're not ready to work on yet, grouped by the
  date you send them to. Once that date arrives, the app automatically
  moves them back to the top of Tasks.
- **Completed** — a log of finished tasks with a completion timestamp. 🧟
  sends one back to the top of Tasks.
- **Deleted** — anything you trashed, in case you change your mind. 🧟
  restores it (back to Tasks, or Calendar on its original date); 🗑️ here
  deletes it for good, with no way back.

Each task is plain text. You can use newlines and indentation for your
own visual formatting:
- **Tab** inserts an indent. **Enter** adds the task / saves an edit;
  **Alt+Enter** inserts a newline instead (desktop only — touch keyboards
  don't have Alt, so Enter just inserts a newline there).
- Typing **`>`** also inserts an indent (handy on a phone keyboard).
- Typing **`\>`** gives you a literal `>` instead.
- If a line is long enough to wrap, the wrapped part hangs one indent
  level deeper than that line's own indent, so wrapped text doesn't run
  back to the left margin.

There are no buttons on task rows — tap a task to select it (it
highlights), then use the toolbar in the header to act on it: 👤 account
(see below) · 🔍 search · ➕ add · ✅ complete · 🗑️ delete · ➡️ send to
Calendar · ⬅️ send back to Tasks · ⏸️ pause (see below) · ✏️ edit · 🧟
resurrect a completed or deleted task back to Tasks. Only the
selection-based buttons relevant to the current tab are shown, and they're
disabled until something is selected.

### Accounts

The moment you open the app you're signed in as a guest — no sign-up step,
and your list is private to you from the first task you add. 👤 opens the
account popover, which also shows the same JSON backup/restore tools
described below.

A guest account is tied to that one browser: clear your cookies/site data,
or switch devices, and it starts you over with a fresh empty list. Tap
**Sign in with Google** in the popover to save your list permanently to a
Google account instead, so you can pick it back up on any other device by
signing in there too. If that Google account is already linked to a
*different* device's list, signing in offers to switch to that one instead
— your current device's list gets replaced by it, so back it up first (via
Export, below) if you want to keep both.

**Export** / **Import** in the popover dump your whole list as JSON text
(or restore from it) — a manual backup, and also how you'd move a list
between accounts if you ever needed to.

### Pausing a blocked task

Select a task in Tasks and tap ⏸️ to say what it's waiting on (e.g.
"Home"). That creates a pale-red folder right there in the Tasks list —
tap the folder (it turns a darker red) to open it and see what's
paused inside, or ▶️ any task in it to send it back to the top of
Tasks. Pausing a second task with the same blocker (typed again, or by
tapping the folder's pill in the pause prompt instead of typing) adds
it to that same folder rather than making a new one. A folder with
nothing left in it disappears on its own. Folders drag-reorder within
Tasks the same as a regular task, and you can also drag any task
straight onto a folder to add it there without opening the pause
prompt. Select a folder and tap ✏️ to rename it — renaming it to match
another existing folder merges the two.

### Search

🔍 opens a search box that defaults to searching just the tab you were
on; check or uncheck the Tasks/Calendar/Completed/Deleted boxes to widen
or narrow it. Results show which tab they came from — a paused task
shows which folder it's in. Tapping a result closes search, jumps to
that tab, scrolls to the task, and flashes it — for Tasks/Calendar/
Deleted it also selects the task, so the toolbar is immediately ready
to act on it; a paused task instead opens its folder so you can see it.

### Recurring tasks

Put a marker anywhere in a task's text, in double square brackets, and
completing it will also drop a fresh copy of it onto the Calendar for
its next occurrence (the original still gets logged to Completed as
usual):

- `[[Daily]]` → next day · `[[Weekly]]` → +7 days ·
  `[[Every 3 days]]` (any number) → +n days
- `[[Monthly]]` → same day next month (clamped if that day doesn't
  exist, e.g. Jan 31 → Feb 28) · `[[Yearly]]` → same date next year
- `[[Start of Month]]` → the 1st of next month ·
  `[[Start of Year]]` → next Jan 1
- `[[Tuesdays]]` (any weekday name + "s") → the next occurrence of that
  weekday
- `[[Recurring]]` → completing it prompts you to pick the next date
  yourself

If the text inside `[[...]]` doesn't match one of these (a typo like
`[[Evety 2 days]]`), Save is blocked and an error explains why — a task
can't be left in a state where its recurrence marker is silently
ignored. Cancel always works regardless, since it discards the edit
rather than saving it.

The marker stays in the task's text, so the copy that lands on the
Calendar keeps recurring the same way when you complete it again.

### Highlighting lines (checklists)

While editing a task, tap **Highlight** (next to Cancel) to switch the
editor into a click-to-mark view of the task's lines — tap any line to
highlight it, tap again to un-highlight. It's meant for a task written as
a checklist, where you want to mark off individual sub-items without
completing the whole task. Tap **Highlight** again to go back to normal
text editing (your marks are kept), then **Save**. Highlighted lines show
with a yellow marker everywhere the task's text appears, not just while
editing.

Under the hood a highlighted line is just wrapped in `==...==`, so it's
plain text like the recurrence markers — visible and editable by hand in
the textarea too, not a hidden flag.

## Offline use

The app works with no connection: it loads from a cached copy (installed
automatically the first time you visit while online), and any changes you
make offline are queued and sent the next time it's back online — even
across closing and reopening the app or restarting your device, since the
queue is stored on-device rather than just held in memory.

The header shows "Offline — changes saved locally, will sync once back
online" (or "Offline — showing last synced data" if you haven't changed
anything) whenever it can't reach the server; it's blank once everything's
caught up.

What this **doesn't** cover: syncing while the app is fully closed. Nothing
runs in the background, so if you make changes on your phone with no
signal and then use the app on another device signed into the same
account before reopening it on your phone, the two devices' offline
changes can conflict — your list is saved as one document, so whichever
device syncs second overwrites the other's changes rather than merging
them. Reopening the app (even briefly, enough for it to reconnect) after
you're back in range avoids this by syncing right away, before you'd have
a chance to make conflicting changes elsewhere.

## One-time setup

The app itself is just static files (`index.html`, `app.js`, `style.css`)
hosted for free on GitHub Pages. To make your data sync across devices,
it stores everything in a free Firebase Firestore database — you need to
create that once.

### 1. Create a Firebase project (free)

1. Go to the [Firebase console](https://console.firebase.google.com/) and
   create a new project (you can turn off Google Analytics, it's not
   needed).
2. In the project, go to **Build > Firestore Database** and click
   **Create database**. Choose any region close to you. Start in
   **production mode** (we'll set rules manually below).
3. Go to **Project settings** (gear icon) > **General**, scroll to
   **Your apps**, and click the **Web** icon (`</>`) to register a new
   web app. You don't need Firebase Hosting.
4. Copy the `firebaseConfig` object it shows you — you'll need it in step 3.

This is all free at personal-use scale (the free "Spark" plan includes
50,000 reads and 20,000 writes a day, far more than one person's to-do
list will ever use).

### 2. Enable sign-in and set Firestore security rules

Go to **Build > Authentication > Sign-in method** and enable two
providers: **Anonymous**, and **Google** (it'll ask for a support email —
your own is fine).

Then, in **Authentication > Settings > Authorized domains**, add the
domain your site is actually served from (e.g. `runbotrobot.github.io`).
Google sign-in's popup is blocked from any origin not on this list — it's
not there by default for a custom/GitHub Pages domain, only for
`localhost` and the project's own `firebaseapp.com`/`web.app` domains.

Then go to **Firestore Database > Rules** and replace the contents with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Each signed-in user (including guests) can only read and write their own
document — nobody else's, guest or not. Nothing else in your Firestore
project is exposed.

### 3. Connect the app to your project

Pick one:

- **Recommended — edit `config.js` in this repo** and paste in the six
  values from step 1.4, then commit. Every device that visits the site
  will be connected automatically, with nothing to set up per-device.
- **Or — skip editing code.** Load the site once; it'll show a banner
  asking you to paste the same config JSON. It's saved in that browser's
  `localStorage`, so you'd repeat this once per device/browser instead.

### 4. Enable GitHub Pages

In this repo: **Settings > Pages > Build and deployment > Source:
Deploy from a branch**, branch `main`, folder `/ (root)`. Save. The site
will be live at `https://runbotrobot.github.io/todo` within a minute or
two.

## Notes on how it works

- Each signed-in user's data lives in its own Firestore document
  (`users/{uid}`). The app listens for live changes, so edits on one
  device show up on your other devices signed into the same account
  within a second or two.
- The "move Calendar tasks to Tasks when their date arrives" check runs
  whenever the app is open (on load, and once a minute), comparing
  against your device's local date. It's not a server-side cron job —
  there's no server — so a task's date won't literally trigger while
  every device is closed, but it will catch up the moment you next open
  the app.
