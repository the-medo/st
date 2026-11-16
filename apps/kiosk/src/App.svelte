<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Scene from './Scene.svelte';
  import { themes, findTheme, type Theme } from './themes';
  import './faceplate.css';

  type Entry = { id: number; kind: string; title: string; starts?: string; zone?: string; done: boolean };
  type Panel = { view: string; revision: number; theme?: string; spec: { kind: string; widgets?: string[]; asset?: string }; records: Entry[]; room_reply?: string; views: string[] };
  type Menu = 'themes' | 'views' | 'reply';
  const widgets = {
    calendar: { label: 'Calendar', kind: 'event', empty: 'Nothing scheduled' },
    tasks: { label: 'Tasks', kind: 'task', empty: 'No open tasks' },
    notes: { label: 'Notes', kind: 'note', empty: 'No saved notes' },
  } as const;
  const hm = new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  const date = new Intl.DateTimeFormat(undefined, {weekday: 'long', month: 'long', day: 'numeric'});
  const zone = new Intl.DateTimeFormat(undefined, {timeZoneName:'short'});
  const storageKey = 'stapp-panel';
  let panel: Panel = $state({ view:'home', revision:0, spec:{kind:'dashboard',widgets:['calendar','tasks','notes']}, records:[], views:['home','clock'] });
  let theme = $derived(findTheme(panel.theme));
  let now = $state(new Date());
  let timeParts = $derived(hm.formatToParts(now));
  let online = $state(false), connected = $state(false), busy = $state(false);
  let menu = $state<Menu>('themes'), dialog: HTMLDialogElement, notice = $state('');
  let lastRevision = -1;
  let timezone = $derived(zone.formatToParts(now).find(part => part.type === 'timeZoneName')?.value || '');
  const viewLabel = (view: string) => view === 'home' ? 'Home' : view === 'clock' ? '3D clock' : view.replaceAll(/[-_]/g, ' ');
  const isWidget = (id: string): id is keyof typeof widgets => Object.hasOwn(widgets, id);

  function cache(value: Panel) {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch {}
  }
  function apply(value: Panel) {
    if (value.revision < lastRevision) return;
    lastRevision = value.revision;
    panel = value;
    online = connected = true;
    notice = '';
    cache(value);
  }
  function openMenu(next: Menu) {
    menu = next;
    dialog.showModal();
  }
  async function change(selection: {name: string} | {theme: string}) {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch('/api/display', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(selection) });
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json();
      if (result.spec) apply(result);
      else apply(await (await fetch('/api/display')).json());
      dialog.close();
    } catch {
      notice = 'Display change could not be saved.';
    } finally { busy = false; }
  }
  function chooseTheme(choice: Theme) {
    if (online) { void change({theme: choice.id}); return; }
    panel = {...panel, theme: choice.id};
    cache(panel);
    notice = 'Previewing theme offline.';
    dialog.close();
  }
  onMount(() => {
    try { const stored = localStorage.getItem(storageKey); if (stored) panel = JSON.parse(stored); } catch {}
    const ticks = setInterval(() => now = new Date(), 1000);
    const events = new EventSource('/api/events');
    events.onmessage = event => apply(JSON.parse(event.data));
    events.onerror = () => online = false;
    fetch('/api/display').then(response => {
      if (response.status === 401) notice = 'Open the private faceplate address to connect.';
      if (response.ok) return response.json();
    }).then(value => { if (value) apply(value); }).catch(() => {});
    return () => { clearInterval(ticks); events.close(); };
  });
</script>

<svelte:head><title>S.T. · Faceplate</title></svelte:head>
<main class="shell" data-theme={theme.id}>
  <div class="console">
    <header class="masthead">
      <div class="identity"><span class="logomark" aria-hidden="true"><i></i><i></i><i></i></span><span class="wordmark">S.T.</span><span class="divider"></span><span>Faceplate</span></div>
      <span class="connection" class:online><i></i>{online ? 'Connected' : connected ? 'Reconnecting' : 'Offline'}</span>
    </header>

    {#if panel.spec.kind === 'dashboard'}
      <section class="dashboard" aria-label={viewLabel(panel.view)}>
        <div class="landscape" style:background-image={'url(' + theme.image + ')'}>
          <div class="clock-face">
            <div class="time-label">Local time <span></span> <b>{timezone}</b></div>
            <time class="digits" datetime={now.toISOString()} aria-label={hm.format(now)}>
              {#each timeParts as part}<span class:separator={part.type === 'literal'}>{part.value}</span>{/each}
            </time>
            <div class="date-line">{date.format(now)}</div>
          </div>
        </div>
        <section class="widgets" aria-label="Dashboard widgets">
          {#each panel.spec.widgets || [] as id}
            {#if isWidget(id)}
              {@const widget = widgets[id]}
              {@const entries = panel.records.filter(entry => entry.kind === widget.kind && !entry.done)}
              <article class="widget">
                <div class="widget-title"><span class="widget-icon"><Icon name={id} size={20}/></span><h2>{widget.label}</h2></div>
                {#if entries.length}
                  <ul>{#each entries as entry (entry.id)}<li>{#if entry.starts}<small>{entry.starts} {entry.zone || ''}</small>{/if}{entry.title}</li>{/each}</ul>
                {:else}<p>{widget.empty}</p>{/if}
              </article>
            {:else if id === 'clock'}
              <article class="widget"><div class="widget-title"><span class="widget-icon"><Icon name="clock"/></span><h2>Clock</h2></div><p>{hm.format(now)}</p></article>
            {/if}
          {/each}
        </section>
      </section>
    {:else if panel.spec.kind === 'scene'}
      <section class="stage" aria-label="3D clock"><Scene {theme}/></section>
    {:else if panel.spec.kind === 'photo'}
      <section class="stage"><img src={'/api/asset/photo/' + panel.spec.asset} alt={viewLabel(panel.view)}></section>
    {:else if panel.spec.kind === 'app'}
      <iframe class="stage" sandbox="allow-scripts" src={'/api/asset/app/' + panel.spec.asset} title={viewLabel(panel.view)}></iframe>
    {/if}

    <footer class="toolbar">
      <nav aria-label="Faceplate navigation">
        <button class="nav-button" class:active={panel.view === 'home'} aria-current={panel.view === 'home' ? 'page' : undefined} disabled={busy} onclick={() => change({name:'home'})}><Icon name="home"/>Home</button>
        <button class="nav-button" class:active={panel.view !== 'home'} aria-haspopup="dialog" onclick={() => openMenu('views')}><Icon name="views"/>Views</button>
      </nav>
      <div class="delivery" aria-live="polite">
        {#if notice || panel.room_reply}
          <button aria-label="Read latest message" onclick={() => openMenu('reply')}><Icon name="message"/><span>{notice || panel.room_reply}</span></button>
        {/if}
      </div>
      <button class="theme-switch" aria-label={'Themes, current theme: ' + theme.label} aria-haspopup="dialog" onclick={() => openMenu('themes')}><span class="swatch" aria-hidden="true" style:background-image={'url(' + theme.image + ')'}></span><span>{theme.label}</span><Icon name="chevron" size={15}/></button>
    </footer>
  </div>
  <dialog bind:this={dialog} aria-labelledby="dialog-title" onclick={event => { if (event.target === dialog) { const r=dialog.getBoundingClientRect(); if (event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom) dialog.close(); } }}>
    <div class="dialog-head"><h2 id="dialog-title">{menu === 'themes' ? 'Themes' : menu === 'views' ? 'Views' : 'Latest message'}</h2><button class="close" aria-label="Close" onclick={() => dialog.close()}><Icon name="close"/></button></div>
    {#if menu === 'themes'}
      <div class="theme-grid">
        {#each themes as choice}
          <button class="theme-tile" style:background-image={'url(' + choice.image + ')'} aria-pressed={choice.id === theme.id} disabled={busy} onclick={() => chooseTheme(choice)}>
            <span>{choice.label}</span>{#if choice.id === theme.id}<i><Icon name="check" size={16}/></i>{/if}
          </button>
        {/each}
      </div>
    {:else if menu === 'views'}
      <div class="view-list">
        {#each panel.views as name}
          <button class="view-choice" aria-pressed={panel.view === name} disabled={busy} onclick={() => change({name})}><Icon name={name === 'home' ? 'home' : name === 'clock' ? 'clock' : 'views'}/><span>{viewLabel(name)}</span>{#if name === panel.view}<Icon name="check"/>{/if}</button>
        {/each}
      </div>
    {:else}<p class="message">{notice || panel.room_reply}</p>{/if}
    {#if menu !== 'reply' && notice}<p role="status" class="message">{notice}</p>{/if}
  </dialog>
</main>
