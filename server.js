require("dotenv").config();
const express=require("express"),axios=require("axios"),{v4:uuidv4}=require("uuid"),{createClient}=require("@supabase/supabase-js"),path=require("path");
const app=express();app.use(express.json());app.use(express.static("public"));
const{INSTAGRAM_APP_ID,INSTAGRAM_APP_SECRET,BASE_URL,SUPABASE_URL,SUPABASE_SERVICE_KEY,SUPABASE_ANON_KEY,PORT=3000}=process.env;
const REDIRECT_URI=`${BASE_URL}/auth/callback`,IG=`https://graph.instagram.com/v21.0`,SCOPES="instagram_business_basic,instagram_business_manage_insights";
const supa=createClient(SUPABASE_URL,SUPABASE_SERVICE_KEY);
const oauthStates=new Map();function cleanS(){const n=Date.now();for(const[k,v]of oauthStates)if(n-v.ts>600000)oauthStates.delete(k)}

// Safe snapshot — NEVER throws, NEVER crashes
async function saveSnapshot(accountId, data) {
  if (!accountId) return;
  try {
    await supa.from("snapshots").upsert({
      account_id: accountId,
      followers_count: data.followers_count || 0,
      follows_count: data.follows_count || 0,
      media_count: data.media_count || 0,
      avg_engagement: data.avg_engagement || 0,
      avg_reach: data.avg_reach || 0,
      total_likes: data.total_likes || 0,
      total_comments: data.total_comments || 0,
      snapshot_date: new Date().toISOString().slice(0, 10)
    }, { onConflict: "account_id,snapshot_date" });
    console.log("📸 Snapshot OK");
  } catch (e) {
    console.warn("📸 Snapshot skip:", e.message);
  }
}

async function auth(req,res,next){const t=req.headers.authorization?.replace("Bearer ","");if(!t)return res.status(401).json({error:"No auth"});try{const{data:{user},error}=await supa.auth.getUser(t);if(error||!user)return res.status(401).json({error:"Bad session"});req.user=user;next()}catch{res.status(401).json({error:"Auth error"})}}
async function getAcc(uid,id){const{data}=await supa.from("accounts").select("*").eq("id",id).eq("user_id",uid).single();return data||null}

async function tryMedia(a,limit,fieldsList){
  const eps=[`${IG}/${a.instagram_account_id}/media`,`${IG}/me/media`],errs=[];
  for(const ep of eps)for(const f of fieldsList){try{const r=await axios.get(ep,{params:{fields:f,limit,access_token:a.access_token}});console.log(`✅ Media: ${(r.data?.data||[]).length}`);return{data:r.data}}catch(e){errs.push(e.response?.data?.error?.message||e.message);console.warn(`❌ Media: ${errs[errs.length-1]}`)}}
  return{data:{data:[]},errs}
}

function handleErr(e,r){const x=e.response?.data?.error;console.error("API Error:",x?.message||e.message);r.status(e.response?.status||500).json({error:x?.message||e.message,type:x?.type,code:x?.code})}

app.get("/api/config",(_,r)=>r.json({supabaseUrl:SUPABASE_URL,supabaseAnonKey:SUPABASE_ANON_KEY}));

// OAuth
app.get("/auth/instagram",async(req,res)=>{const t=req.query.token;if(!t)return res.redirect("/?error=No+auth");try{const{data:{user},error}=await supa.auth.getUser(t);if(error||!user)return res.redirect("/?error=Bad+session");const s=uuidv4();oauthStates.set(s,{userId:user.id,ts:Date.now()});cleanS();res.redirect(`https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&response_type=code&state=${s}`)}catch{res.redirect("/?error=Auth+error")}});

app.get("/auth/callback",async(req,res)=>{const{code,error,error_description,state}=req.query;if(error)return res.redirect(`/?error=${encodeURIComponent(error_description||error)}`);if(!code)return res.redirect("/?error=No+code");const od=oauthStates.get(state);if(!od)return res.redirect("/?error=Expired");oauthStates.delete(state);
  try{const tr=await axios.post("https://api.instagram.com/oauth/access_token",new URLSearchParams({client_id:INSTAGRAM_APP_ID,client_secret:INSTAGRAM_APP_SECRET,grant_type:"authorization_code",redirect_uri:REDIRECT_URI,code}),{headers:{"Content-Type":"application/x-www-form-urlencoded"}});
  const{access_token:st,user_id:uid}=tr.data;const lr=await axios.get(`${IG}/access_token`,{params:{grant_type:"ig_exchange_token",client_secret:INSTAGRAM_APP_SECRET,access_token:st}});const lt=lr.data.access_token,exp=lr.data.expires_in;
  const pr=await axios.get(`${IG}/me`,{params:{fields:"user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",access_token:lt}});const p=pr.data,aid=String(p.user_id||uid);
  console.log(`✅ @${p.username} | ${p.account_type} | f:${p.followers_count}`);
  await supa.from("accounts").upsert({user_id:od.userId,instagram_account_id:aid,username:p.username,name:p.name||p.username,account_type:p.account_type,profile_picture_url:p.profile_picture_url||null,followers_count:p.followers_count||0,follows_count:p.follows_count||0,media_count:p.media_count||0,access_token:lt,token_expires_at:Date.now()+exp*1000,connected_at:new Date().toISOString()},{onConflict:"user_id,instagram_account_id"});
  // Safe snapshot after account is saved
  try{const{data:accRow}=await supa.from("accounts").select("id").eq("user_id",od.userId).eq("instagram_account_id",aid).single();if(accRow?.id)saveSnapshot(accRow.id,{followers_count:p.followers_count,follows_count:p.follows_count,media_count:p.media_count})}catch(se){console.warn("Snapshot skip:",se.message)}
  res.redirect("/?connected="+encodeURIComponent(p.username))}catch(e){console.error("OAuth:",e.response?.data||e.message);res.redirect(`/?error=${encodeURIComponent(e.response?.data?.error_message||e.message)}`)}});

// Accounts
app.get("/api/accounts",auth,async(req,res)=>{try{const{data}=await supa.from("accounts").select("*").eq("user_id",req.user.id).order("connected_at");res.json((data||[]).map(({access_token,...r})=>({...r,token_valid:r.token_expires_at>Date.now()})))}catch(e){handleErr(e,res)}});
app.delete("/api/accounts/:id",auth,async(req,res)=>{try{await supa.from("accounts").delete().eq("id",req.params.id).eq("user_id",req.user.id);res.json({ok:true})}catch(e){handleErr(e,res)}});

// Profile
app.get("/api/accounts/:id/profile",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.status(404).json({error:"Not found"});
  const r=await axios.get(`${IG}/me`,{params:{fields:"user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography",access_token:a.access_token}});
  await supa.from("accounts").update({username:r.data.username,name:r.data.name||r.data.username,account_type:r.data.account_type,profile_picture_url:r.data.profile_picture_url||null,followers_count:r.data.followers_count||0,follows_count:r.data.follows_count||0,media_count:r.data.media_count||0}).eq("id",a.id);
  saveSnapshot(a.id,{followers_count:r.data.followers_count,follows_count:r.data.follows_count,media_count:r.data.media_count});
  res.json({...r.data,id:a.id})}catch(e){handleErr(e,res)}});

// Insights
app.get("/api/accounts/:id/insights",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.status(404).json({error:"Not found"});
  const{period="day",since,until,metric}=req.query;const safe=metric||"reach,views,accounts_engaged";const p={metric:safe,period,access_token:a.access_token};if(since)p.since=since;if(until)p.until=until;
  try{const r=await axios.get(`${IG}/me/insights`,{params:p});res.json(r.data)}catch(e){const ms=safe.split(","),d=[];for(const m of ms){try{const r2=await axios.get(`${IG}/me/insights`,{params:{...p,metric:m}});if(r2.data?.data)d.push(...r2.data.data)}catch{}}if(d.length)return res.json({data:d});handleErr(e,res)}}catch(e){handleErr(e,res)}});

// Media
app.get("/api/accounts/:id/media",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.status(404).json({error:"Not found"});
  const r=await tryMedia(a,req.query.limit||50,["id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count","id,caption,media_type,thumbnail_url,permalink,timestamp,like_count,comments_count","id,caption,media_type,permalink,timestamp,like_count,comments_count"]);res.json(r.data)}catch(e){handleErr(e,res)}});

// Media Detailed
app.get("/api/accounts/:id/media-detailed",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.status(404).json({error:"Not found"});
  const limit=Math.min(parseInt(req.query.limit)||50,100);
  const r=await tryMedia(a,limit,["id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,media_product_type","id,caption,media_type,thumbnail_url,permalink,timestamp,like_count,comments_count,media_product_type","id,caption,media_type,permalink,timestamp,like_count,comments_count"]);
  let items=r.data?.data||[];if(!items.length)return res.json({data:[],followers_count:a.followers_count||0});
  console.log(`Enriching ${items.length} posts...`);const B=5,enriched=[];
  for(let i=0;i<items.length;i+=B){const batch=items.slice(i,i+B);const ps=batch.map(async item=>{const post={...item,insights:{}};let m="reach,saved,likes,comments,shares,total_interactions";if(item.media_type==="VIDEO"||item.media_product_type==="REELS")m+=",plays";
    try{const r=await axios.get(`${IG}/${item.id}/insights`,{params:{metric:m,access_token:a.access_token}});if(r.data?.data)for(const x of r.data.data)post.insights[x.name]=x.values?.[0]?.value??x.total_value?.value??0}
    catch{try{const r2=await axios.get(`${IG}/${item.id}/insights`,{params:{metric:"reach,likes,comments,total_interactions",access_token:a.access_token}});if(r2.data?.data)for(const x of r2.data.data)post.insights[x.name]=x.values?.[0]?.value??x.total_value?.value??0}catch(e){console.warn(`Post ${item.id}:`,e.response?.data?.error?.message||e.message)}}
    return post});const results=await Promise.allSettled(ps);for(const x of results)if(x.status==="fulfilled")enriched.push(x.value)}
  const totalLikes=enriched.reduce((s,p)=>s+(p.like_count||0),0);const totalComments=enriched.reduce((s,p)=>s+(p.comments_count||0),0);
  const avgEng=a.followers_count?((totalLikes+totalComments)/Math.max(enriched.length,1)/a.followers_count*100):0;
  const avgReach=enriched.reduce((s,p)=>s+(p.insights?.reach||0),0)/Math.max(enriched.length,1);
  saveSnapshot(a.id,{followers_count:a.followers_count,follows_count:a.follows_count,media_count:a.media_count,avg_engagement:avgEng,avg_reach:avgReach,total_likes:totalLikes,total_comments:totalComments});
  console.log(`✅ ${enriched.length} posts enriched`);res.json({data:enriched,followers_count:a.followers_count||0,total_fetched:enriched.length})}catch(e){handleErr(e,res)}});

// Demographics
app.get("/api/accounts/:id/demographics",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.status(404).json({error:"Not found"});
  const r=await axios.get(`${IG}/me/insights`,{params:{metric:"engaged_audience_demographics,reached_audience_demographics,follower_demographics",period:"lifetime",metric_type:"total_value",timeframe:"last_30_days",access_token:a.access_token}});res.json(r.data)}catch(e){handleErr(e,res)}});

// Business Discovery — public data from any business/creator account
app.get("/api/accounts/:id/discover/:username",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.status(404).json({error:"Not found"});
  const target=req.params.username.replace("@","").trim();if(!target)return res.status(400).json({error:"Username required"});
  const mediaFields="id,caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink";
  const userFields=`username,name,biography,profile_picture_url,followers_count,follows_count,media_count,media.limit(25){${mediaFields}}`;
  try{
    const r=await axios.get(`${IG}/me`,{params:{fields:`business_discovery.fields(${userFields})`,username:target,access_token:a.access_token}});
    const bd=r.data?.business_discovery;if(!bd)return res.status(404).json({error:"No data returned"});
    res.json(bd);
  }catch(e){
    const msg=e.response?.data?.error?.message||e.message;console.warn("Discovery:",msg);
    let userMsg="Error al buscar esta cuenta";
    if(msg.includes("not exist")||msg.includes("does not exist"))userMsg="Cuenta no encontrada. Debe ser pública y de tipo business/creator";
    else if(msg.includes("private"))userMsg="Esta cuenta es privada";
    else if(msg.includes("rate"))userMsg="Demasiadas búsquedas. Espera unos minutos";
    res.status(e.response?.status||404).json({error:userMsg});
  }
}catch(e){handleErr(e,res)}});

// Token refresh
app.post("/api/accounts/:id/refresh-token",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.status(404).json({error:"Not found"});
  const r=await axios.get(`${IG}/refresh_access_token`,{params:{grant_type:"ig_refresh_token",access_token:a.access_token}});await supa.from("accounts").update({access_token:r.data.access_token,token_expires_at:Date.now()+r.data.expires_in*1000}).eq("id",a.id);res.json({ok:true})}catch(e){handleErr(e,res)}});

// Snapshots — returns empty array on any error, never crashes
app.get("/api/accounts/:id/snapshots",auth,async(req,res)=>{try{const a=await getAcc(req.user.id,req.params.id);if(!a)return res.json([]);
  const limit=parseInt(req.query.limit)||90;const{data,error}=await supa.from("snapshots").select("*").eq("account_id",a.id).order("snapshot_date",{ascending:true}).limit(limit);
  if(error){console.warn("Snapshots err:",error.message);return res.json([])}res.json(data||[])}catch(e){console.warn("Snapshots err:",e.message);res.json([])}});

app.get("/privacy",(_,r)=>r.send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px"><h1>Privacidad</h1><p>Solo accedemos a datos de cuentas que conectas. No vendemos datos.</p></body></html>'));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

// Prevent crashes
process.on("unhandledRejection",(err)=>{console.error("Unhandled:",err)});
process.on("uncaughtException",(err)=>{console.error("Uncaught:",err)});

app.listen(PORT,()=>console.log(`\n🚀 InstaMetrics v5 — ${BASE_URL||`http://localhost:${PORT}`}\n`));
