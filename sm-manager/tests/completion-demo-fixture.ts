/** The existing demo simulates turn transitions; supply the new server receipt contract.
 * Real storage, concurrency and metadata-only changes are covered by completion-badges-browser.ts.
 */
export const completionDemoFixture = `
const originalFixtureFetch=window.fetch;
const activityRecords=new Map(JSON.parse(sessionStorage.getItem('fixture:server-activity')||'[]'));
const saveActivity=()=>sessionStorage.setItem('fixture:server-activity',JSON.stringify([...activityRecords]));
window.fetch=async(input,init)=>{
 const url=new URL(input instanceof Request?input.url:input,location.href);
 if(url.pathname==='/agents/api/medo/read-completion'){
  const {threadId,completionId}=JSON.parse(init.body),held=activityRecords.get(threadId);
  if(held&&held.completionId===completionId&&held.unread){held.unread=false;held.revision++;if(held.status==='done')held.status='idle';saveActivity();}
  return Response.json({threadId,activity:held});
 }
 const response=await originalFixtureFetch(input,init);
 if(!response.ok)return response;
 if(url.pathname==='/agents/api/medo/catalog'){
  const data=await response.json();
  for(const chat of data.chats){
   const held=activityRecords.get(chat.id),status=chat.status||'idle';
   const next=held?{...held}:{revision:1,status,unread:false,completionId:null};
   if(held&&held.status!==status){
    next.status=status;next.revision++;
    if(held.status==='working'&&(status==='done'||status==='idle')){next.unread=true;next.completionId='fixture-turn-'+next.revision;}
   }
   activityRecords.set(chat.id,next);chat.activity=next;
  }
  saveActivity();return Response.json(data);
 }
 if(url.pathname==='/agents/api/pane/conversation'||url.pathname==='/agents/api/medo/conversation'){
  const data=await response.json(),id='00000000-0000-4000-8000-000000000001',held=activityRecords.get(id);
  if(held&&held.completionId&&data.turns?.length){
   data.history_id='medo:'+id;data.version+=':'+held.completionId;
   const last=data.turns.at(-1);
   if(last.role==='assistant'){
    last.turn_id=held.completionId;
    const text=last.parts.findLast(part=>part.kind==='text');
    if(text)text.phase='final_answer';
   }
  }
  return Response.json(data);
 }
 return response;
};
`;
