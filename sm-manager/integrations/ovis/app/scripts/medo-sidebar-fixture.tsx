import '../src/styles.css';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MedoProjects } from '../src/components/MedoProjects.tsx';
import { MedoNewConversation, type MedoNewPage } from '../src/components/MedoNewConversation.tsx';
import type { MedoCatalog } from '../shared/medo.ts';
import { SettingsProvider } from '../src/lib/settings.ts';
import { Markdown } from '../src/components/Markdown.tsx';
import { Droplet } from '../src/components/Droplet.tsx';
import { showDroplet } from '../src/lib/droplet.ts';
import '../src/components/ChatView.css';

function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<MedoCatalog | null>(null);
  const [composer, setComposer] = useState<MedoNewPage | null>(null);
  const key = useRef(0);
  const feedback = Reflect.get(window, '__stFeedback') as { reply: string; title: string } | undefined;
  return <div className={composer ? "fixture-composing" : undefined} style={{ display: 'flex', height: '100dvh', background: 'var(--bg)' }}>
    <style>{"@media(max-width:480px){.fixture-composing>aside{display:none}}"}</style>
    <aside style={{ width: 290, flexShrink: 0, background: 'var(--bg-panel)' }}>
      <MedoProjects selectedPaneId={composer ? null : selected} selectedThreadId={null} onCatalog={setCatalog} composing={composer !== null} onNew={(page) => setComposer({ ...page, key: ++key.current })} onRead={() => setComposer(null)} onSettings={() => {}}
        onOpen={async (pane, isCurrent) => {
          await fetch(`/fixture/select?pane=${pane}`);
          if (isCurrent()) { setSelected(pane); setComposer(null); }
        }} />
    </aside>
    <main style={{ padding: composer ? 0 : 32, flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>{composer ? <MedoNewConversation key={composer.key} projects={catalog?.projects ?? []} initialProject={composer.projectId} initialFolder={composer.folderId} onStart={composer.start} onClose={() => setComposer(null)} /> : <><h1>{feedback ? 'Conversation feedback' : 'Conversation navigation'}</h1><output data-testid="selected">{selected ?? 'No conversation selected'}</output>
      {feedback && <><div className="chat-turn-user" style={{ marginBlock: 32 }}><div className="chat-bubble"><Markdown>{feedback.reply}</Markdown></div></div>
        <button className="btn" onClick={() => showDroplet({ machineId: 'local', paneId: 'fixture', agent: 'codex', title: feedback.title, machine: null, kind: 'done' })}>Preview completion</button>
        <Droplet onOpen={() => setSelected('fixture')} /></>}
    </>}</main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<SettingsProvider><Fixture /></SettingsProvider>);
