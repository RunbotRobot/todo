# To-Do

A simple, browser-based to-do list that syncs across devices. No accounts,
no login, no build step — just static files plus a free Firebase database.

## Tabs

- **Tasks** — your sorted list. New tasks go to the top. Use ▲/▼ to
  reorder manually.
- **Calendar** — tasks you're not ready to work on yet, grouped by the
  date you send them to. Once that date arrives, the app automatically
  moves them back to the top of Tasks.
- **Completed** — a log of finished tasks with a completion timestamp.
- **Deleted** — anything you trashed, in case you change your mind.

Each task is plain text. You can use newlines and indentation for your
own visual formatting:
- **Tab** inserts an indent.
- Typing **`>`** also inserts an indent (handy on a phone keyboard).
- Typing **`\>`** gives you a literal `>` instead.

Buttons are icons, not words:
✅ complete · 🗑️ delete · ➡️ send to Calendar · ⬅️ send back to Tasks ·
🧟 resurrect (restore) a deleted task.

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

### 2. Set Firestore security rules

Since this app has no login, go to **Firestore Database > Rules** and
replace the contents with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /todoApp/main {
      allow read, write: if true;
    }
  }
}
```

This scopes open access to just this app's single document (not your
whole Firebase project). Anyone who obtained your site's Firebase config
could read or edit your to-do list — which matches "nobody's going to
mess with it," but is worth knowing.

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

- All your data lives in one Firestore document. The app listens for
  live changes, so edits on one device show up on others within a
  second or two.
- The "move Calendar tasks to Tasks when their date arrives" check runs
  whenever the app is open (on load, and once a minute), comparing
  against your device's local date. It's not a server-side cron job —
  there's no server — so a task's date won't literally trigger while
  every device is closed, but it will catch up the moment you next open
  the app.
