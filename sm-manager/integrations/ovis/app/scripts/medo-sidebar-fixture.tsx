import '../src/styles.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MedoProjects } from '../src/components/MedoProjects.tsx';
import { SettingsProvider } from '../src/lib/settings.ts';
import { Markdown } from '../src/components/Markdown.tsx';
import { Droplet } from '../src/components/Droplet.tsx';
import { showDroplet } from '../src/lib/droplet.ts';
import '../src/components/ChatView.css';

function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  const feedback = Reflect.get(window, '__stFeedback') as { reply: string; title: string } | undefined;
  return <div style={{ display: 'flex', height: '100dvh', background: 'var(--bg)' }}>
    <aside style={{ width: 290, background: 'var(--bg-panel)' }}>
      <MedoProjects selectedPaneId={selected} selectedThreadId={null} onCatalog={() => {}} onRead={() => {}} onSettings={() => {}}
        onOpen={async (pane, isCurrent) => {
          await fetch(`/fixture/select?pane=${pane}`);
          if (isCurrent()) setSelected(pane);
        }} />
    </aside>
    <main style={{ padding: 32, flex: 1, minWidth: 0 }}><h1>{feedback ? 'Conversation feedback' : 'Conversation navigation'}</h1><output data-testid="selected">{selected ?? 'No conversation selected'}</output>
      {feedback && <><div className="chat-turn-user" style={{ marginBlock: 32 }}><div className="chat-bubble"><Markdown>{feedback.reply}</Markdown></div></div>
        <button className="btn" onClick={() => showDroplet({ machineId: 'local', paneId: 'fixture', agent: 'codex', title: feedback.title, machine: null, kind: 'done' })}>Preview completion</button>
        <Droplet onOpen={() => setSelected('fixture')} /></>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<SettingsProvider><Fixture /></SettingsProvider>);
