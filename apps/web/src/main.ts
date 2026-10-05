import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { registerSW } from 'virtual:pwa-register';
import App from './App.vue';
import { router } from './router';
import './style.css';

// Service Worker registrieren; Fehler bewusst abfangen (blockierte SW,
// selbstsignierte Zertifikate o. Ä. dürfen die App nicht stören).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onRegisterError: (error) => {
      console.warn('Service Worker konnte nicht registriert werden:', error);
    },
  });
}

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
