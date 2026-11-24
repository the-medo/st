import {useEffect, useState} from 'react';
import {NavLink, Route, Routes, useLocation, useNavigate} from 'react-router';
import {Activity, FolderGit2, Boxes, HardDrive, Terminal, CalendarDays, ListTodo, Monitor, Wind, Database, Code, Menu, Home as HomeIcon} from 'lucide-react';
import {Home} from '../features/Home';
import {Notice} from '../components/Ui';
import {usePoll} from '../lib/api';
import type {Snapshot, UiConfig} from '../lib/types';
const navigation = [['overview','Overview',Activity],['projects','Projects',FolderGit2],['containers','Containers',Boxes],['codex','Codex',Terminal],['storage','Storage',HardDrive],['zed','Zed',Code],['dbs','DBs',Database]] as const;
export function App(){
  const location=useLocation(), navigate=useNavigate(); const [drawer,setDrawer]=useState(false);
  const config=usePoll<UiConfig>('/api/ui-config',60000); const monitor=usePoll<Snapshot>('/api/snapshot');
  const workmode = new URLSearchParams(location.search).has('workmode');
  const title=location.pathname==='/'?'Home':navigation.find(n=>`/${n[0]}`===location.pathname)?.[1] ?? location.pathname.split('/').filter(Boolean).at(-1)?.replaceAll('-',' ') ?? 'Home';
  useEffect(()=>{if(location.pathname==='/' && location.hash){const hash=location.hash.slice(1);const path=hash==='home'?'/':hash==='system'?'/overview':`/${hash}`;navigate(path+location.search,{replace:true});}},[location.hash,location.pathname,location.search,navigate]);
  useEffect(()=>{document.title=`ST · ${title}`;setDrawer(false);},[title]);
  return <div className="st-app" data-workmode={workmode}>
    <aside className={`st-sidebar ${drawer?'open':''}`}><NavLink className="st-brand" to="/"><img src="/st-logo.svg" alt="S.T."/><span>SYSTEM CONSOLE</span></NavLink><nav aria-label="Main navigation"><NavLink to="/" end><HomeIcon size={18}/>Home</NavLink>{navigation.map(([path,label,Icon])=><NavLink key={path} to={`/${path}${location.search}`}><Icon size={18}/>{label}</NavLink>)}</nav>
    <div className="st-sidebar-bottom">{config.data?.planner && <nav aria-label="Planner"><span className="st-nav-label">Planner</span><NavLink to="/planner/tasks"><ListTodo size={18}/>Tasks</NavLink><NavLink to="/planner/calendar"><CalendarDays size={18}/>Calendar</NavLink></nav>}{!workmode && <nav aria-label="Devices"><span className="st-nav-label">Devices</span><NavLink to="/faceplate"><Monitor size={18}/>Faceplate</NavLink><NavLink to="/air-quality"><Wind size={18}/>Air quality</NavLink>{config.data?.printer_url && <a href={config.data.printer_url} target="_blank" rel="noopener noreferrer"><img src="/prusa-connect.svg" alt="" width="18"/>Prusa Connect ↗</a>}</nav>}
    <button role="switch" aria-checked={workmode} onClick={()=>{const p=new URLSearchParams(location.search);if(workmode)p.delete('workmode');else p.set('workmode','1');navigate({pathname:location.pathname,search:p.toString()});}}>Workmode <span>{workmode?'On':'Off'}</span></button><small>{monitor.data?.system.hostname ?? 'Connecting…'}<br/>ST · v2 preview</small></div></aside>
    <main className="st-main"><header className="st-topbar"><button className="st-menu" aria-label="Toggle S.T. navigation" aria-expanded={drawer} onClick={()=>setDrawer(!drawer)}><Menu/></button><h1><span>ST /</span> {title}</h1><span className={`st-connection ${monitor.error?'offline':''}`}>{monitor.error?'Reconnecting':monitor.data?.stale?'Stale':'Connected'}</span></header><div className="st-content">{config.error && <Notice retry={config.refresh}>{config.error}</Notice>}<Routes><Route path="/" element={<Home snapshot={monitor.data} config={config.data} error={monitor.error}/>}/><Route path="*" element={<Notice>This console page is being migrated. The legacy console remains available in the installed application.</Notice>}/></Routes></div></main>
  </div>;
}
