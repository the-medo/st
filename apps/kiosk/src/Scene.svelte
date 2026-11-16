<script lang="ts">
import {onMount} from 'svelte';
let host:HTMLDivElement, unavailable=$state(false);
onMount(()=>{
 let disposed=false,cleanup=()=>{};
 Promise.all([import('three'),import('three/addons/controls/OrbitControls.js')]).then(([T,{OrbitControls}])=>{
   if(disposed)return;
   const renderer=new T.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));host.appendChild(renderer.domElement);
   const scene=new T.Scene();scene.background=new T.Color(0x15231d);
   const camera=new T.PerspectiveCamera(40,1,.1,100);camera.position.set(0,0,6);
   const controls=new OrbitControls(camera,renderer.domElement);controls.enablePan=false;controls.minDistance=3;controls.maxDistance=10;
   const group=new T.Group();scene.add(group);const materials:TMaterial[]=[];type TMaterial=InstanceType<typeof T.MeshStandardMaterial>;
   function mesh(geometry:InstanceType<typeof T.BufferGeometry>,color:number){const material=new T.MeshStandardMaterial({color,roughness:.4,metalness:.4});materials.push(material);const m=new T.Mesh(geometry,material);group.add(m);return m}
   const ring=mesh(new T.TorusGeometry(1.5,.07,12,80),0xc6d5a4);
   const minute=mesh(new T.BoxGeometry(.055,1.12,.08).translate(0,.56,0),0xbde3d0);
   const hour=mesh(new T.BoxGeometry(.09,.78,.12).translate(0,.39,.05),0xf2ba70);
   const light=new T.DirectionalLight(0xffffff,3);light.position.set(2,3,4);scene.add(light,new T.AmbientLight(0xffffff,1.4));
   function draw(){const d=new Date();minute.rotation.z=-(d.getMinutes()+d.getSeconds()/60)*Math.PI/30;hour.rotation.z=-(d.getHours()+d.getMinutes()/60)*Math.PI/6;renderer.render(scene,camera)}
   const size=new ResizeObserver(()=>{const w=host.clientWidth,h=Math.max(1,host.clientHeight);renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();draw()});size.observe(host);
   controls.addEventListener('change',draw);const timer=setInterval(draw,1000);draw();
   cleanup=()=>{clearInterval(timer);controls.dispose();size.disconnect();[ring,minute,hour].forEach(x=>x.geometry.dispose());materials.forEach(m=>m.dispose());renderer.dispose();renderer.domElement.remove()};
 }).catch(()=>unavailable=true);
 return ()=>{disposed=true;cleanup()};
});
</script><div bind:this={host}>{#if unavailable}3D rendering unavailable on this display.{/if}</div>
<style>div{height:100%;width:100%;touch-action:none}</style>
