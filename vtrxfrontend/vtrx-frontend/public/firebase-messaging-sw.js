// Firebase Messaging Service Worker — handles background push notifications.
// This file MUST stay in /public so it is served at the root path /firebase-messaging-sw.js.
// Service workers cannot use ES modules, so use the compat CDN builds.

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyCnShjFqWbn00pJrkwdKJdPI2wBKy3-X14",
  authDomain:        "vtrxapp.firebaseapp.com",
  projectId:         "vtrxapp",
  storageBucket:     "vtrxapp.firebasestorage.app",
  messagingSenderId: "217739884092",
  appId:             "1:217739884092:web:774459138c3caad0287539",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  if (!title) return;

  self.registration.showNotification(title, {
    body,
    icon:  '/icon-192.png',
    badge: '/icon-192.png',
    data:  payload.data || {},
    vibrate: [200, 100, 200],
  });
});
