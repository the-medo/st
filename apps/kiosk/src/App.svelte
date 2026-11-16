<script lang="ts">
  import {onMount} from 'svelte';
  import Scene from './Scene.svelte';
  type Entry = {id:number,kind:string,title:string,starts?:string,zone?:string,done:boolean};
  type Panel = {view:string,revision:number,spec:{kind:string,widgets?:string[],asset?:string},records:Entry[],room_reply?:string,views:string[]};
  let panel:Panel=$state({view:'home',revision:0,spec:{kind:'dashboard',widgets:['calendar','tasks','notes']},records:[],views:['home','clock']});
  let online=$state(false), connected=$state(false), now=$state(new Date()), open=$state(false), notice=$state('');
  const widgets:Record<string,{label:string,kind:string,empty:string}>={calendar:{label:'Calendar',kind:'event',empty:'No events'},tasks:{label:'Tasks',kind:'task',empty:'No open tasks'},notes:{label:'Notes',kind:'note',empty:'No notes'}};
  const clock=(d:Date)=>d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false});
  function apply(value:Panel){panel=value;online=true;connected=true;notice='';try{localStorage.setItem('stapp-panel',JSON.stringify(value))}catch{}}
  async function show(name:string){open=false;try{const response=await fetch('/api/display',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});if(!response.ok)throw Error();apply(await (await fetch('/api/display')).json())}catch{notice='Display service unavailable'}}
  onMount(()=>{
    try{const saved=localStorage.getItem('stapp-panel');if(saved)panel=JSON.parse(saved)}catch{}
    const ticks=setInterval(()=>now=new Date(),1000);
    const events=new EventSource('/api/events');
    events.onmessage=e=>apply(JSON.parse(e.data));
    events.onerror=()=>online=false;
    fetch('/api/display').then(r=>{if(r.status===401)notice='Open this display through your private connection.';if(r.ok)return r.json()}).then(v=>{if(v)apply(v)}).catch(()=>online=false);
    return ()=>{clearInterval(ticks);events.close()};
  });
</script>
<svelte:head><title>S.T. · Faceplate</title></svelte:head>
<main>
<header><div class="brand"><span class="mark">S.T.</span><span class="divider"></span>Faceplate</div><div class="status" class:live={online}><i></i>{online?'Connected':connected?'Reconnecting':'Offline'}</div></header>
{#if panel.spec.kind==='dashboard'}
<section class="time"><div class="digits">{clock(now)}</div><div class="date">{now.toLocaleDateString([], {weekday:'long'})}<br><span>{now.toLocaleDateString([],{month:'long',day:'numeric'})}</span></div></section>
<div class="cards">
  {#each panel.spec.widgets || [] as id}
    {#if widgets[id]}
      {@const widget=widgets[id]}
      {@const entries=panel.records.filter(r=>r.kind===widget.kind && !r.done)}
      <article><h2>{widget.label}</h2>{#if entries.length}<ul>{#each entries as r (r.id)}<li>{#if r.starts}<small>{r.starts} {r.zone||''}</small>{/if}{r.title}</li>{/each}</ul>{:else}<p>{widget.empty}</p>{/if}</article>
    {:else if id==='clock'}<article><h2>Clock</h2><p>{clock(now)}</p></article>{/if}
  {/each}
</div>
{:else if panel.spec.kind==='scene'}<div class="content"><Scene/></div>
{:else if panel.spec.kind==='photo'}<div class="content"><img src={'/api/asset/photo/'+panel.spec.asset} alt={panel.view}></div>
{:else if panel.spec.kind==='app'}<iframe class="content" sandbox="allow-scripts" src={'/api/asset/app/'+panel.spec.asset} title={panel.view}></iframe>{/if}
<footer><span aria-live="polite">{notice||panel.room_reply||''}</span><button onclick={()=>show('home')}>Home</button><button aria-expanded={open} onclick={()=>open=!open}>Views</button></footer>
{#if open}<nav>{#each panel.views as view}<button onclick={()=>show(view)}>{view}</button>{/each}</nav>{/if}
</main>
<style>
:global(*){box-sizing:border-box} :global(body){background:#101815;color:#ebf0e8;font:16px system-ui,sans-serif}
main{height:100dvh;min-height:300px;max-width:1600px;margin:auto;padding:clamp(14px,3vw,36px);display:flex;flex-direction:column;gap:16px;position:relative;background:radial-gradient(ellipse at 90% 0%,#243932 0%,transparent 60%)}
header,footer,.brand,.status,.time{display:flex;align-items:center}header{justify-content:space-between}.brand{font-weight:550;gap:12px;color:#c2cfc2}.mark{font:italic bold 24px Georgia,serif;color:#e0f6ce}.divider{height:18px;width:1px;background:#617165}
.status{gap:8px;font-size:13px}.status i{width:8px;height:8px;border-radius:50%;background:#cbac78}.live i{background:#9ad489}.time{gap:24px}.digits{font:normal clamp(46px,12vw,110px)/1 Georgia,serif;letter-spacing:-.05em}.date{line-height:1.5}.date span,article p,footer span{color:#aebcb1}
.cards{display:flex;gap:10px;flex:1;min-height:0;overflow:auto}article{background:#1b2822;border:1px solid #38483d;border-radius:15px;padding:15px;min-width:130px;flex:1;overflow:auto}
h2{margin:0 0 16px;font-size:17px;color:#dae9ce}article p,li{font-size:15px;margin:0}ul{list-style:none;padding:0;margin:0}li+li{margin-top:10px}small{display:block;color:#c4c69f}
footer{gap:8px}footer span{flex:1;overflow:auto;max-height:62px;font-size:14px}button{border:1px solid #4a5b51;background:#27382e;color:#eef5ec;padding:9px 16px;border-radius:18px;min-height:42px;cursor:pointer;font:inherit}button:hover,button:focus-visible{background:#3e5946}
nav{position:absolute;bottom:68px;right:24px;background:#1e3026;border:1px solid #516857;padding:12px;border-radius:16px;display:flex;gap:7px;max-width:85%;flex-wrap:wrap}.content{flex:1;min-height:0;border:0;border-radius:12px;overflow:hidden}.content img{width:100%;height:100%;object-fit:contain}
</style>
