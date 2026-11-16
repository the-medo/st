<script lang="ts">
  import Icon from './Icon.svelte';
  import { agendaDays, type Entry, type Panel } from './calendar';

  let { ids, records, clock, online, onSaved }: {
    ids: string[]; records: Entry[]; clock: string; online: boolean; onSaved: (value: Panel) => void;
  } = $props();

  const labels = {calendar:'Calendar', tasks:'Tasks', notes:'Notes', clock:'Clock'} as const;
  const isWidget = (id: string): id is keyof typeof labels => Object.hasOwn(labels,id);
  let days = $derived(agendaDays(records));
  let tasks = $derived(records.filter(r=>r.kind==='task').sort((a,b)=>Number(a.done)-Number(b.done)));
  let notes = $derived(records.filter(r=>r.kind==='note' && !r.done));
  let editor: HTMLDialogElement;
  let selected = $state<Entry | null>(null);
  let mode = $state<'read' | 'edit'>('read'), title = $state(''), body = $state('');
  let savingId = $state<number | null>(null), error = $state(''), conflict = $state(false);
  let latest = $derived(selected && records.find(r=>r.id===selected!.id));
  let rowError = $state('');

  function draft(entry: Entry) {
    selected={...entry}; title=entry.title; body=entry.body || ''; error=''; conflict=false;
  }
  function open(entry: Entry) {
    draft(entry); mode=entry.kind==='task' ? 'edit' : 'read'; editor.showModal();
  }
  async function update(entry: Entry, patch: {done:boolean} | {title:string;body?:string}) {
    if (savingId !== null) return;
    savingId=entry.id; error=''; rowError=''; conflict=false;
    try {
      const response=await fetch('/api/records/'+entry.id,{method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({version:entry.version ?? 0,...patch})});
      if (response.status===409) {
        const current=await fetch('/api/display');
        if (current.ok) onSaved(await current.json());
        conflict=true; throw new Error('This item changed on another screen.');
      }
      if (!response.ok) throw new Error(response.status===400 ? 'Check the text length and try again.' : 'Could not save. Check the connection and try again.');
      onSaved(await response.json());
      if (editor.open) editor.close();
    } catch (cause) {
      const message=cause instanceof Error && !(cause instanceof TypeError) ? cause.message : 'Connection lost. Try again when connected.';
      if (editor.open) error=message;
      else rowError=message;
    } finally { savingId=null; }
  }
  function save() {
    if (!selected || !title.trim()) return;
    void update(selected,selected.kind==='note' ? {title:title.trim(),body} : {title:title.trim()});
  }
</script>

<section class="widgets" class:standard={ids.join(',')==='calendar,tasks,notes'} aria-label="Dashboard widgets">
  {#each ids as id}
    {#if isWidget(id)}
      <article class="widget">
        <div class="widget-title"><span class="widget-icon"><Icon name={id} size={19}/></span><h2>{labels[id]}</h2></div>
        <div class="record-content">
          {#if id==='calendar'}
            {#each days as day (day.key)}
              <section class="agenda-day" aria-label={day.label}>
                <h3>{day.label}</h3>
                <ul>{#each day.rows as row (row.entry.id)}
                  <li class="agenda-row"><div class="when"><time datetime={row.entry.starts || undefined}>{row.time}</time>{#if row.zone}<small title={row.entry.zone || undefined}>{row.zone}</small>{/if}</div><span>{row.entry.title}</span></li>
                {/each}</ul>
              </section>
            {:else}<p>Nothing scheduled</p>{/each}
          {:else if id==='tasks'}
            {#if rowError}<p role="alert" class="record-error">{rowError}</p>{/if}
            <ul>{#each tasks as task (task.id)}
              <li class="task-row" class:done={task.done}>
                <button class="toggle" role="checkbox" aria-checked={task.done} aria-label={(task.done ? 'Reopen ' : 'Complete ') + task.title} disabled={!online || savingId!==null} onclick={()=>update(task,{done:!task.done})}><span>{#if task.done}<Icon name="check" size={14}/>{/if}</span></button>
                <button class="entry-button" aria-label={'Edit task: '+task.title} disabled={savingId!==null} onclick={()=>open(task)}><span>{task.title}</span><Icon name="edit" size={14}/></button>
              </li>
            {:else}<li class="empty">No tasks</li>{/each}</ul>
          {:else if id==='notes'}
            <ul>{#each notes as note (note.id)}
              <li><button class="entry-button note-link" aria-label={'Open note: '+note.title} disabled={savingId!==null} onclick={()=>open(note)}><span><strong>{note.title}</strong>{#if note.body}<small>{note.body}</small>{/if}</span><Icon name="forward" size={15}/></button></li>
            {:else}<li class="empty">No saved notes</li>{/each}</ul>
          {:else}<p>{clock}</p>{/if}
        </div>
      </article>
    {/if}
  {/each}
</section>

<dialog class="record-dialog" bind:this={editor} aria-labelledby="record-heading" oncancel={event=>{if (savingId!==null) event.preventDefault()}}>
  {#if selected}
    <div class="dialog-head">
      <h2 id="record-heading">{mode==='read' ? 'Note' : selected.kind==='task' ? 'Edit task' : 'Edit note'}</h2>
      <button type="button" class="close" aria-label="Close" disabled={savingId!==null} onclick={()=>editor.close()}><Icon name="close"/></button>
    </div>
    {#if mode==='read'}
      <h3 class="note-heading">{latest?.title || selected.title}</h3>
      {#if latest?.body || (!latest && selected.body)}<p class="note-body">{latest?.body ?? selected.body}</p>{/if}
      <div class="editor-actions"><button class="primary" disabled={!online} onclick={()=>{draft(latest || selected!);mode='edit'}}><Icon name="edit" size={17}/>Edit note</button></div>
    {:else}
      <form onsubmit={event=>{event.preventDefault();save()}}>
        <label>Title<input required maxlength="4000" bind:value={title}/></label>
        {#if selected.kind==='note'}<label>Note text<textarea rows="4" maxlength="32000" bind:value={body}></textarea></label>{/if}
        {#if error}<p role="alert" class="record-error">{error}</p>{/if}
        {#if !online}<p class="record-error">Reconnect to save changes.</p>{/if}
        <div class="editor-actions">
          <button type="button" class="secondary" disabled={savingId!==null} onclick={()=>editor.close()}>Cancel</button>
          {#if conflict && latest}<button type="button" class="primary" onclick={()=>draft(latest!)}>Load latest</button>
          {:else}<button class="primary" type="submit" disabled={!online || !title.trim() || savingId!==null}>Save</button>{/if}
        </div>
      </form>
    {/if}
  {/if}
</dialog>
