const CACHE='stapp-shell-v1';
self.addEventListener('install',e=>e.waitUntil((async()=>{
  const c=await caches.open(CACHE);const response=await fetch('/');const html=await response.clone().text();await c.put('/',response);
  const assets=Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),m=>m[1]);await c.addAll(assets);await self.skipWaiting();
})()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.origin!==self.location.origin||e.request.method!=='GET'||!(u.pathname==='/'||u.pathname.startsWith('/assets/')))return;
  e.respondWith(fetch(e.request).then(async r=>{if(r.ok)await(await caches.open(CACHE)).put(e.request,r.clone());return r}).catch(()=>caches.match(e.request)));
});
