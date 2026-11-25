import '../src/styles.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MedoProjects } from '../src/components/MedoProjects.tsx';
import { SettingsProvider } from '../src/lib/settings.ts';

function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  return <div style={{ display: 'flex', height: '100dvh', background: 'var(--bg)' }}>
    <aside style={{ width: 290, background: 'var(--bg-panel)' }}>
      <MedoProjects selectedPaneId={selected} selectedThreadId={null} onCatalog={() => {}} onRead={() => {}} onNew={() => {}} onSettings={() => {}}
        onOpen={async (pane, isCurrent) => {
          await fetch(`/fixture/select?pane=${pane}`);
          if (isCurrent()) setSelected(pane);
        }} />
    </aside>
    <main style={{ padding: 32 }}><h1>Conversation navigation</h1><output data-testid="selected">{selected ?? 'No conversation selected'}</output></main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<SettingsProvider><Fixture /></SettingsProvider>);
