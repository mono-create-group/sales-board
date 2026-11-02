/* 共同営業台帳 — mono.Board の営業タブと同じ機能を、Firestore を正本にして動かす静的アプリ。
   安全設計（2026-10-23 の EditFlow 上書き事故の再発防止）：
   ①初回は必ずリモート取得（onSnapshot）から。初期データ（シード）をリモートへ書く処理は無い
   ②書き込みは 1候補＝1ドキュメントの部分更新（update）／存在しない時だけの追加（transaction で exists を確認）のみ。
     全件置き換え・配列の丸ごと保存・削除は無い
   ③localStorage に営業データを保存しない（保存するのは送信元の選択だけ＝画面ごとの便利機能） */
"use strict";
const FIREBASE_CONFIG={apiKey:"AIzaSyA8kjyY8xF4usk5K7TyBfab_wW3EIFr9Z4",authDomain:"editflow-mono-create.firebaseapp.com",projectId:"editflow-mono-create",appId:"1:280142126082:web:3defcc1b0d370b14781b1b"};
const OWNERS=["nakamurakouta512@gmail.com","mono.create.group@gmail.com"];
/* 営業の「範囲」：動画編集／サムネイル（同じ形の別コレクション）。募集は別の形 */
const SC_V={key:"video",coll:"sales_candidates",label:""}, SC_T={key:"thumb",coll:"sales_thumb_candidates",label:"サムネイル"};
const COLL_RECRUIT="sales_recruit", COLL_PHOTO="sales_photos", COLL_META="sales_meta";

firebase.initializeApp(FIREBASE_CONFIG);
const auth=firebase.auth(), db=firebase.firestore(), FV=firebase.firestore.FieldValue;
const $=id=>document.getElementById(id);
const TS=()=>FV.serverTimestamp(), DEL=()=>FV.delete();
function el(tag,cls,txt){ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }

/* ---- 状態（Firestore のスナップショットを持つだけ。書き換えはドキュメント単位で Firestore に送る） ---- */
let dms=[], tdms=[], recruit=[], goal=null, salesSec="video", loaded={};
let sender="mono.create.movie"; try{ const s=localStorage.getItem("bd.sender"); if(s) sender=s; }catch(e){}
let pendingDm=null;
const dmOpen={};
function keepOpen(det,key){ det.open=!!dmOpen[key]; det.addEventListener("toggle",()=>{ dmOpen[key]=det.open; }); }

const nowMs=()=>Date.now();
const ms=t=>!t?0:(t.toMillis?t.toMillis():(typeof t==="number"?t:0));
const jst=m=>new Date(m).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Tokyo"});
const jstDate=m=>new Date(m).toLocaleDateString("ja-JP",{month:"numeric",day:"numeric",timeZone:"Asia/Tokyo"});
const mins=m=>Math.max(0,Math.round(m/60000));
function dur(m){ if(m<60) return m+"分"; const h=Math.floor(m/60); return h+"時間"+(m%60?(m%60)+"分":""); }
function toast(msg,act){ const e=$("toast"); e.textContent=msg; if(act){ const b=document.createElement("button"); b.textContent=act.label; b.onclick=()=>{ e.hidden=true; act.fn(); }; e.appendChild(b); } e.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>{e.hidden=true},act?7000:2600); }
async function copyText(t){ try{ await navigator.clipboard.writeText(t); return true; }catch(e){ try{ const ta=document.createElement("textarea"); ta.value=t; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select(); const ok=document.execCommand("copy"); ta.remove(); return ok; }catch(e2){ return false; } } }
const hnd=d=>String(d.handle||d.id||"").replace(/^@+/,"");   /* @なしハンドル */

/* ---- サインイン ---- */
function showLogin(msg){ $("login").hidden=false; $("app").hidden=true; $("who").hidden=true; $("loginErr").textContent=msg||""; }
$("loginBtn").onclick=async()=>{
  $("loginErr").textContent="";
  const p=new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({prompt:"select_account"});
  try{ await auth.signInWithPopup(p); }
  catch(e){
    if(e&&(e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment")){ try{ await auth.signInWithRedirect(p); return; }catch(e2){ e=e2; } }
    $("loginErr").textContent="ログインできませんでした："+(e&&e.code||e);
  }
};
$("logout").onclick=()=>auth.signOut();
let unsubs=[];
auth.onAuthStateChanged(u=>{
  unsubs.forEach(f=>f()); unsubs=[]; dms=[]; tdms=[]; recruit=[]; goal=null; loaded={};
  if(!u){ showLogin(); return; }
  const ok=u.emailVerified&&OWNERS.includes((u.email||"").toLowerCase());
  if(!ok){ showLogin((u.email||"このアカウント")+" には編集の権限がありません。別のアカウントでログインしてください。"); auth.signOut(); return; }
  $("login").hidden=true; $("app").hidden=false; $("who").hidden=false; $("email").textContent=u.email;
  start();
});
/* 読み込み：必ずリモートから（onSnapshot）。ここに書き込みは無い */
function start(){
  const sub=(name,set)=>unsubs.push(db.collection(name).onSnapshot(s=>{ set(s.docs.map(d=>Object.assign({id:d.id},d.data()))); loaded[name]=true; const fc=s.metadata.fromCache; $("sync").textContent=(fc?"サーバーへ接続中… ":"")+"動画編集 "+dms.length+" 件・サムネイル "+tdms.length+" 件・募集 "+recruit.length+" 件を読み込みました"; render(); },e=>{ $("sync").textContent="読み込めませんでした（"+name+"）："+(e&&e.code||e); }));
  sub(SC_V.coll,v=>{ dms=v; }); sub(SC_T.coll,v=>{ tdms=v; }); sub(COLL_RECRUIT,v=>{ recruit=v; });
  unsubs.push(db.collection(COLL_META).doc("goal").onSnapshot(s=>{ goal=s.exists?s.data():null; render(); }));
}
const scArr=sc=>sc.key==="thumb"?tdms:dms;
const ST_SENT=["sent","replied","meeting","converted"];            /* 送信済み（返信以上を含む） */
const isSentish=d=>ST_SENT.includes(d.status);
const SR={sent:0,replied:1,meeting:2,converted:3};
const swOrd=(a,b)=>(a.order||0)-(b.order||0)||String(a.id).localeCompare(String(b.id));
const cnt3=()=>({replied:dms.filter(d=>(SR[d.status]||0)>=1).length,talks:dms.filter(d=>(SR[d.status]||0)>=2).length,won:dms.filter(d=>d.status==="converted").length});

/* ---- 書き込み：1候補＝1ドキュメントの部分更新だけ ---- */
const refOf=(sc,id)=>db.collection(sc.coll).doc(id);
async function upd(sc,id,u){ await refOf(sc,id).update(Object.assign({updatedAt:TS()},u)); }
async function excludeDm(d,quiet,sc){
  sc=sc||SC_V;
  try{ await upd(sc,d.id,{status:"excluded",excludedAt:TS()}); if(!quiet) toast("候補から外しました（除外リストに入れました）",{label:"元に戻す",fn:()=>restoreDm(d.id,false,sc)}); return true; }
  catch(e){ toast("保存できませんでした"); return false; }
}
async function restoreDm(id,quiet,sc){
  sc=sc||SC_V; const say=m=>{ if(!quiet) toast(m); };
  try{ await upd(sc,id,{status:"waiting",excludedAt:DEL()}); say("送信待ちに戻しました"); return true; }
  catch(e){ toast("戻せませんでした"); return false; }
}
/* 返信・商談・成約：同じボタンをもう一度押すと「送信済み」に戻る（ボードの stage の切り替えと同じ） */
async function setStage(d,k){
  const to=d.status===k?"sent":k;
  try{ await upd(SC_V,d.id,{status:to,statusAt:TS()}); }catch(e){ toast("保存できませんでした"); }
}
/* 送った／送らない：transaction で現在の状態を確かめ、すでに送信済みなら書かない（二重送信の防止） */
async function markDm(d,st){
  try{
    const res=await db.runTransaction(async tx=>{
      const r=refOf(SC_V,d.id), s=await tx.get(r); if(!s.exists) throw new Error("候補が見つかりません");
      const cur=s.data();
      if(cur.status!=="waiting") return "changed:"+cur.status;
      const u={updatedAt:TS()};
      if(st==="sent"){ u.status="sent"; u.sentAt=TS(); u.sentFrom=sender; u.sentBy="manual"; } else { u.status="skipped"; u.skippedAt=TS(); }
      tx.update(r,u); return "ok";
    });
    if(res!=="ok"){ toast("すでに状態が変わっていました（"+res.replace("changed:","")+"）。表示を更新します"); return; }
    toast(st==="sent"?"送信済みにしました":"送らない相手にしました",{label:"取り消す",fn:async()=>{ try{ await upd(SC_V,d.id,{status:"waiting",sentAt:DEL(),sentFrom:DEL(),sentBy:DEL(),skippedAt:DEL()}); }catch(e){} }});
  }catch(e){ toast("保存できませんでした"); }
}
async function swApprove(d,sc){ try{ await upd(sc||SC_V,d.id,{approved:true,approvedAt:TS()}); return true; }catch(e){ return false; } }
async function swUnapprove(id,sc){ try{ await upd(sc||SC_V,id,{approved:DEL(),approvedAt:DEL()}); return true; }catch(e){ return false; } }

/* ---- プロフィール画面（添付）：sales_photos/<範囲>~<候補ID> に base64 で1枚ずつ持つ。候補ドキュメントは hasPhoto だけ ---- */
const photoId=(sc,id)=>sc.key+"~"+id;
const photoCache=new Map();
async function photoOf(sc,d){
  if(!d||d.hasPhoto!==true) return null; const k=photoId(sc,d.id);
  if(photoCache.has(k)) return photoCache.get(k);
  const p=(async()=>{ try{ const s=await db.collection(COLL_PHOTO).doc(k).get(); if(!s.exists) return null; const x=s.data(); return "data:"+(x.type||"image/jpeg")+";base64,"+x.data; }catch(e){ photoCache.delete(k); return null; } })();
  photoCache.set(k,p); return p;
}
function resizeToJpeg(file,maxSide){
  return new Promise((res,rej)=>{ const url=URL.createObjectURL(file), im=new Image(); im.onload=()=>{ const sc=Math.min(1,maxSide/Math.max(im.width,im.height)); const c=document.createElement("canvas"); c.width=Math.round(im.width*sc); c.height=Math.round(im.height*sc); c.getContext("2d").drawImage(im,0,0,c.width,c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg",0.82).split(",")[1]); }; im.onerror=()=>{ URL.revokeObjectURL(url); rej(new Error("画像を読めません")); }; im.src=url; });
}
function attachPicker(sc,d){
  const inp=document.createElement("input"); inp.type="file"; inp.accept="image/*"; inp.style.display="none"; document.body.appendChild(inp);
  inp.onchange=async()=>{ const f=inp.files&&inp.files[0]; inp.remove(); if(!f) return;
    try{ const b64=await resizeToJpeg(f,1100); if(b64.length>900000) throw new Error("画像が大きすぎます");
      await db.collection(COLL_PHOTO).doc(photoId(sc,d.id)).set({data:b64,type:"image/jpeg",updatedAt:TS()});
      photoCache.delete(photoId(sc,d.id)); await upd(sc,d.id,{hasPhoto:true}); toast("プロフィール画像を保存しました");
    }catch(e){ toast("画像を保存できませんでした："+(e&&e.message||e)); } };
  inp.click();
}

/* ====================== 動画編集：次に送る人のカード ====================== */
function renderGoal(){
  const box=$("goal"); const g=goal; if(!g){ box.hidden=true; return; } box.hidden=false; box.textContent="";
  const days=Math.max(0,Math.ceil((ms(g.deadline)-nowMs())/86400000)); const c=cnt3(); const tgt=g.target||10;
  const h=el("h2","",(g.title||"顧客獲得")+"　成約 "+c.won+" / "+tgt); h.append(el("span","dmsum","あと "+days+" 日")); box.append(h);
  const bar=el("div","gbar"); const i=el("i"); i.style.width=Math.min(100,c.won/tgt*100)+"%"; bar.append(i); box.append(bar);
  const sent=dms.filter(isSentish).length;
  const t=["送信 "+sent,"返信 "+c.replied,"商談 "+c.talks]; if(sent>0) t.push("返信率 "+Math.round(c.replied/sent*100)+"%");
  if(sent>=10&&c.won>0) t.push("あと約 "+Math.ceil((tgt-c.won)/(c.won/sent))+" 通で達成"); else if(sent<10) t.push("実績が出るまで予測なし");
  box.append(el("div","dmsum",t.join("　")));
}
function addPhotoBtn(parent,sc,d){
  const b=el("button","attach",d.hasPhoto===true?"プロフィール画像を差し替える":"プロフィール画像を付ける"); b.type="button"; b.onclick=()=>attachPicker(sc,d); parent.append(b);
}
function renderDms(){
  const box=$("dms"); const ready=dms.filter(d=>d.status==="waiting").sort(swOrd);
  const sentL=dms.filter(isSentish).sort((a,b)=>ms(b.sentAt)-ms(a.sentAt));
  if(!dms.length){ box.hidden=false; box.textContent=""; box.append(el("div","empty",loaded[SC_V.coll]?"動画編集の候補はまだありません。":"読み込み中…")); return; } box.hidden=false; box.textContent="";
  const today=jstDate(nowMs()); const sentToday=sentL.filter(d=>ms(d.sentAt)&&jstDate(ms(d.sentAt))===today).length;
  const last=sentL.length?ms(sentL[0].sentAt):0;
  box.append(el("div","calm","あと "+ready.length+" 人　今日 "+sentToday+" 通"+(last?"　前の送信から "+dur(mins(nowMs()-last)):"")));
  { const un=swEligible(dms).length, ap=swApprovedList(dms).length; const er=el("div","row2"); const sb0=el("button","swgo","スワイプ確認を始める（未確認 "+un+" 件）"); sb0.type="button"; sb0.onclick=()=>swOpen("cards"); const eb0=el("button","","営業許可リスト（"+ap+" 件）を出力"); eb0.type="button"; eb0.onclick=()=>swOpen("export"); er.append(sb0,eb0); box.append(er); }
  if(!ready.length){ box.append(el("div","empty","送る順番の人は、いま残っていません。")); }
  else {
    const d=ready[0]; const c=el("div","sales1");
    const who=el("div","who"); who.append(el("b","","@"+hnd(d))); if(d.rank) who.append(el("span","proj","ランク "+d.rank)); if(d.approved===true) who.append(el("span","proj","営業許可")); c.append(who);
    c.append(el("pre","dmtext",d.text||""));
    const go=document.createElement("a"); go.className="go"; go.textContent="コピーして Instagram で開く"; go.href="https://ig.me/m/"+encodeURIComponent(hnd(d)); go.target="_blank"; go.rel="noopener";
    go.onclick=async()=>{ pendingDm={id:d.id,handle:hnd(d)}; const ok=await copyText(d.text||""); toast(ok?"コピーしました。貼り付けて送ってください":"コピーできませんでした。「全文を見る」から選んでコピーしてください"); };
    c.append(go);
    const sub=el("div","sub2"); const sb=el("button","sent","送った"); sb.onclick=()=>markDm(d,"sent"); const kb=el("button","","送らない"); kb.onclick=()=>markDm(d,"skip"); const xb=el("button","","候補から外す"); xb.onclick=()=>excludeDm(d); sub.append(sb,kb,xb); c.append(sub);
    const pf=document.createElement("a"); pf.className="calm"; pf.textContent="開かないときは、プロフィールから"; pf.href="https://www.instagram.com/"+encodeURIComponent(hnd(d))+"/"; pf.target="_blank"; pf.rel="noopener"; c.append(pf);
    if(d.hasPhoto===true){ const holder=el("div"); c.append(holder); photoOf(SC_V,d).then(src=>{ if(src&&holder.isConnected) holder.append(swShotBtn(src)); }); }
    addPhotoBtn(c,SC_V,d);
    box.append(c);
    if(ready.length>1){ const nx=document.createElement("details"); nx.className="calm"; keepOpen(nx,"queue"); const s2=document.createElement("summary"); s2.textContent="送信待ちキュー（次の人から "+(ready.length-1)+"人）"; nx.append(s2); for(const x of ready.slice(1)){ const r=el("div","xrow"); r.append(el("span","xh","@"+hnd(x))); const xb2=el("button","","候補から外す"); xb2.type="button"; xb2.onclick=()=>excludeDm(x); r.append(xb2); nx.append(r); } box.append(nx); }
  }
  const se=document.createElement("details"); se.className="calm"; keepOpen(se,"sender"); const sm2=document.createElement("summary"); sm2.textContent="送信元: "+sender+"（変える）"; se.append(sm2);
  const seg=el("div","seg2"); for(const a of ["mono.create.movie","kkkk.outaaa","mono.create.ai"]){ const b=el("button","",a); b.setAttribute("aria-pressed",String(sender===a)); b.onclick=()=>{ sender=a; try{ localStorage.setItem("bd.sender",a); }catch(e){} render(); }; seg.append(b); } se.append(seg); box.append(se);
  if(sentL.length){
    const sd=document.createElement("details"); sd.className="calm"; keepOpen(sd,"sent"); const sm3=document.createElement("summary"); sm3.textContent="送信済み（"+sentL.length+"人）。返信が来たら押す"; sd.append(sm3);
    for(const d of sentL){ const r=el("div","sline"); r.append(el("div","","@"+hnd(d)+"　"+(ms(d.sentAt)?jst(ms(d.sentAt)):""))); const st=el("div","stg");
      for(const [k2,lab] of [["replied","返信"],["meeting","商談"],["converted","成約"]]){ const b=el("button","",lab); b.setAttribute("aria-pressed",String(d.status===k2)); b.onclick=()=>setStage(d,k2); st.append(b); }
      r.append(st); sd.append(r); }
    box.append(sd);
  }
  renderExcludedList(box,dms,SC_V,"excluded");
}
/* 除外リスト：候補から外した@ハンドル。いつでも見られ、戻すこともできる */
function renderExcludedList(box,arr,sc,key){
  const ex=arr.filter(d=>d.status==="excluded").sort((a,b)=>ms(b.excludedAt)-ms(a.excludedAt));
  const xd=document.createElement("details"); xd.className="calm"; keepOpen(xd,key); const xs=document.createElement("summary"); xs.textContent="除外リスト（"+ex.length+"件）"; xd.append(xs);
  if(!ex.length) xd.append(el("div","","外した候補はありません。"));
  for(const x of ex){ const r=el("div","xrow"); r.append(el("span","xh","@"+hnd(x)+"　"+(ms(x.excludedAt)?jstDate(ms(x.excludedAt)):""))); const rb=el("button","","戻す"); rb.type="button"; rb.onclick=()=>restoreDm(x.id,false,sc); r.append(rb); xd.append(r); }
  box.append(xd);
}
/* 送りましたか？：Instagram を開いて戻ってきた時に出る確認 */
function showBack(){
  if(!pendingDm) return; const d=dms.find(x=>x.id===pendingDm.id); if(!d||d.status!=="waiting"){ pendingDm=null; return; }
  $("backTxt").textContent="@"+pendingDm.handle+" に送りましたか？"; $("back").hidden=false;
}
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible") showBack(); });
window.addEventListener("focus",showBack); window.addEventListener("pageshow",showBack);
$("backY").onclick=()=>{ const d=dms.find(x=>x.id===(pendingDm&&pendingDm.id)); $("back").hidden=true; pendingDm=null; if(d) markDm(d,"sent"); };
$("backN").onclick=()=>{ $("back").hidden=true; pendingDm=null; };

/* ====================== スワイプ確認（動画編集・サムネイル共通） ====================== */
/* 純関数：カードに出せる人＝送信待ちで、まだ営業許可の印が無い人 */
const swKey=s=>String(s==null?"":s).trim().toLowerCase();
const swOk=d=>!!d&&d.status==="waiting";
function swEligible(arr){ return arr.filter(d=>swOk(d)&&d.approved!==true).sort(swOrd).map(d=>d.id); }
function swApprovedList(arr){ return arr.filter(d=>swOk(d)&&d.approved===true).sort((x,y)=>ms(x.approvedAt)-ms(y.approvedAt)||swOrd(x,y)).map(d=>"@"+hnd(d)); }
function swPrunePure(q,arr){ let i=0; while(i<q.length){ const d=arr.find(x=>x.id===q[i]); if(swOk(d)&&d.approved!==true) break; i++; } return q.slice(i); }
function swPush(st,kind){ if(!st.queue.length) return st; return {queue:st.queue.slice(1),hist:st.hist.concat([{id:st.queue[0],kind}])}; }
function swPop(st){ if(!st.hist.length) return st; const e=st.hist[st.hist.length-1]; return {queue:[e.id].concat(st.queue),hist:st.hist.slice(0,-1)}; }
function swSummary(st){ const ok=st.hist.filter(e=>e.kind==="ok").length; return {ok,no:st.hist.length-ok,total:st.hist.length+st.queue.length,pos:st.hist.length+1,left:Math.max(0,st.queue.length-1)}; }
const swFirst=(d,keys)=>{ for(const k of keys){ const v=d[k]; if(v!=null&&String(v).trim()!=="") return String(v).trim(); } return ""; };
const swNum=v=>{ if(v==null||String(v).trim()==="") return ""; const n=Number(String(v).replace(/,/g,"")); return isFinite(n)?n.toLocaleString("ja-JP"):String(v).trim(); };
const swImgOk=s=>/^https:\/\//i.test(String(s||""))||/^data:image\/(jpeg|png|webp);base64,/.test(String(s||""));
let swSt={queue:[],hist:[]}, swMode="cards", swBusy=false, swShown=null, swScope=SC_V; const swPend={};
function swLinkOf(d){
  const h=hnd(d), l=swFirst(d,["link"]);
  if(/^https:\/\//i.test(l)){ let yt=false; try{ yt=/(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(l).hostname.toLowerCase()); }catch(e){} return {href:l,label:yt?"YouTube を開く ↗":"プロフィールを開く ↗"}; }
  return {href:"https://www.instagram.com/"+encodeURIComponent(h)+"/",label:"Instagram のプロフィールを開く ↗"};
}
const swWait=async(cond,msx)=>{ const t0=Date.now(); while(Date.now()-t0<msx){ if(cond()) return true; await new Promise(r=>setTimeout(r,60)); } return cond(); };
function swOpen(mode,sc){
  swScope=sc||SC_V; swSt={queue:swEligible(scArr(swScope)),hist:[]}; swMode=mode||"cards"; swBusy=false; swShown=null;
  $("sw").hidden=false; document.body.style.overflow="hidden"; swRender();
  try{ $("swX").focus({preventScroll:true}); }catch(e){}
}
function swClose(){ $("sw").hidden=true; document.body.style.overflow=""; swBusy=false; render(); }
function flyCard(stageId,kind){
  const c=document.querySelector("#"+stageId+" .swcard"); let reduce=false; try{ reduce=matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){}
  if(!c||reduce) return Promise.resolve();
  const w=(c.parentNode.clientWidth||360)+120; c.classList.add("snap"); c.style.transform="translateX("+(kind==="ok"?w:-w)+"px) rotate("+(kind==="ok"?18:-18)+"deg)"; c.style.opacity="0";
  if(c._so&&c._sn) (kind==="ok"?c._so:c._sn).style.opacity="1";
  return new Promise(r=>setTimeout(r,200));
}
async function swAct(kind){
  if(swBusy||swMode!=="cards"||$("sw").hidden) return;
  const sc=swScope;
  swSt.queue=swPrunePure(swSt.queue,scArr(sc));
  if(!swSt.queue.length){ swRender(); return; }
  const id=swSt.queue[0], d=scArr(sc).find(x=>x.id===id);
  if(id!==swShown){ swRender(); toast("候補の状態が変わったので、表示を更新しました"); return; }
  swBusy=true; await flyCard("swStage",kind);
  swSt=swPush(swSt,kind); swBusy=false; swRender();
  /* 「なし」は除外（status を excluded に部分更新）、「営業許可」は approved の印だけ */
  const p=kind==="ok"?swApprove(d,sc):excludeDm(d,true,sc); swPend[sc.key+"/"+id]=p;
  const ok=await p;
  if(!ok){
    const i=swSt.hist.findIndex(e=>e.id===id);
    if(i>=0){ swSt={queue:[id].concat(swSt.queue),hist:swSt.hist.filter((_,k)=>k!==i)}; }
    toast("保存できませんでした。もう一度振り分けてください"); swRender();
  }
}
async function swUndo(){
  if(swBusy||swMode!=="cards"||$("sw").hidden||!swSt.hist.length) return;
  swBusy=true; const e=swSt.hist[swSt.hist.length-1], sc=swScope, pk=sc.key+"/"+e.id;
  if(swPend[pk]){ await swPend[pk]; }
  if(swSt.hist.indexOf(e)<0){ swBusy=false; swRender(); return; }
  let ok=false;
  if(e.kind==="ok"){
    ok=await swUnapprove(e.id,sc);
    if(ok) await swWait(()=>{ const c=scArr(sc).find(x=>x.id===e.id); return !!c&&c.approved!==true; },2500);
  } else {
    await swWait(()=>{ const c=scArr(sc).find(x=>x.id===e.id); return !!c&&c.status==="excluded"; },2500);
    ok=await restoreDm(e.id,true,sc);
    if(ok) await swWait(()=>{ const c=scArr(sc).find(x=>x.id===e.id); return !!c&&c.status==="waiting"; },2500);
  }
  if(ok){ swSt=swPop(swSt); } else toast("戻せませんでした。もう一度押してください");
  swBusy=false; swRender();
}
/* スワイプのジェスチャー（動画編集・サムネイル・募集で共通）。右＝許可／採用、左＝なし／不採用 */
function bindSwipe(card,isBusy,act){
  let sx=0, sy=0, dx=0, drag=false, active=false, pid=null;
  const th=()=>Math.min(110,(card.parentNode&&card.parentNode.clientWidth||360)*0.28);
  const tilt=x=>{ card.style.transform="translateX("+x+"px) rotate("+(x/25)+"deg)"; const t=th(); card._so.style.opacity=String(Math.max(0,Math.min(1,x/t))); card._sn.style.opacity=String(Math.max(0,Math.min(1,-x/t))); };
  const reset=()=>{ card.classList.add("snap"); card.style.transform=""; card._so.style.opacity="0"; card._sn.style.opacity="0"; setTimeout(()=>card.classList.remove("snap"),230); };
  card.addEventListener("pointerdown",e=>{ if(isBusy()||(e.pointerType==="mouse"&&e.button!==0)) return; if(e.target.closest("a,button,summary")) return; active=true; drag=false; sx=e.clientX; sy=e.clientY; dx=0; pid=e.pointerId; card.classList.remove("snap"); });
  card.addEventListener("pointermove",e=>{
    if(!active||e.pointerId!==pid) return; const mx=e.clientX-sx, my=e.clientY-sy;
    if(!drag){ if(Math.abs(mx)>8&&Math.abs(mx)>Math.abs(my)*1.2){ drag=true; try{ card.setPointerCapture(pid); }catch(err){} card.classList.add("drag"); } else { if(Math.abs(my)>12&&Math.abs(my)>Math.abs(mx)) active=false; return; } }
    dx=mx; tilt(dx);
  });
  const end=e=>{ if(!active||e.pointerId!==pid) return; active=false; if(!drag) return; drag=false; card.classList.remove("drag"); try{ card.releasePointerCapture(pid); }catch(err){} const t=th(); if(dx>t) act("ok"); else if(dx<-t) act("no"); else reset(); };
  card.addEventListener("pointerup",end);
  card.addEventListener("pointercancel",e=>{ if(!active||e.pointerId!==pid) return; active=false; if(drag){ drag=false; card.classList.remove("drag"); reset(); } });
}
/* プロフィール画面のサムネイル（タップで全画面） */
function swZoomOpen(src){
  if(!swImgOk(src)) return; const z=$("swZoom"); z.textContent="";
  const im=document.createElement("img"); im.src=src; im.alt="プロフィール画面"; im.draggable=false; z.append(im);
  const x=document.createElement("button"); x.type="button"; x.className="zx"; x.textContent="×"; x.setAttribute("aria-label","閉じる"); z.append(x); z.hidden=false;
}
function swZoomClose(){ const z=$("swZoom"); z.hidden=true; z.textContent=""; }
$("swZoom").addEventListener("click",swZoomClose);
document.addEventListener("keydown",e=>{ if(!$("swZoom").hidden){ if(e.key==="Escape"){ e.preventDefault(); e.stopImmediatePropagation(); swZoomClose(); } } },true);
function swShotBtn(src){
  const sb=el("button","swshot"); sb.type="button"; sb.setAttribute("aria-label","プロフィール画面を拡大");
  const im=document.createElement("img"); im.src=src; im.alt="プロフィール画面"; im.draggable=false; im.onerror=()=>sb.remove();
  sb.append(im, el("span","zh","タップで拡大")); sb.onclick=()=>swZoomOpen(src); return sb;
}
function swCard(d){
  const h=hnd(d), c=el("article","swcard"); c.setAttribute("aria-label","@"+h);
  const so=el("span","swstamp ok","営業許可"), sn=el("span","swstamp no","なし"); c.append(so,sn); c._so=so; c._sn=sn;
  const top=el("div","swtop");
  const nm=el("div","swnm"); nm.append(el("b","","@"+h)); const dn=swFirst(d,["name"]); nm.append(el("span",dn?"":"swnone",dn||"表示名 未登録")); top.append(nm); c.append(top);
  /* プロフィール画面（スクショ）：小さなサムネイルにして、タップで全画面 */
  if(d.hasPhoto===true){ const holder=el("div"); c.append(holder); const sc=swScope; photoOf(sc,d).then(src=>{ if(src&&holder.isConnected) holder.append(swShotBtn(src)); }); }
  const rows=el("div","swrows"); const row=(k,v)=>{ const r=el("div","swrow"); r.append(el("span","swk",k), el("span",v?"swv":"swv swnone",v||"未登録")); rows.append(r); };
  row("フォロワー",swNum(d.followers)); row("ジャンル",swFirst(d,["genre"])); row("リールの内容",swFirst(d,["reel","note","line"])); c.append(rows);
  const lk=swLinkOf(d); const a=document.createElement("a"); a.className="swig"; a.textContent=lk.label; a.href=lk.href; a.target="_blank"; a.rel="noopener"; c.append(a);
  if(d.text){ const dt=document.createElement("details"); dt.className="swdm"; const sm=document.createElement("summary"); sm.textContent="DM文を見る"; dt.append(sm, el("pre","",d.text)); c.append(dt); }
  else if(swScope.key==="thumb"){ c.append(el("div","swdm swnone","DM文 未登録")); }
  { const sc=swScope; const ab=el("button","attach",d.hasPhoto===true?"プロフィール画像を差し替える":"プロフィール画像を付ける"); ab.type="button"; ab.onclick=()=>attachPicker(sc,d); c.append(ab); }
  bindSwipe(c,()=>swBusy,swAct); return c;
}
function swRenderExport(stage){
  const L=swApprovedList(scArr(swScope)), w=el("div","swex");
  w.append(el("div","swexh",(swScope.label?swScope.label+"・":"")+"営業許可 "+L.length+" 人（1行1件）"));
  const ta=document.createElement("textarea"); ta.readOnly=true; ta.value=L.join("\n"); ta.rows=Math.min(14,Math.max(4,L.length+1)); ta.setAttribute("aria-label","営業許可リスト"); ta.addEventListener("focus",()=>ta.select());
  if(!L.length) w.append(el("div","calm","まだ許可した人はいません。")); else w.append(ta);
  const r=el("div","swrow2"); const cb=el("button","swgo2","コピーする"); cb.type="button"; cb.disabled=!L.length; cb.onclick=async()=>{ const ok=await copyText(ta.value); toast(ok?L.length+" 件をコピーしました":"コピーできませんでした。欄を選んでコピーしてください"); };
  const bk=el("button","","カードに戻る"); bk.type="button"; bk.onclick=()=>{ swMode="cards"; swRender(); }; r.append(cb,bk); w.append(r); stage.append(w);
}
function swRender(){
  if($("sw").hidden) return;
  swSt.queue=swPrunePure(swSt.queue,scArr(swScope));
  const S=swSummary(swSt), stage=$("swStage"), prog=$("swProg"), bar=$("swBar"), cur=swSt.queue.length, sl=swScope.label?"（"+swScope.label+"）":"";
  stage.textContent=""; prog.textContent=""; bar.textContent=""; swShown=null;
  $("swEx").textContent=swMode==="export"?"カードに戻る":"許可リスト"; $("swTitle").textContent=swMode==="export"?"営業許可リスト"+sl:"スワイプ確認"+sl;
  if(swMode==="export"){ prog.hidden=true; bar.hidden=true; swRenderExport(stage); return; }
  prog.hidden=false;
  const pt=el("div","pt"), mk=(lab,val)=>{ const s=el("span","",lab); s.append(el("b","",String(val))); pt.append(s); };
  if(cur){ const s0=el("span",""); s0.append(el("b","",String(S.pos)), document.createTextNode(" / "+S.total+" 件目")); pt.append(s0); mk("残り ",S.left); } else pt.append(el("span","","確認完了"));
  mk("許可 ",S.ok); mk("除外 ",S.no); prog.append(pt);
  const pb=el("div","pb"), pi=el("i"); pi.style.width=(S.total?Math.round(swSt.hist.length/S.total*100):0)+"%"; pb.append(pi); prog.append(pb);
  if(cur) prog.append(el("div","swhint","左スワイプ／←＝なし　右スワイプ／→＝許可　Z＝戻る"));
  if(!cur){
    bar.hidden=true; const w=el("div","swdone");
    w.append(el("h2","",S.total?"確認が終わりました":"未確認の候補はありません"));
    if(S.total){ w.append(el("div","swsum","営業許可 "+S.ok+" 件・除外 "+S.no+" 件")); w.append(el("div","calm","許可した人は「許可リスト」から1行1件でコピーできます。")); }
    else w.append(el("div","calm","送信待ちの候補は、すべて確認済みか、除外・送信済みです。"));
    const r=el("div","swrow2"); const eb=el("button","swgo2","営業許可リストを出力"); eb.type="button"; eb.onclick=()=>{ swMode="export"; swRender(); };
    const ub=el("button","","1つ戻る"); ub.type="button"; ub.disabled=!swSt.hist.length; ub.onclick=swUndo; const xb=el("button","","閉じる"); xb.type="button"; xb.onclick=swClose; r.append(eb,ub,xb); w.append(r); stage.append(w); return;
  }
  const d=scArr(swScope).find(x=>x.id===swSt.queue[0]); swShown=d.id; stage.append(swCard(d));
  bar.hidden=false;
  const bn=el("button","swno","なし"); bn.type="button"; bn.setAttribute("aria-label","なし（除外リストに入れる）"); bn.onclick=()=>swAct("no");
  const bb=el("button","swback","1つ戻る"); bb.type="button"; bb.disabled=!swSt.hist.length; bb.onclick=swUndo;
  const bo=el("button","swok","営業許可"); bo.type="button"; bo.setAttribute("aria-label","営業許可（送信許可の印を付ける）"); bo.onclick=()=>swAct("ok");
  bar.append(bn,bb,bo);
}
$("swX").onclick=swClose; $("swEx").onclick=()=>{ swMode=swMode==="export"?"cards":"export"; swRender(); };
document.addEventListener("keydown",e=>{
  if($("sw").hidden||!$("swZoom").hidden||e.metaKey||e.ctrlKey||e.altKey) return; const tg=e.target&&e.target.tagName; if(tg==="INPUT"||tg==="TEXTAREA"||tg==="SELECT") return;
  if(e.key==="ArrowLeft"){ e.preventDefault(); swAct("no"); } else if(e.key==="ArrowRight"){ e.preventDefault(); swAct("ok"); }
  else if(e.key==="z"||e.key==="Z"){ e.preventDefault(); swUndo(); } else if(e.key==="Escape"){ swClose(); }
});

/* ====================== サムネイル営業（動画編集と同じ仕組みの別コレクション） ====================== */
const SHAPE_T="sales_thumb_candidates/<ハンドル>（動画編集の sales_candidates と同じ形。別コレクション）\n  handle：@付きハンドル　name：表示名　followers：フォロワー数（数値）　genre：ジャンル\n  reel：リール・投稿の内容メモ　hasPhoto：プロフィール画面あり（実体は sales_photos/thumb~<ID>）\n  link：プロフィールの URL（https のみ。Instagram のハンドルが無い人は YouTube の URL）\n  text：DM文（全文。空なら「DM文 未登録」と出る）　order：並び順\n  status：waiting／sent／replied／meeting／converted／excluded／skipped\n  sentAt・sentFrom・sentBy：送った日時・送信元　approved・approvedAt：スワイプ確認で「営業許可」にした印\n  excludedAt：スワイプの「なし」の時刻　updatedAt：最終更新";
function renderThumb(){
  const box=$("secThumb"); box.textContent=""; if(salesSec!=="thumb") return;
  const L=tdms.filter(d=>d.status!=="excluded").sort(swOrd); const c=el("div","secbox"); c.append(el("h2","","サムネイル営業"));
  c.append(el("div","calm","動画編集の営業（送信待ち・送信済み・除外リスト・スワイプ確認）は「動画編集」にそのまま残っています。ここはサムネイル専用の別の置き場所で、データは別のコレクション（sales_thumb_candidates）に入り、動画編集のデータとは混ざりません。右スワイプ＝営業許可、左スワイプ＝なし（除外リストへ）。ここで決めるのは印だけで、DM などの送信はしません。"));
  const ready=L.filter(d=>d.status==="waiting").length, sent=L.filter(isSentish).length;
  c.append(el("div","dmsum","登録 "+L.length+" 人　未送信 "+ready+"　送信済み "+sent));
  { const un=swEligible(tdms).length, ap=swApprovedList(tdms).length; const er=el("div","row2"); const sb0=el("button","swgo","スワイプ確認を始める（未確認 "+un+" 件）"); sb0.type="button"; sb0.onclick=()=>swOpen("cards",SC_T); const eb0=el("button","","営業許可リスト（"+ap+" 件）を出力"); eb0.type="button"; eb0.onclick=()=>swOpen("export",SC_T); er.append(sb0,eb0); c.append(er); }
  if(!L.length) c.append(el("div","empty","サムネイル用の営業先は、まだ入っていません。"));
  const rows=L.slice(0,30);
  for(const d of rows){
    const r=el("div","trow");
    if(d.hasPhoto===true){ const b=el("button","tsh"); b.type="button"; b.setAttribute("aria-label","プロフィール画面を拡大"); r.append(b); photoOf(SC_T,d).then(src=>{ if(!src){ b.remove(); return; } const im=document.createElement("img"); im.src=src; im.alt=""; im.draggable=false; b.append(im); b.onclick=()=>swZoomOpen(src); }); }
    const tx=el("div","tx"); tx.append(el("b","","@"+hnd(d))); const dn=swFirst(d,["name"]); if(dn) tx.append(el("span","",dn));
    const meta=[]; if(d.followers!=null&&d.followers!=="") meta.push("フォロワー "+swNum(d.followers)); const g=swFirst(d,["genre"]); if(g) meta.push(g); if(d.approved===true) meta.push("営業許可"); if(d.status&&d.status!=="waiting") meta.push(d.status);
    if(meta.length) tx.append(el("span","",meta.join("　")));
    const lk=swLinkOf(d); const a=document.createElement("a"); a.textContent=lk.label; a.href=lk.href; a.target="_blank"; a.rel="noopener"; tx.append(a);
    r.append(tx); c.append(r);
  }
  if(L.length>rows.length) c.append(el("div","calm","ほか "+(L.length-rows.length)+" 人"));
  renderExcludedList(c,tdms,SC_T,"excludedT");
  const dt=document.createElement("details"); keepOpen(dt,"shapeT"); const sm=document.createElement("summary"); sm.textContent="データの形（取り込む人向け）"; dt.append(sm, el("pre","",SHAPE_T)); c.append(dt);
  box.append(c);
}

/* ====================== 募集（Threads・クラウドワークス）：右＝採用／左＝不採用 ====================== */
const SHAPE_R="sales_recruit/<id>\n  kind：threads／crowdworks　title：募集のタイトル　poster：投稿者／発注者\n  category：thumbnail（サムネ）／video（動画編集）。無い・不明は「未分類」\n  format：動画編集のとき short／long／both　price：単価　deadline：締切　summary：募集の要点　url：元の募集ページ（https のみ）\n  order：並び順　status：new（未確認）／adopt（採用）／reject（不採用）　decidedAt：決めた時刻　updatedAt：最終更新";
const rcStat=d=>(d&&d.status)||"new";
const rcCatOf=d=>{ const c=d&&d.category; return c==="thumbnail"||c==="video"?c:"none"; };
const rcFmtOf=d=>{ const f=d&&d.format; return rcCatOf(d)==="video"&&(f==="short"||f==="long"||f==="both")?f:""; };
function rcInScope(d,cat,fmt){
  if(!cat||cat==="all") return true;
  if(rcCatOf(d)!==cat) return false;
  if(cat!=="video"||!fmt||fmt==="all") return true;
  const f=rcFmtOf(d); return f===fmt||f==="both";
}
function rcBadge(d){ const c=rcCatOf(d); if(c==="thumbnail") return "サムネ"; if(c==="none") return "未分類"; const f=rcFmtOf(d); return f==="short"?"動画編集・ショート":f==="long"?"動画編集・長尺":f==="both"?"動画編集・ショート／長尺":"動画編集"; }
function rcEligible(arr,cat,fmt){ return (arr||[]).filter(d=>rcStat(d)==="new"&&rcInScope(d,cat,fmt)).sort(swOrd).map(d=>d.id); }
function rcPrunePure(q,arr){ let i=0; while(i<q.length){ const d=arr.find(x=>x.id===q[i]); if(d&&rcStat(d)==="new") break; i++; } return q.slice(i); }
function rcAdoptList(arr){ return (arr||[]).filter(d=>rcStat(d)==="adopt").sort((x,y)=>ms(x.decidedAt)-ms(y.decidedAt)||swOrd(x,y)); }
const RC_GROUPS=[["thumbnail","【サムネ】"],["video:short","【動画編集（ショート）】"],["video:long","【動画編集（長尺）】"],["video:both","【動画編集（ショート／長尺）】"],["video:","【動画編集（形式不明）】"],["none","【未分類】"]];
const rcGroupKey=d=>{ const c=rcCatOf(d); return c==="video"?"video:"+rcFmtOf(d):c; };
function rcExportText(arr){
  const L=rcAdoptList(arr), out=[];
  for(const [k,h] of RC_GROUPS){ const g=L.filter(d=>rcGroupKey(d)===k); if(!g.length) continue; out.push(h+"\n"+g.map(d=>[d.title||d.id,d.url||""].filter(Boolean).join("　")).join("\n")); }
  return out.join("\n\n");
}
let rcSt2={queue:[],hist:[]}, rcMode="cards", rcBusy=false, rcShown=null; const rcPend={};
let rcFilt={cat:"all",fmt:"all"}, rcScope={cat:"all",fmt:"all"};
const rcScopeLabel=sc=>sc.cat==="all"?"すべて":sc.cat==="thumbnail"?"サムネ":sc.cat==="none"?"未分類":"動画編集"+(sc.fmt==="short"?"・ショート":sc.fmt==="long"?"・長尺":"");
const rcKindLabel=k=>k==="crowdworks"?"クラウドワークス":k==="threads"?"Threads":(k||"募集");
async function rcWrite(id,status){ try{ await db.collection(COLL_RECRUIT).doc(id).update(status==="new"?{status:"new",decidedAt:DEL(),updatedAt:TS()}:{status,decidedAt:TS(),updatedAt:TS()}); return true; }catch(e){ return false; } }
function rcOpen(mode){
  rcScope={cat:rcFilt.cat,fmt:rcFilt.fmt};
  rcSt2={queue:rcEligible(recruit,rcScope.cat,rcScope.fmt),hist:[]}; rcMode=mode||"cards"; rcBusy=false; rcShown=null;
  $("rc").hidden=false; document.body.style.overflow="hidden"; rcRender();
  try{ $("rcX").focus({preventScroll:true}); }catch(e){}
}
function rcClose(){ $("rc").hidden=true; document.body.style.overflow=""; rcBusy=false; render(); }
async function rcAct(kind){
  if(rcBusy||rcMode!=="cards"||$("rc").hidden) return;
  rcSt2.queue=rcPrunePure(rcSt2.queue,recruit);
  if(!rcSt2.queue.length){ rcRender(); return; }
  const id=rcSt2.queue[0];
  if(id!==rcShown){ rcRender(); toast("募集の状態が変わったので、表示を更新しました"); return; }
  rcBusy=true; await flyCard("rcStage",kind);
  rcSt2=swPush(rcSt2,kind); rcBusy=false; rcRender();
  const p=rcWrite(id,kind==="ok"?"adopt":"reject"); rcPend[id]=p;
  const ok=await p;
  if(!ok){
    const i=rcSt2.hist.findIndex(e=>e.id===id);
    if(i>=0){ rcSt2={queue:[id].concat(rcSt2.queue),hist:rcSt2.hist.filter((_,k)=>k!==i)}; }
    toast("保存できませんでした。もう一度振り分けてください"); rcRender();
  }
}
async function rcUndo(){
  if(rcBusy||rcMode!=="cards"||$("rc").hidden||!rcSt2.hist.length) return;
  rcBusy=true; const e=rcSt2.hist[rcSt2.hist.length-1];
  if(rcPend[e.id]){ await rcPend[e.id]; }
  if(rcSt2.hist.indexOf(e)<0){ rcBusy=false; rcRender(); return; }
  const ok=await rcWrite(e.id,"new");
  if(ok) await swWait(()=>{ const c=recruit.find(x=>x.id===e.id); return !!c&&rcStat(c)==="new"; },2500);
  if(ok){ rcSt2=swPop(rcSt2); } else toast("戻せませんでした。もう一度押してください");
  rcBusy=false; rcRender();
}
function rcCard(d){
  const c=el("article","swcard"); c.setAttribute("aria-label",(d.title||d.id)+"");
  const so=el("span","swstamp ok","採用"), sn=el("span","swstamp no","不採用"); c.append(so,sn); c._so=so; c._sn=sn;
  const top=el("div","swtop"); const nm=el("div","swnm");
  nm.append(el("b","",d.poster||"投稿者 未登録")); nm.append(el("span","",rcKindLabel(d.kind))); nm.append(el("span","rcbadge"+(rcCatOf(d)==="none"?" none":""),rcBadge(d))); top.append(nm); c.append(top);
  const pimg=swFirst(d,["profileImage"]);
  if(swImgOk(pimg)) c.append(swShotBtn(pimg));
  if(d.title) c.append(el("div","swtitle",d.title));
  const rows=el("div","swrows"); const row=(k,v)=>{ const r=el("div","swrow"); r.append(el("span","swk",k), el("span",v?"swv":"swv swnone",v||"未登録")); rows.append(r); };
  row("単価",swFirst(d,["price"])); row("締切",swFirst(d,["deadline"])); row("募集の要点",swFirst(d,["summary"])); c.append(rows);
  const u=swFirst(d,["url"]); if(/^https:\/\//i.test(u)){ const a=document.createElement("a"); a.className="swig swlink"; a.textContent="元の募集ページを開く ↗"; a.href=u; a.target="_blank"; a.rel="noopener"; c.append(a); }
  bindSwipe(c,()=>rcBusy,rcAct); return c;
}
function rcRenderExport(stage){
  const L=rcAdoptList(recruit), w=el("div","swex");
  w.append(el("div","swexh","採用（応募候補） "+L.length+" 件"));
  const txt=rcExportText(recruit);
  const ta=document.createElement("textarea"); ta.readOnly=true; ta.value=txt; ta.rows=Math.min(18,Math.max(4,txt.split("\n").length+1)); ta.setAttribute("aria-label","採用リスト"); ta.addEventListener("focus",()=>ta.select());
  if(!L.length) w.append(el("div","calm","まだ採用にした募集はありません。")); else w.append(ta);
  const r=el("div","swrow2"); const cb=el("button","swgo2","コピーする"); cb.type="button"; cb.disabled=!L.length; cb.onclick=async()=>{ const ok=await copyText(ta.value); toast(ok?L.length+" 件をコピーしました":"コピーできませんでした。欄を選んでコピーしてください"); };
  const bk=el("button","","カードに戻る"); bk.type="button"; bk.onclick=()=>{ rcMode="cards"; rcRender(); }; r.append(cb,bk); w.append(r); stage.append(w);
}
function rcRender(){
  if($("rc").hidden) return;
  rcSt2.queue=rcPrunePure(rcSt2.queue,recruit);
  const S=swSummary(rcSt2), stage=$("rcStage"), prog=$("rcProg"), bar=$("rcBar"), cur=rcSt2.queue.length;
  stage.textContent=""; prog.textContent=""; bar.textContent=""; rcShown=null;
  $("rcEx").textContent=rcMode==="export"?"カードに戻る":"採用リスト"; $("rcTitle").textContent=rcMode==="export"?"採用リスト":"募集の確認"+(rcScope.cat==="all"?"":"・"+rcScopeLabel(rcScope));
  if(rcMode==="export"){ prog.hidden=true; bar.hidden=true; rcRenderExport(stage); return; }
  prog.hidden=false;
  const pt=el("div","pt"), mk=(lab,val)=>{ const s=el("span","",lab); s.append(el("b","",String(val))); pt.append(s); };
  if(cur){ const s0=el("span",""); s0.append(el("b","",String(S.pos)), document.createTextNode(" / "+S.total+" 件目")); pt.append(s0); mk("残り ",S.left); } else pt.append(el("span","","確認完了"));
  mk("採用 ",S.ok); mk("不採用 ",S.no); prog.append(pt);
  const pb=el("div","pb"), pi=el("i"); pi.style.width=(S.total?Math.round(rcSt2.hist.length/S.total*100):0)+"%"; pb.append(pi); prog.append(pb);
  if(cur) prog.append(el("div","swhint","左スワイプ／←＝不採用　右スワイプ／→＝採用　Z＝戻る"));
  if(!cur){
    bar.hidden=true; const w=el("div","swdone");
    w.append(el("h2","",S.total?"確認が終わりました":"未確認の募集はありません"));
    if(S.total){ w.append(el("div","swsum","採用 "+S.ok+" 件・不採用 "+S.no+" 件")); w.append(el("div","calm","採用にした募集は「採用リスト」から1行1件でコピーできます。")); }
    else w.append(el("div","calm",rcScope.cat==="all"?"募集のデータが入ると、ここにカードが出ます。":"この範囲（"+rcScopeLabel(rcScope)+"）の未確認の募集はありません。"));
    const r=el("div","swrow2"); const eb=el("button","swgo2","採用リストを出力"); eb.type="button"; eb.onclick=()=>{ rcMode="export"; rcRender(); };
    const ub=el("button","","1つ戻る"); ub.type="button"; ub.disabled=!rcSt2.hist.length; ub.onclick=rcUndo; const xb=el("button","","閉じる"); xb.type="button"; xb.onclick=rcClose; r.append(eb,ub,xb); w.append(r); stage.append(w); return;
  }
  const d=recruit.find(x=>x.id===rcSt2.queue[0]); rcShown=d.id; stage.append(rcCard(d));
  bar.hidden=false;
  const bn=el("button","swno","不採用"); bn.type="button"; bn.setAttribute("aria-label","不採用"); bn.onclick=()=>rcAct("no");
  const bb=el("button","swback","1つ戻る"); bb.type="button"; bb.disabled=!rcSt2.hist.length; bb.onclick=rcUndo;
  const bo=el("button","swok","採用"); bo.type="button"; bo.setAttribute("aria-label","採用（応募候補にする）"); bo.onclick=()=>rcAct("ok");
  bar.append(bn,bb,bo);
}
$("rcX").onclick=rcClose; $("rcEx").onclick=()=>{ rcMode=rcMode==="export"?"cards":"export"; rcRender(); };
document.addEventListener("keydown",e=>{
  if($("rc").hidden||!$("swZoom").hidden||e.metaKey||e.ctrlKey||e.altKey) return; const tg=e.target&&e.target.tagName; if(tg==="INPUT"||tg==="TEXTAREA"||tg==="SELECT") return;
  if(e.key==="ArrowLeft"){ e.preventDefault(); rcAct("no"); } else if(e.key==="ArrowRight"){ e.preventDefault(); rcAct("ok"); }
  else if(e.key==="z"||e.key==="Z"){ e.preventDefault(); rcUndo(); } else if(e.key==="Escape"){ rcClose(); }
});
function renderRecruit(){
  const box=$("secRecruit"); box.textContent=""; if(salesSec!=="recruit") return;
  const L=recruit.slice().sort(swOrd);
  const S=L.filter(d=>rcInScope(d,rcFilt.cat,rcFilt.fmt));
  const nw=rcEligible(recruit,rcFilt.cat,rcFilt.fmt).length, ad=rcAdoptList(S), rj=S.filter(d=>rcStat(d)==="reject"), adAll=rcAdoptList(recruit);
  const lab=rcScopeLabel(rcFilt), scoped=rcFilt.cat!=="all";
  const c=el("div","secbox"); c.append(el("h2","","募集の確認（Threads・クラウドワークス）"));
  c.append(el("div","calm","右スワイプ＝採用（応募候補）、左スワイプ＝不採用。カードから元の募集ページへ飛べます。ここで決めるのは印だけで、応募・返信などの送信はしません。"));
  const mkChips=(arr,cur,cnt,on,cls,aria)=>{ const g=el("div","chips rcc"+(cls?" "+cls:"")); g.setAttribute("role","group"); g.setAttribute("aria-label",aria); for(const [k,lb] of arr){ const b=el("button","chip",lb); b.type="button"; b.append(el("span","c",String(cnt(k)))); b.setAttribute("aria-pressed",String(cur===k)); b.onclick=()=>on(k); g.append(b); } return g; };
  c.append(mkChips([["all","すべて"],["thumbnail","サムネ"],["video","動画編集"],["none","未分類"]],rcFilt.cat,k=>L.filter(d=>rcInScope(d,k,"all")).length,k=>{ rcFilt={cat:k,fmt:k==="video"?rcFilt.fmt:"all"}; renderRecruit(); },"","仕事の種類で絞り込み"));
  if(rcFilt.cat==="video") c.append(mkChips([["all","すべて"],["short","ショート"],["long","長尺"]],rcFilt.fmt,k=>L.filter(d=>rcInScope(d,"video",k)).length,k=>{ rcFilt={cat:"video",fmt:k}; renderRecruit(); },"sub","動画編集の形式で絞り込み"));
  c.append(el("div","dmsum",(scoped?"【"+lab+"】":"")+"登録 "+S.length+" 件　未確認 "+nw+"　採用 "+ad.length+"　不採用 "+rj.length));
  if(!L.length) c.append(el("div","empty","募集のデータは、まだ入っていません。Threads・クラウドワークスの募集を取り込むと、ここからスワイプで確認できます。取り込むときは、サムネ／動画編集（ショート・長尺）で分けて入れます。"));
  else if(!S.length) c.append(el("div","empty","この絞り込み（"+lab+"）の募集は、まだありません。"));
  const er=el("div","row2"); const sb=el("button","swgo","スワイプ確認を始める（"+(scoped?lab+"・":"")+"未確認 "+nw+" 件）"); sb.type="button"; sb.disabled=!nw; sb.onclick=()=>rcOpen("cards");
  const eb=el("button","","採用リスト（全 "+adAll.length+" 件）を出力"); eb.type="button"; eb.onclick=()=>rcOpen("export"); er.append(sb,eb); c.append(er);
  const list=(title,arr,key)=>{ if(!arr.length) return; const dt=document.createElement("details"); keepOpen(dt,key); const sm=document.createElement("summary"); sm.textContent=title+"（"+arr.length+" 件）"; dt.append(sm);
    for(const d of arr){ const r=el("div","rrow"); r.append(el("span","rcbadge"+(rcCatOf(d)==="none"?" none":""),rcBadge(d))); r.append(el("span","rt",rcKindLabel(d.kind)+"　"+(d.title||d.id)+(d.poster?"　"+d.poster:""))); if(/^https:\/\//i.test(d.url||"")){ const a=document.createElement("a"); a.textContent="開く ↗"; a.href=d.url; a.target="_blank"; a.rel="noopener"; r.append(a); }
      const bk=el("button","","未確認に戻す"); bk.type="button"; bk.onclick=async()=>{ const ok=await rcWrite(d.id,"new"); toast(ok?"未確認に戻しました":"戻せませんでした"); }; r.append(bk); dt.append(r); }
    c.append(dt); };
  list("採用",ad,"rcAdopt"); list("不採用",rj,"rcReject");
  const dt=document.createElement("details"); keepOpen(dt,"shapeR"); const sm=document.createElement("summary"); sm.textContent="データの形（取り込む人向け）"; dt.append(sm, el("pre","",SHAPE_R)); c.append(dt);
  box.append(c);
}

/* ====================== 置き場所の切り替えと全体の描画 ====================== */
function renderSalesSec(){
  const box=$("salesSec"); box.textContent="";
  const nT=tdms.filter(d=>d.status==="waiting").length, nR=rcEligible(recruit).length;
  const mk=(key,label,n)=>{ const b=el("button","chip",label); b.type="button"; if(n) b.append(el("span","c",String(n))); b.setAttribute("aria-pressed",String(salesSec===key)); b.onclick=()=>{ salesSec=key; render(); window.scrollTo(0,0); }; box.append(b); };
  mk("video","動画編集",0); mk("thumb","サムネイル",nT); mk("recruit","募集",nR);
  $("secVideo").hidden=salesSec!=="video"; $("secThumb").hidden=salesSec!=="thumb"; $("secRecruit").hidden=salesSec!=="recruit";
}
function render(){
  const ready=dms.filter(d=>d.status==="waiting").length;
  $("nvC").textContent=ready?String(ready):""; document.title=(ready?"("+ready+") ":"")+"共同営業台帳";
  renderSalesSec(); if(salesSec==="video"){ renderGoal(); renderDms(); } renderThumb(); renderRecruit();
}
