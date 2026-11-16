<script lang="ts">
  import { onMount } from 'svelte';
  import type { Theme } from './themes';

  let { theme }: { theme: Theme } = $props();
  let host: HTMLDivElement, unavailable = $state(false);
  let applyTheme = $state<((next: Theme) => void) | undefined>();
  $effect(() => { applyTheme?.(theme); });

  onMount(() => {
    let disposed = false, cleanup = () => {};
    Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]).then(([T, {OrbitControls}]) => {
      if (disposed) return;
      const renderer = new T.WebGLRenderer({antialias: true});
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      host.appendChild(renderer.domElement);
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(37, 1, .1, 100);
      camera.position.set(0, .15, 6);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enablePan = false; controls.minDistance = 3.5; controls.maxDistance = 10;

      const body = new T.MeshStandardMaterial({roughness:.68, metalness:.12});
      const ink = new T.MeshStandardMaterial({roughness:.48});
      const accent = new T.MeshStandardMaterial({roughness:.42, metalness:.18});
      const geometries: InstanceType<typeof T.BufferGeometry>[] = [];
      function add(geometry: InstanceType<typeof T.BufferGeometry>, material: typeof body) {
        geometries.push(geometry);
        const mesh = new T.Mesh(geometry, material); scene.add(mesh); return mesh;
      }
      add(new T.CylinderGeometry(1.48,1.45,.14,96).rotateX(Math.PI / 2), body);
      add(new T.TorusGeometry(1.49,.025,8,96), accent).position.z=.075;
      const ticks = new T.InstancedMesh(new T.BoxGeometry(.022,.105,.026), ink, 60);
      const marker = new T.Object3D();
      for (let i=0; i<60; i++) {
        const angle=i*Math.PI/30, major=i%5===0;
        marker.position.set(Math.sin(angle)*1.32, Math.cos(angle)*1.32,.09);
        marker.rotation.z=-angle;
        marker.scale.set(major?2.2:1,major?1.7:.65,1);
        marker.updateMatrix(); ticks.setMatrixAt(i,marker.matrix);
      }
      scene.add(ticks);
      const minute=add(new T.BoxGeometry(.045,1.05,.045).translate(0,.525,.14),ink);
      const hour=add(new T.BoxGeometry(.075,.73,.055).translate(0,.365,.16),ink);
      const second=add(new T.BoxGeometry(.022,1.34,.028).translate(0,.44,.21),accent);
      add(new T.SphereGeometry(.065,16,12),accent).position.z=.21;
      const light=new T.DirectionalLight(0xffffff,2);light.position.set(2,3,5);
      scene.add(light,new T.AmbientLight(0xffffff,1.5));
      function draw() {
        const d=new Date();
        minute.rotation.z=-(d.getMinutes()+d.getSeconds()/60)*Math.PI/30;
        hour.rotation.z=-(d.getHours()+d.getMinutes()/60)*Math.PI/6;
        second.rotation.z=-d.getSeconds()*Math.PI/30;
        renderer.render(scene,camera);
      }
      applyTheme = next => {
        scene.background = new T.Color(next.sky);
        body.color.set(next.dial); ink.color.set(next.ticks); accent.color.set(next.accent); draw();
      };
      const size = new ResizeObserver(() => {
        const w=Math.max(1,host.clientWidth), h=Math.max(1,host.clientHeight);
        renderer.setSize(w,h); camera.aspect=w/h; camera.updateProjectionMatrix(); draw();
      });
      size.observe(host); controls.addEventListener('change',draw);
      const timer=setInterval(draw,1000);
      cleanup=() => {
        clearInterval(timer); size.disconnect(); controls.dispose(); ticks.dispose(); ticks.geometry.dispose();
        geometries.forEach(g=>g.dispose()); [body,ink,accent].forEach(m=>m.dispose());
        renderer.dispose(); renderer.domElement.remove();
      };
    }).catch(() => unavailable = true);
    return () => { disposed=true; cleanup(); applyTheme=undefined; };
  });
</script>
<div class="scene" bind:this={host}>{#if unavailable}3D rendering unavailable on this display.{/if}</div>
<style>.scene{width:100%;height:100%;touch-action:none;display:grid;place-items:center;}</style>
