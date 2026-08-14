// Firebase web config for this app.
//
// This is NOT a secret key in the traditional sense — Firebase web configs
// are meant to be public; access to your data is controlled by Firestore
// Security Rules (see README.md), not by hiding this file.
//
// Fill in the values from your Firebase project (Project settings > General
// > Your apps > SDK setup and configuration), then commit this file. Every
// device that loads the site will then be connected automatically.
//
// If you'd rather not edit this file, leave the placeholders below — the
// app will show a one-time "connect" banner where you can paste this same
// JSON and it will be remembered on that device only (saved in localStorage).

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
