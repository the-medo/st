<script lang="ts">
  const paths = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
    views: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    calendar: 'M4 6h16v15H4z M8 3v5 M16 3v5 M4 11h16 M8 15h2 M14 15h2',
    tasks: 'M3 6l2 2 4-5 M12 6h9 M3 15l2 2 4-5 M12 15h9',
    notes: 'M5 3h14v12l-6 6H5z M13 21v-6h6 M8.5 8h7 M8.5 11.5h4',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M12 6v6l4 2',
    theme: 'M12 21a9 9 0 1 1 9-9c0 2.6-2 3.2-3.7 2.8-1.9-.5-3 .5-2.1 2.3 1 2.1-.3 3.9-3.2 3.9z M7.6 11h.1 M10.2 7.4h.1 M15 7.6h.1',
    chevron: 'm8 10 4 4 4-4',
    close: 'm6 6 12 12 M18 6 6 18',
    check: 'm4 12 5 5L20 6',
    message: 'M4 4h16v12H10l-6 4z M8 8h8 M8 12h5'
  };
  let { name, size = 19 }: { name: keyof typeof paths; size?: number } = $props();
</script>
<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d={paths[name]} /></svg>
