import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';

const firebaseConfig = {
  apiKey:            "AIzaSyCnShjFqWbn00pJrkwdKJdPI2wBKy3-X14",
  authDomain:        "vtrxapp.firebaseapp.com",
  projectId:         "vtrxapp",
  storageBucket:     "vtrxapp.firebasestorage.app",
  messagingSenderId: "217739884092",
  appId:             "1:217739884092:web:774459138c3caad0287539",
  measurementId:     "G-M2CECJL6Y2",
};

const app = initializeApp(firebaseConfig);

// Returns true if this browser supports Firebase Cloud Messaging.
// Safari requires PWA mode (Add to Home Screen) on iOS 16.4+.
export const isPushSupported = async () => {
  try { return await isSupported(); } catch(_e) { return false; }
};

let _messaging = null;
const getMsg = async () => {
  if (_messaging) return _messaging;
  const supported = await isPushSupported();
  if (!supported) return null;
  _messaging = getMessaging(app);
  return _messaging;
};

// Returns the FCM token for this browser, or null if unsupported / permission denied.
export const getNotificationToken = async () => {
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    console.warn('[FCM] VITE_FIREBASE_VAPID_KEY not set — skipping token fetch');
    return null;
  }
  try {
    const messaging = await getMsg();
    if (!messaging) return null;
    return await getToken(messaging, { vapidKey });
  } catch(_e) {
    return null;
  }
};

// Subscribe to foreground messages (app is open). Returns an unsubscribe function.
export const onForegroundMessage = async (callback) => {
  try {
    const messaging = await getMsg();
    if (!messaging) return () => {};
    return onMessage(messaging, callback);
  } catch(_e) {
    return () => {};
  }
};
