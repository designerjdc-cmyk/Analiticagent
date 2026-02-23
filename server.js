require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const {
  INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, BASE_URL,
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY,
  PORT = 3000,
} = process.env;

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const IG_GRAPH = "https://graph.instagram.com/v21.0";
const SCOPES = "instagram_business_basic,instagram_business_manage_insights";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const oauthStates = new Map();
function cleanStates() { const n = Date.now(); for (const [k, v] of oauthStates) { if (n - v.ts > 600000) oauthStates.delete(k); } }

async function requireAuth(req, res, next) {
  const t = req.headers.authorization?.replace("Bearer ", "");
  if (!t) return res.status(401).json({ error: "No autenticado" });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(t);
    if (error || !user) return res.status(401).json({ error: "Sesión inválida" });
    req.user = user; next();
  } catch { return res.status(401).json({ error: "Auth error" }); }
}

async function getAccount(userId, id) {
  const { data } = await supabase.from("accounts").select("*").eq("id", id).eq("user_id", userId).single();
  return data || null;
}

// Try multiple IG media endpoints/fields combos, log every failure
async function tryIGMedia(account, limit, fieldsOptions) {
  const eps = [`${IG_GRAPH}/${account.instagram_account_id}/media`, `${IG_GRAPH}/me/media`];
  const errors = [];
  for (const ep of eps) {
    for (const fields of fieldsOptions) {
      try {
        const r = await axios.get(ep, { params: { fields, limit, access_token: account.access_token } });
        console.log(`✅ Media OK: ${ep} → ${(r.data?.data || []).length} items`);
        return { data: r.data, endpoint: ep };
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        errors.push({ ep, err: msg, code: err.response?.data?.error?.code });
        console.warn(`❌ Media fail [${ep}]: ${msg}`);
      }
    }
  }
  console.error("All media attempts failed:", JSON.stringify(errors));
  return { data: { data: [] }, errors };
}

// ── Public ──
app.get("/api/config", (req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// ── OAuth ──
app.get("/auth/instagram", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect("/?error=No+autenticado");
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.redirect("/?error=Sesión+inválida");
    const state = uuidv4();
    oauthStates.set(state, { userId: user.id, ts: Date.now() }); cleanStates();
    res.redirect(`https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&response_type=code&state=${state}`);
  } catch { res.redirect("/?error=Auth+error"); }
});

app.get("/auth/callback", async (req, res) => {
  const { code, error, error_description, state } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  if (!code) return res.redirect("/?error=No+code");
  const od = oauthStates.get(state);
  if (!od) return res.redirect("/?error=Sesión+OAuth+expirada");
  oauthStates.delete(state);
  try {
    const tr = await axios.post(`https://api.instagram.com/oauth/access_token`,
      new URLSearchParams({ client_id: INSTAGRAM_APP_ID, client_secret: INSTAGRAM_APP_SECRET, grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const { access_token: st, user_id: uid } = tr.data;
    const lr = await axios.get(`${IG_GRAPH}/access_token`, { params: { grant_type: "ig_exchange_token", client_secret: INSTAGRAM_APP_SECRET, access_token: st } });
    const lt = lr.data.access_token, exp = lr.data.expires_in;
    const pr = await axios.get(`${IG_GRAPH}/me`, {
      params: { fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count", access_token: lt },
    });
    const p = pr.data, aid = String(p.user_id || uid);
    console.log(`✅ Connected: @${p.username} | ${p.account_type} | followers:${p.followers_count} | media:${p.media_count} | ig_id:${aid}`);
    await supabase.from("accounts").upsert({
      user_id: od.userId, instagram_account_id: aid,
      username: p.username, name: p.name || p.username, account_type: p.account_type,
      profile_picture_url: p.profile_picture_url || null,
      followers_count: p.followers_count || 0, follows_count: p.follows_count || 0, media_count: p.media_count || 0,
      access_token: lt, token_expires_at: Date.now() + exp * 1000, connected_at: new Date().toISOString(),
    }, { onConflict: "user_id,instagram_account_id" });
    res.redirect("/?connected=" + encodeURIComponent(p.username));
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.redirect(`/?error=${encodeURIComponent(err.response?.data?.error_message || err.message)}`);
  }
});

// ── API Routes ──
app.get("/api/accounts", requireAuth, async (req, res) => {
  const { data } = await supabase.from("accounts").select("*").eq("user_id", req.user.id).order("connected_at");
  res.json((data || []).map(({ access_token, ...r }) => ({ ...r, token_valid: r.token_expires_at > Date.now() })));
});

app.delete("/api/accounts/:id", requireAuth, async (req, res) => {
  await supabase.from("accounts").delete().eq("id", req.params.id).eq("user_id", req.user.id);
  res.json({ ok: true });
});

app.get("/api/accounts/:id/profile", requireAuth, async (req, res) => {
  const a = await getAccount(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  try {
    const r = await axios.get(`${IG_GRAPH}/me`, {
      params: { fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography", access_token: a.access_token },
    });
    console.log(`Profile @${r.data.username}: followers=${r.data.followers_count}, media=${r.data.media_count}`);
    await supabase.from("accounts").update({
      username: r.data.username, name: r.data.name || r.data.username, account_type: r.data.account_type,
      profile_picture_url: r.data.profile_picture_url || null,
      followers_count: r.data.followers_count || 0, follows_count: r.data.follows_count || 0, media_count: r.data.media_count || 0,
    }).eq("id", a.id);
    res.json({ ...r.data, id: a.id });
  } catch (err) { handleApiError(err, res); }
});

app.get("/api/accounts/:id/insights", requireAuth, async (req, res) => {
  const a = await getAccount(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  const { period = "day", since, until, metric } = req.query;
  const safe = metric || "reach,views,accounts_engaged";
  const params = { metric: safe, period, access_token: a.access_token };
  if (since) params.since = since;
  if (until) params.until = until;
  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, { params });
    res.json(r.data);
  } catch (err) {
    console.warn("Bulk insights failed:", err.response?.data?.error?.message);
    const ms = safe.split(","), data = [];
    for (const m of ms) {
      try { const r2 = await axios.get(`${IG_GRAPH}/me/insights`, { params: { ...params, metric: m } }); if (r2.data?.data) data.push(...r2.data.data); }
      catch (e) { console.warn(`  "${m}" fail:`, e.response?.data?.error?.message || e.message); }
    }
    if (data.length > 0) return res.json({ data });
    handleApiError(err, res);
  }
});

app.get("/api/accounts/:id/media", requireAuth, async (req, res) => {
  const a = await getAccount(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  const full = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
  const safe = "id,caption,media_type,thumbnail_url,permalink,timestamp,like_count,comments_count";
  const min = "id,caption,media_type,permalink,timestamp,like_count,comments_count";
  const result = await tryIGMedia(a, req.query.limit || 50, [full, safe, min]);
  if (result.errors) return res.json({ data: [], _errors: result.errors });
  res.json(result.data);
});

app.get("/api/accounts/:id/media-detailed", requireAuth, async (req, res) => {
  const a = await getAccount(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const full = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,media_product_type";
  const safe = "id,caption,media_type,thumbnail_url,permalink,timestamp,like_count,comments_count,media_product_type";
  const min = "id,caption,media_type,permalink,timestamp,like_count,comments_count";
  const result = await tryIGMedia(a, limit, [full, safe, min]);
  let items = result.data?.data || [];
  if (!items.length) return res.json({ data: [], followers_count: a.followers_count || 0, _errors: result.errors || null });

  console.log(`Fetching insights for ${items.length} posts...`);
  const BATCH = 5, enriched = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const ps = batch.map(async (item) => {
      const post = { ...item, insights: {} };
      let metrics = "reach,saved,likes,comments,shares,total_interactions";
      if (item.media_type === "VIDEO" || item.media_product_type === "REELS") metrics += ",plays";
      try {
        const r = await axios.get(`${IG_GRAPH}/${item.id}/insights`, { params: { metric: metrics, access_token: a.access_token } });
        if (r.data?.data) for (const m of r.data.data) post.insights[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
      } catch {
        try {
          const r2 = await axios.get(`${IG_GRAPH}/${item.id}/insights`, { params: { metric: "reach,likes,comments,total_interactions", access_token: a.access_token } });
          if (r2.data?.data) for (const m of r2.data.data) post.insights[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
        } catch (e) { console.warn(`  Post ${item.id} insights fail:`, e.response?.data?.error?.message || e.message); }
      }
      return post;
    });
    const results = await Promise.allSettled(ps);
    for (const r of results) if (r.status === "fulfilled") enriched.push(r.value);
  }
  console.log(`✅ Enriched ${enriched.length} posts`);
  res.json({ data: enriched, followers_count: a.followers_count || 0, total_fetched: enriched.length });
});

app.get("/api/accounts/:id/demographics", requireAuth, async (req, res) => {
  const a = await getAccount(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, {
      params: { metric: "engaged_audience_demographics,reached_audience_demographics,follower_demographics", period: "lifetime", metric_type: "total_value", timeframe: "last_30_days", access_token: a.access_token },
    });
    res.json(r.data);
  } catch (err) { console.warn("Demographics fail:", err.response?.data?.error?.message); handleApiError(err, res); }
});

app.post("/api/accounts/:id/refresh-token", requireAuth, async (req, res) => {
  const a = await getAccount(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  try {
    const r = await axios.get(`${IG_GRAPH}/refresh_access_token`, { params: { grant_type: "ig_refresh_token", access_token: a.access_token } });
    await supabase.from("accounts").update({ access_token: r.data.access_token, token_expires_at: Date.now() + r.data.expires_in * 1000 }).eq("id", a.id);
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res); }
});

// Debug
app.get("/api/accounts/:id/debug", requireAuth, async (req, res) => {
  const a = await getAccount(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  const rpt = { ig_id: a.instagram_account_id, username: a.username, token_ok: a.token_expires_at > Date.now(), tests: {} };
  try { const r = await axios.get(`${IG_GRAPH}/me`, { params: { fields: "user_id,username,followers_count,media_count", access_token: a.access_token } }); rpt.tests.profile = { ok: true, data: r.data }; }
  catch (e) { rpt.tests.profile = { ok: false, err: e.response?.data?.error?.message || e.message }; }
  try { const r = await axios.get(`${IG_GRAPH}/${a.instagram_account_id}/media`, { params: { fields: "id,media_type", limit: 3, access_token: a.access_token } }); rpt.tests.media_by_id = { ok: true, count: r.data?.data?.length || 0 }; }
  catch (e) { rpt.tests.media_by_id = { ok: false, err: e.response?.data?.error?.message || e.message }; }
  try { const r = await axios.get(`${IG_GRAPH}/me/media`, { params: { fields: "id,media_type", limit: 3, access_token: a.access_token } }); rpt.tests.media_by_me = { ok: true, count: r.data?.data?.length || 0 }; }
  catch (e) { rpt.tests.media_by_me = { ok: false, err: e.response?.data?.error?.message || e.message }; }
  try { const r = await axios.get(`${IG_GRAPH}/me/insights`, { params: { metric: "reach", period: "day", access_token: a.access_token } }); rpt.tests.insights = { ok: true, points: r.data?.data?.[0]?.values?.length || 0 }; }
  catch (e) { rpt.tests.insights = { ok: false, err: e.response?.data?.error?.message || e.message }; }
  console.log("DEBUG:", JSON.stringify(rpt, null, 2));
  res.json(rpt);
});

app.get("/privacy", (req, res) => { res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px"><h1>Privacidad</h1><p>Solo accedemos a datos de cuentas que conectas voluntariamente. No vendemos datos.</p></body></html>`); });
function handleApiError(err, res) { const e = err.response?.data?.error; res.status(err.response?.status || 500).json({ error: e?.message || err.message, type: e?.type, code: e?.code }); }
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, () => { console.log(`\n🚀 InstaMetrics v3.1 — ${BASE_URL || `http://localhost:${PORT}`}\n📡 ${IG_GRAPH} | Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}\n`); });
