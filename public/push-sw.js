// Push notifications, loaded into the generated service worker (vite.config.ts importScripts).
self.addEventListener('push', (event) => {
  let message = {}
  try { message = event.data ? event.data.json() : {} } catch { message = { body: event.data ? event.data.text() : '' } }
  const title = message.title || 'Tomify'
  event.waitUntil(self.registration.showNotification(title, {
    body: message.body || '',
    tag: message.tag || undefined,
    icon: '/tomify-logo-192.png',
    badge: '/pwa-64x64.png',
    data: { url: message.url || '/' },
  }))
})

// Opens the page the notification is about, reusing an open Tomify window when there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (open) return open.focus().then((client) => client && 'navigate' in client ? client.navigate(url) : client)
    return self.clients.openWindow(url)
  }))
})
