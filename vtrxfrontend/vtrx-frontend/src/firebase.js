import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';

const firebaseConfig = {
  apiKey:            "AIzaSyCnShjFqWbn00pJrkwdKJdPI2wBKy3-X14",
  authDomain:        "vtrxapp.firebaseapp.com",
  projectId:         "vtrxapp",
  storageBucket:     "vtrxapp.firebasestorage.app",
  messagingSenderId: "217739884092",
  appId:             "1:217739884092:web:774459138c3caad0287539",
  measurementId:     "G-M2CECJL6Y2",
};

const app       = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

// Returns the FCM token for this browser, or null if permission denied / not configured.
// Requires VITE_FIREBASE_VAPID_KEY — get it from:
// Firebase Console → Project Settings → Cloud Messaging → Web Push certificates → Generate key pair
export const getNotificationToken = async () => {
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    console.warn('[FCM] VITE_FIREBASE_VAPID_KEY not set — skipping token fetch');
    return null;
  }
  return getToken(messaging, { vapidKey });
};

// Subscribe to foreground messages (app is open). Returns an unsubscribe function.
export const onForegroundMessage = (callback) => onMessage(messaging, callback);
