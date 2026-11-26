<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Scene from './Scene.svelte';
  import RecordWidgets from './RecordWidgets.svelte';
  import ProjectManager from './ProjectManager.svelte';
  import type { Panel, TaskProject } from './calendar';
  import { themes, findTheme, type Theme } from './themes';
  import seamLight from './assets/brand/st-logo-light.svg';
  import seamDark from './assets/brand/st-logo-dark.svg';
  import './faceplate.css';

  type Menu = 'themes' | 'views' | 'reply';
  const hm = new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  const date = new Intl.DateTimeFormat(undefined, {weekday: 'long', month: 'long', day: 'numeric'});
  const zone = new Intl.DateTimeFormat(undefined, {timeZoneName:'short'});
  const storageKey = 'stapp-panel';
  let panel: Panel = $state({ view:'home', revision:0, spec:{kind:'dashboard',widgets:['calendar','tasks','notes']}, records:[], views:['home','clock'] });
  let theme = $derived(findTheme(panel.theme));
  let seam = $derived(theme.id === 'dune' ? seamLight : seamDark);
  let now = $state(new Date());
  let timeParts = $derived(hm.formatToParts(now));
  let online = $state(false), connected = $state(false), busy = $state(false);
  let menu = $state<Menu>('themes'), dialog: HTMLDialogElement, notice = $state('');
  let lastRevision = -1;
  let projectManager: ProjectManager;
  let timezone = $derived(zone.formatToParts(now).find(part => part.type === 'timeZoneName')?.value || '');
  const viewLabel = (view: string) => view === 'home' ? 'Home' : view === 'clock' ? '3D clock' : view.replaceAll(/[-_]/g, ' ');

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
  async function refresh() {
    try {
      const response = await fetch('/api/display');
      if (response.ok) apply(await response.json());
    } catch {} // Confirmed saves remain visible while the event stream reconnects.
  }
  function projectSaved(project: TaskProject) {
    const projects = (panel.task_projects || []).filter(p => p.id !== project.id);
    if (!project.deleted) projects.push(project);
    panel = {...panel, task_projects:projects, records:panel.records.filter(r =>
      r.kind !== 'task' || r.project_id !== project.id || (!project.deleted && project.visible_on_screen))};
    cache(panel);
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
  <div class="console" class:dash-layout={panel.spec.kind === 'dashboard'}>
    {#snippet connection()}
      <span class="connection" class:online><i></i>{online ? 'Connected' : connected ? 'Reconnecting' : 'Offline'}</span>
    {/snippet}
    {#if panel.spec.kind !== 'dashboard'}
      <header class="masthead">
        <div class="identity"><img class="brand-mark" src={seam} width="36" height="36" alt="S.T."/><span class="divider"></span><span>Faceplate</span></div>
        {@render connection()}
      </header>
    {/if}
    {#if panel.spec.kind === 'dashboard'}
      <section class="dashboard" aria-label={viewLabel(panel.view)}>
        <header class="landscape" style:background-image={'url(' + theme.image + ')'}>
          <div class="clock-face">
            <time class="digits" datetime={now.toISOString()} aria-label={hm.format(now)}>
              {#each timeParts as part}<span class:separator={part.type === 'literal'}>{part.value}</span>{/each}
            </time>
            <div class="date-block"><div class="date-line">{date.format(now)}</div><span class="time-label">{timezone}</span></div>
          </div>
          {@render connection()}
        </header>
        {#if panel.planner_status==='unavailable'}<p role="status">Calendar and tasks are temporarily unavailable. Showing the last saved view.</p>{/if}
        <RecordWidgets ids={panel.spec.widgets || []} records={panel.records} projects={panel.task_projects} clock={hm.format(now)} online={online && panel.planner_status!=='unavailable'} onSaved={apply}/>
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
        <button class="nav-button" class:active={panel.view === 'home'} aria-current={panel.view === 'home' ? 'page' : undefined} disabled={busy} onclick={() => change({name:'home'})}><img class="home-mark" src={seam} width="22" height="22" alt=""/>Home</button>
        <button class="nav-button" class:active={panel.view !== 'home'} aria-haspopup="dialog" onclick={() => openMenu('views')}><Icon name="views"/>Views</button>
        {#if panel.task_projects}<button class="nav-button" aria-haspopup="dialog" onclick={() => projectManager.open()}><Icon name="projects"/>Projects</button>{/if}
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
  <ProjectManager bind:this={projectManager} projects={panel.task_projects || []} online={online && panel.planner_status === 'ok'} onSaved={projectSaved} {refresh}/>
</main>
