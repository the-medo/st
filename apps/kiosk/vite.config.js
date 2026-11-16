import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

function offlineShell() {
  return {
    name: 'faceplate-offline-shell',
    enforce: 'post',
    generateBundle(_, bundle) {
      const assets = ['/', ...Object.keys(bundle).filter(file => file.startsWith('assets/')).sort().map(file => '/' + file)];
      const template = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8');
      const id = createHash('sha256').update(JSON.stringify(assets)).update(template).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__BUILD_ID__', id).replace('__FILES__', JSON.stringify(assets)) });
    }
  };
}
export default defineConfig({ plugins: [svelte(), offlineShell()] });
