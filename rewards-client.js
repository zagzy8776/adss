(()=>{'use strict';
const wheel=document.getElementById('ppHomeWheel'),btn=document.getElementById('ppHomeSpinBtn'),status=document.getElementById('ppHomeSpinStatus');
if(!wheel||!btn)return;
const panel=document.createElement('section');panel.style.cssText='max-width:680px;margin:18px auto;padding:18px;background:#102c29;color:#f1fff4;border:1px solid #44886d;border-radius:16px';
panel.innerHTML='<h3 style="margin:0 0 12px">Your PayoutPool account</h3><form id="ppAccountForm" style="display:grid;gap:9px"><input type="email" name="email" placeholder="Email" required autocomplete="email" style="padding:12px;border-radius:8px"><input type="password" name="password" placeholder="Password (12+ characters)" required minlength="12" autocomplete="current-password" style="padding:12px;border-radius:8px"><button type="submit" name="action" value="login">Sign in</button><button type="button" id="ppRegister">Create account</button></form><p id="ppAccountState" role="status">Sign in to use secure server-verified spins. The wheel cannot award cash without an active funded campaign.</p><button id="ppLogout" type="button" hidden>Sign out</button><p id="ppWalletStatus">Verified wallet: not signed in</p><p><a href="/admin.html" style="color:#aaf5ce">Operations dashboard</a></p>';
wheel.closest('section').insertAdjacentElement('beforebegin',panel);
const el=id=>document.getElementById(id),message=t=>el('ppAccountState').textContent=t;
let account=null,campaign=null,busy=false,rotation=0;
const api=async(path,method='GET',data)=>{const r=await fetch('/api/'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,cache:'no-store'});const j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j};
const money=b=>b.length?b.map(x=>x.currency+' '+(Number(x.available_minor)/100).toFixed(2)+' available; '+(Number(x.pending_minor)/100).toFixed(2)+' pending').join(' · '):'No verified rewards';
async function refresh(){
 try{
  const me=await api('me');account=me.user;el('ppAccountForm').hidden=true;el('ppLogout').hidden=false;message('Signed in: '+account.email);el('ppWalletStatus').textContent='Wallet: '+money(me.wallet);
  const campaigns=await api('campaigns');campaign=campaigns.campaigns[0]||null;
  const activity=await api('activity');const left=Math.max(0,2-activity.used);
  document.getElementById('ppDailyLeft').textContent=left+' / 2 server-verified spins left today';
  document.getElementById('ppSpinCount').textContent=left+' of 2 server-verified spins remaining';
  document.getElementById('ppVerifiedRewards').textContent=activity.spins.length?activity.spins.slice(0,2).map(x=>x.prize_title||'No prize').join(' · '):'No verified spins yet';
  document.getElementById('ppResultHistory').textContent=activity.spins.length?activity.spins.slice(0,8).map(x=>x.prize_title||'No prize').join(' · '):'No verified spins yet';
  document.getElementById('ppCashResultTotal').textContent=me.wallet.map(x=>x.currency+' '+(Number(x.available_minor)/100).toFixed(2)).join(' · ')||'$0.00';
  btn.disabled=!campaign||left===0;btn.textContent=!campaign?'NO FUNDED CAMPAIGN ACTIVE':left===0?'DAILY SPINS COMPLETE':'✦ '+left+' VERIFIED SPIN'+(left===1?'':'S');
  status.textContent=!campaign?'Real-money spins are unavailable until an administrator verifies funding and publishes campaign rules.':'Spin results are determined securely by the server.';
 }catch(e){account=null;campaign=null;el('ppAccountForm').hidden=false;el('ppLogout').hidden=true;el('ppWalletStatus').textContent='Verified wallet: sign in required';btn.disabled=true;btn.textContent='SIGN IN TO SPIN';status.textContent='Secure spins require an account.';if(!/Sign in required/.test(e.message))message(e.message)}
}
el('ppAccountForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('auth/login','POST',{email:f.get('email'),password:f.get('password')});await refresh()}catch(err){message(err.message)}});
el('ppRegister').addEventListener('click',async()=>{const f=new FormData(el('ppAccountForm'));try{await api('auth/register','POST',{email:f.get('email'),password:f.get('password')});await refresh()}catch(err){message(err.message)}});
el('ppLogout').addEventListener('click',async()=>{try{await api('auth/logout','POST',{})}catch{}await refresh()});
btn.addEventListener('click',async e=>{
 e.preventDefault();e.stopImmediatePropagation();
 if(busy||!account||!campaign)return;
 busy=true;btn.disabled=true;status.textContent='Checking secure spin…';
 try{
  const request_id=crypto.randomUUID();const result=await api('spin','POST',{campaign_id:campaign.id,request_id});
  const names=['$5','Gift','Bonus','$100','Spin','Phone','$20','Points'];
  const index=names.findIndex(n=>n.toLowerCase()===(result.prize_title||'').toLowerCase());
  const seg=index<0?0:index;const current=((rotation%360)+360)%360,desired=(360-seg*45)%360;
  rotation+=1800+((desired-current+360)%360);wheel.style.transform='rotate('+rotation+'deg)';
  status.textContent=result.prize_title?'Server result: '+result.prize_title+' (pending verification where applicable)':'No prize awarded this spin.';
  await new Promise(r=>setTimeout(r,4200));await refresh();
 }catch(err){status.textContent=err.message;await refresh()}finally{busy=false}
},true);
document.querySelectorAll('.pp-note').forEach(x=>{if(x.textContent.includes('saved on this device'))x.textContent='Only server-recorded results are eligible for verification. Displayed prizes are not guaranteed or withdrawable until approved.'});
btn.disabled=true;btn.textContent='CONNECTING SECURE SPINS…';refresh();
})();