self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'New Ride', body: 'A new ride is available!' };
  
  const options = {
    body: data.body,
    icon: '/icon-192x192.png', // Placeholder icon
    badge: '/badge-72x72.png', // Placeholder badge
    vibrate: [200, 100, 200, 100, 200, 100, 400],
    data: {
      url: data.url || '/'
    },
    actions: [
      { action: 'open', title: 'Open SkyRide' }
    ],
    tag: 'new-ride-alert',
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data.url;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
