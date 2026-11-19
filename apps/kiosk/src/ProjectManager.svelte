<script lang="ts">
  import Icon from './Icon.svelte';
  import type { TaskProject } from './calendar';

  let { projects, online, onSaved, refresh }: {
    projects: TaskProject[]; online: boolean;
    onSaved: (project: TaskProject) => void; refresh: () => Promise<void>;
  } = $props();
  const colors = [
    ['Blue', '#8aa7ff'], ['Purple', '#bd9bff'], ['Pink', '#f18bb6'], ['Coral', '#f49a82'],
    ['Gold', '#dfb958'], ['Green', '#8fbc79'], ['Teal', '#6bc4bb'], ['Slate', '#a4acb8'],
  ];
  let dialog: HTMLDialogElement;
  let editing = $state(false), selected = $state<TaskProject | null>(null);
  let title = $state(''), color = $state('#8aa7ff'), visible = $state(true);
  let busy = $state(false), error = $state(''), conflict = $state(false), deleting = $state(false);
  let pending: { payload: string; key: string } | null = null;
  let sorted = $derived([...projects].sort((a,b) => a.title.localeCompare(b.title)));
  let latest = $derived(projects.find(p => p.id === selected?.id));

  export function open() { dialog.showModal(); void refresh(); }
  function edit(project: TaskProject | null) {
    selected = project ? {...project} : null;
    title = project?.title || ''; color = project?.color || colors[0][1];
    visible = project?.visible_on_screen !== false;
    editing = true; error = ''; conflict = false; deleting = false;
  }
  async function mutate(action: 'save' | 'delete', args: Record<string, unknown>) {
    if (busy || !online) return false;
    busy = true; error = ''; conflict = false;
    const payload = JSON.stringify({action, args});
    // Keep the same key after a lost response, especially when creating a project.
    if (pending?.payload !== payload) pending = {payload, key: crypto.randomUUID()};
    try {
      const response = await fetch('/api/planner', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action, args, idempotency_key: pending.key})});
      if (response.status === 409) {
        await refresh(); conflict = true;
        throw new Error(editing ? 'This project changed on another screen. Load the latest version before saving.' :
          'This project changed on another screen. Review its current setting and try again.');
      }
      if (!response.ok) {
        const message = await response.text();
        throw new Error(response.status === 400 && message.length < 300 && !message.includes('<')
          ? message : 'Could not save this project. Check the connection and try again.');
      }
      onSaved(await response.json()); pending = null;
      await refresh();
      return true;
    } catch (cause) {
      error = cause instanceof Error && !(cause instanceof TypeError) ? cause.message : 'Connection lost. Try again when connected.';
      return false;
    } finally { busy = false; }
  }
  async function save() {
    if (!title.trim()) return;
    const args = {kind:'project', title:title.trim(), color, visible_on_screen:visible,
      ...(selected ? {id:selected.id, version:selected.version} : {})};
    if (await mutate('save', args)) { editing = false; selected = null; }
  }
  async function remove() {
    if (selected && await mutate('delete', {id:selected.id, version:selected.version})) {
      editing = false; selected = null; deleting = false;
    }
  }
</script>

<dialog class="record-dialog project-dialog" bind:this={dialog} aria-labelledby="projects-heading"
  oncancel={event => { if (busy) event.preventDefault(); }}>
  <div class="dialog-head">
    <h2 id="projects-heading">{editing ? selected ? 'Edit project' : 'New project' : 'Projects'}</h2>
    <button type="button" class="close" aria-label="Close projects" disabled={busy} onclick={() => dialog.close()}><Icon name="close"/></button>
  </div>
  {#if editing}
    <form onsubmit={event => { event.preventDefault(); void save(); }}>
      <label>Project name<input required maxlength="4000" bind:value={title} disabled={busy}/></label>
      <fieldset class="project-colors" disabled={busy}>
        <legend>Color</legend>
        <div class="color-options">
          {#each colors as [name, value]}
            <button type="button" class="color-option" aria-label={name} aria-pressed={color === value}
              style:--project-color={value} onclick={() => color = value}>
              <span>{#if color === value}<Icon name="check" size={18}/>{/if}</span>
            </button>
          {/each}
          <label class="custom-color">Custom<input type="color" aria-label="Custom project color" bind:value={color}/></label>
        </div>
      </fieldset>
      <label class="visibility-choice"><input type="checkbox" bind:checked={visible} disabled={busy}/><span>Show on screen<small>Include this project's tasks on the dashboard.</small></span></label>
      {#if error}<p class="record-error" role="alert">{error}</p>{/if}
      {#if deleting}
        <p class="record-error">Delete this project? Move or remove its tasks first.</p>
        <div class="editor-actions">
          <button type="button" class="secondary" disabled={busy} onclick={() => deleting = false}>Keep project</button>
          <button type="button" class="primary" disabled={!online || busy || conflict} onclick={remove}>Delete</button>
        </div>
      {:else}
        <div class="editor-actions">
          {#if selected}<button type="button" class="secondary delete-project" disabled={!online || busy} onclick={() => deleting = true}>Delete project</button>{/if}
          <button type="button" class="secondary" disabled={busy} onclick={() => {editing = false; error = '';}}>Back</button>
          {#if conflict && latest}<button type="button" class="primary" onclick={() => edit(latest!)}>Load latest</button>
          {:else}<button type="submit" class="primary" disabled={!online || busy || !title.trim() || conflict}>{busy ? 'Saving…' : 'Save project'}</button>{/if}
        </div>
      {/if}
    </form>
  {:else}
    <p class="project-help">Choose which projects appear on your screen.</p>
    <ul class="project-list">
      {#each sorted as project (project.id)}
        <li>
          <button class="project-edit" aria-label={'Edit project: ' + project.title} disabled={busy} onclick={() => edit(project)}>
            <i class="project-dot" style:background={project.color} aria-hidden="true"></i>
            <span>{project.title}<small>{project.visible_on_screen ? 'On screen' : 'Hidden from screen'}</small></span>
            <Icon name="edit" size={16}/>
          </button>
          <button class="project-switch" role="switch" aria-checked={project.visible_on_screen} aria-label={'Show ' + project.title + ' on screen'}
            disabled={!online || busy} onclick={() => mutate('save', {id:project.id, version:project.version, visible_on_screen:!project.visible_on_screen})}>
            <span aria-hidden="true"></span>
          </button>
        </li>
      {:else}<li class="project-empty">No projects yet. Add one to organize your tasks.</li>{/each}
    </ul>
    <p class="project-help">Tasks without a project stay visible.</p>
    {#if error}<p class="record-error" role="alert">{error}</p>{/if}
    <div class="editor-actions"><button type="button" class="primary" disabled={!online || busy} onclick={() => edit(null)}><Icon name="plus" size={18}/>New project</button></div>
  {/if}
  {#if !online}<p class="record-error" role="status">Reconnect to manage projects.</p>{/if}
</dialog>
