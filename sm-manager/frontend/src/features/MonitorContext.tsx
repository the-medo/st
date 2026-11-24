import {createContext, useContext, useState, type ReactNode} from 'react';
import {useLocation} from 'react-router';
import {api, bytes, percent, usePoll} from '../lib/api';
import type {Snapshot, ZedCatalog, DbCatalog, Database} from '../lib/types';
import {workScope,isWorkmode} from '../lib/workmode';
import {Modal, Notice} from '../components/Ui';
export function useMonitor(){const v=useContext(Context);if(!v)throw new Error('Monitor provider missing');return v;}
function useValue(){
 const path=useLocation();const workmode=isWorkmode(path.search);
 const snapshot=usePoll<Snapshot>('/api/snapshot');const zed=usePoll<ZedCatalog>('/api/zed',60000);const dbs=usePoll<DbCatalog>('/api/dbs',60000);
 const scope=workScope(snapshot.data,zed.data?.groups,dbs.data?.connections);
 const scoped=workmode && !['/','/overview'].includes(path.pathname);
 return {snapshot,zed,dbs,scope,workmode,projects:scoped?scope.projects:snapshot.data?.projects ?? [],scoped};
}
const Context=createContext<ReturnType<typeof useValue>|null>(null);
export function MonitorProvider({children}:{children:ReactNode}){const value=useValue();return <Context.Provider value={value}>{children}</Context.Provider>;}
export function CheckoutActions({path,primary=false}:{path:string;primary?:boolean}){
 const {zed,dbs,scope,scoped}=useMonitor();const [choose,setChoose]=useState(false);
 const tree=[...(zed.data?.groups.flatMap(g=>g.repositories.flatMap(r=>r.worktrees)) ?? []),...(zed.data?.monitor_only ?? [])].find(w=>w.path===path);
 const stale=!dbs.data||dbs.data.stale||Date.now()-dbs.at>=dbs.data.fresh_for_seconds*1000;
 const matches=stale?[]:(scoped?scope.connections:dbs.data!.connections).filter(d=>d.owner?.[primary?'primary_path':'worktree_path']===path&&d.status==='available'&&d.cloudbeaver_url);
 return <span className="st-actions">{tree?.zed_url && <a href={tree.zed_url} title={`Open ${path} in Zed`}>Zed ↗</a>}{matches.length===1?<DbLink db={matches[0]!}/>:matches.length>1?<button onClick={()=>setChoose(true)}>Databases ({matches.length})</button>:null}{choose && <Modal title="Choose a database" close={()=>setChoose(false)}>{stale?<Notice>The catalog is stale. Waiting for a fresh check.</Notice>:matches.map(d=><p key={d.id}><DbLink db={d}/></p>)}</Modal>}</span>;
}
export function DbLink({db}:{db:Database}){return db.cloudbeaver_url?<a href={db.cloudbeaver_url} target="_blank" rel="noopener noreferrer">{db.name || db.database} ↗</a>:null;}
export function CopyText({text,label='Copy'}:{text:string;label?:string}){const [state,setState]=useState('');return <><button onClick={()=>void navigator.clipboard.writeText(text).then(()=>setState('Copied'),()=>setState('manual'))}>{label}</button>{state==='manual'?<textarea className="st-copy" readOnly value={text} onFocus={e=>e.target.select()} aria-label="Copy this text manually"/>:<span role="status">{state}</span>}</>;}
export function CopyReport(){const {snapshot}=useMonitor();if(!snapshot.data)return null;const s=snapshot.data;const text=[`ST · ${s.system.hostname} · ${new Date(s.timestamp*1000).toISOString()}`,`CPU ${percent(s.system.cpu_percent)} | RAM ${bytes(s.system.memory_used)} / ${bytes(s.system.memory_total)}`,...s.projects.flatMap(p=>p.worktrees.filter(w=>w.running).map(w=>`${p.name} / ${w.branch}: ${bytes(w.memory_bytes)}, CPU ${percent(w.cpu_percent)}\n  ${w.path}\n  Worktree ID: ${w.id}`)),'Unassigned containers: '+s.unassigned_containers.map(c=>c.name).join(', ')].join('\n');return <CopyText text={text} label="Copy system report"/>;}
export async function cleanupBrief(id:string){return api<{prompt:string;resources:unknown}>(`/api/cleanup-plan/${encodeURIComponent(id)}`);}
