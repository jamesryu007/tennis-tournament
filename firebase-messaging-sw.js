importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyDgGhjMh5_wFCbb45p5kAkDJaLOJJAFDhI",
  authDomain:        "jamite-dev.firebaseapp.com",
  databaseURL:       "https://jamite-dev-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "jamite-dev",
  storageBucket:     "jamite-dev.firebasestorage.app",
  messagingSenderId: "168236820456",
  appId:             "1:168236820456:web:32fab6a04d85702055e65d"
});

const messaging = firebase.messaging();

// 백그라운드 푸시 수신
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: '/tennis-tournament/images/icon-192.png',
    badge: '/tennis-tournament/images/icon-192.png'
  });
});
