import {Link} from 'react-router';
import {Chart} from '../components/Chart';
import {Notice} from '../components/Ui';
import {usePoll, percent} from '../lib/api';
import type {History, Snapshot, UiConfig} from '../lib/types';
export function Home({snapshot, config, error}: {snapshot: Snapshot | null; config: UiConfig | null; error: string}) {
  const history = usePoll<History>('/api/history?hours=0.25&entity=host');
  const stale = !snapshot || snapshot.stale || Date.now()/1000-snapshot.timestamp>Math.max(30,snapshot.interval*3);
  return <div className="st-home"><aside className="st-home-metrics"><p className="st-eyebrow">At a glance</p>
    {(['memory_bytes','cpu_percent'] as const).map((key,i)=><Link to="/overview" className="st-resource" key={key}><span>{i?'CPU':'RAM'}</span><strong>{i ? percent(snapshot?.system.cpu_percent) : snapshot && snapshot.system.memory_total > 0 ? `${(snapshot.system.memory_used/1e9).toFixed(1)} GB` : '—'}</strong><small>{i ? 'Whole-machine processor usage' : snapshot ? `of ${(snapshot.system.memory_total/1e9).toFixed(1)} GB · ${(snapshot.system.memory_used/snapshot.system.memory_total*100).toFixed(1)}%` : 'Waiting for a sample'}</small>
      <Chart compact ceiling={100} format={percent} series={[{id:key,label:key,color:i?'#aa8a56':'#6d927d',gap:history.data?.bucket_seconds ?? 10,points:history.data?.points.map(p=>({timestamp:p.timestamp,value:key==='memory_bytes'?p.memory_bytes==null||!snapshot?.system.memory_total?null:p.memory_bytes/snapshot.system.memory_total*100:p.cpu_percent})) ?? []}]}/><small>Last 15 min · 0–100%</small></Link>)}
    <small>{stale || error ? 'Last known readings · reconnecting' : 'Live system readings'}</small><Link to="/overview">View system monitor →</Link></aside>
    <section><div className="st-section-title"><h2>Your services</h2><span>A place for everything.</span></div>{!config && <Notice>Loading services…</Notice>}<div className="st-services">{config?.services.map((s,i)=>{
      const body=<><div className="st-service-top"><svg viewBox="0 0 48 48"><use href={`/home-icons.svg#${s.icon}`}/></svg><small>{s.category}</small></div><h3>{s.name}</h3><p>{s.description}</p><footer><span>{s.destination ?? new URL(s.url,location.origin).hostname}</span><span>{s.url.startsWith('https:')?'↗':'→'}</span></footer></>;
      return s.url.startsWith('https:') ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className={`st-service tone-${s.tone}`}>{body}</a> : <Link key={i} to={s.url.startsWith('/planner')?s.url:`/${s.url.split('#')[1] || ''}`} className={`st-service tone-${s.tone}`}>{body}</Link>;
    })}</div>{history.error && <Notice retry={history.refresh}>History unavailable; service links remain available.</Notice>}</section></div>;
}
