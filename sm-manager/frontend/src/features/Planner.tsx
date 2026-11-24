import {useEffect,useRef,useState} from 'react';
import {useLocation,useNavigate} from 'react-router';
import {Notice} from '../components/Ui';
const pages=new Set(['tasks','calendar','contacts','notes','journals']);
export function plannerPath(value:unknown):string|null{if(typeof value!=='string'||!value.startsWith('/planner/'))return null;const u=new URL(value,location.origin);if(u.origin!==location.origin||!pages.has(u.pathname.slice(9)))return null;u.searchParams.delete('st-embedded');return u.pathname+u.search+u.hash;}
export function Planner({active}:{active:boolean}){
 const route=useLocation(),navigate=useNavigate();const frame=useRef<HTMLIFrameElement>(null),ready=useRef(false),current=useRef<string|null>(null);
 const desired=useRef('/planner/tasks');const [src,setSrc]=useState<string|null>(null),[error,setError]=useState(false),[loaded,setLoaded]=useState(false);
 const path=plannerPath(route.pathname+route.search+route.hash);if(path)desired.current=path;
 const send=(type:string,data:object={})=>frame.current?.contentWindow?.postMessage({type,...data},location.origin);
 const start=()=>{ready.current=false;setLoaded(false);setError(false);const u=new URL(desired.current,location.origin);u.searchParams.set('st-embedded','1');setSrc(u.pathname+u.search+u.hash);};
 useEffect(()=>{if(active&&!src)start();},[active,src]);
 useEffect(()=>{if(!src||loaded)return;const timer=setTimeout(()=>setError(true),15000);return()=>clearTimeout(timer);},[src,loaded]);
 useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.origin!==location.origin||event.source!==frame.current?.contentWindow)return;const data=event.data;if(!data||typeof data!=='object')return;if(data.type==='st:home'){if(active)navigate('/');return;}const next=plannerPath(data.path);if(!next)return;
  if(data.type==='st:ready'){ready.current=true;current.current=next;setLoaded(true);setError(false);if(next!==desired.current)send('st:navigate',{path:desired.current});send('st:active',{active:active&&!document.hidden});}
  if(data.type==='st:route'){current.current=next;if(active)navigate(next,{replace:data.replace===true});}
  if(data.type==='st:navigated')current.current=next;};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[active,navigate]);
 useEffect(()=>{if(active&&ready.current&&current.current!==desired.current)send('st:navigate',{path:desired.current});const visibility=()=>{if(ready.current)send('st:active',{active:active&&!document.hidden});};visibility();document.addEventListener('visibilitychange',visibility);return()=>document.removeEventListener('visibilitychange',visibility);},[active,path]);
 return <section hidden={!active} aria-label="Planner">{active&&!loaded&&<Notice retry={error?()=>{start();if(frame.current)frame.current.src=src??'';}:undefined}>{error?'Planner is taking longer to connect. Retry or return to S.T.':'Opening planner…'}</Notice>}{src&&<iframe ref={frame} src={src} title="ST Planner" className="st-planner"/>}</section>;
}
