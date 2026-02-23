require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ============================================================
// CONFIG
// ============================================================
const {
  INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET,
  BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_ANON_KEY,
  PORT = 3000,
} = process.env;

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const IG_GRAPH = "https://graph.instagram.com/v21.0";
const SCOPES = "instagram_business_basic,instagram_business_manage_insights";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// OAUTH STATE STORE
// ============================================================
const oauthStates = new Map();
function cleanOldStates() {
  const now = Date.now();
  for (const [key, val] of oauthStates.entries()) {
    if (now - val.timestamp > 600000) oauthStates.delete(key);
  }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No autenticado" });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Sesión inválida" });
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: "Error de autenticación" }); }
}

async function getUserAccount(userId, accountId) {
  const { data } = await supabase.from("accounts").select("*")
    .eq("id", accountId).eq("user_id", userId).single();
  return data || null;
}

// ============================================================
// PUBLIC
// ============================================================
app.get("/api/config", (req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// ============================================================
// INSTAGRAM OAUTH
// ============================================================
app.get("/auth/instagram", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect("/?error=No+autenticado");
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.redirect("/?error=Sesión+inválida");
    const state = uuidv4();
    oauthStates.set(state, { userId: user.id, timestamp: Date.now() });
    cleanOldStates();
    const authUrl = `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&response_type=code&state=${state}`;
    res.redirect(authUrl);
  } catch (err) {
    res.redirect("/?error=Error+de+autenticación");
  }
});

app.get("/auth/callback", async (req, res) => {
  const { code, error, error_description, state } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  if (!code) return res.redirect("/?error=No+se+recibió+código");

  const oauthData = oauthStates.get(state);
  if (!oauthData) return res.redirect("/?error=Sesión+OAuth+expirada");
  oauthStates.delete(state);
  const userId = oauthData.userId;

  try {
    const tokenRes = await axios.post(`https://api.instagram.com/oauth/access_token`,
      new URLSearchParams({
        client_id: INSTAGRAM_APP_ID, client_secret: INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code,
      }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

    const { access_token: shortToken, user_id: igUserId } = tokenRes.data;

    const longTokenRes = await axios.get(`${IG_GRAPH}/access_token`, {
      params: { grant_type: "ig_exchange_token", client_secret: INSTAGRAM_APP_SECRET, access_token: shortToken },
    });
    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in;

    const profileRes = await axios.get(`${IG_GRAPH}/me`, {
      params: {
        fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",
        access_token: longToken,
      },
    });
    const profile = profileRes.data;
    const igAccountId = String(profile.user_id || igUserId);

    console.log("IG connected:", profile.username, "| followers:", profile.followers_count, "| media:", profile.media_count);

    await supabase.from("accounts").upsert({
      user_id: userId,
      instagram_account_id: igAccountId,
      username: profile.username,
      name: profile.name || profile.username,
      account_type: profile.account_type,
      profile_picture_url: profile.profile_picture_url || null,
      followers_count: profile.followers_count || 0,
      follows_count: profile.follows_count || 0,
      media_count: profile.media_count || 0,
      access_token: longToken,
      token_expires_at: Date.now() + expiresIn * 1000,
      connected_at: new Date().toISOString(),
    }, { onConflict: "user_id,instagram_account_id" });

    res.redirect("/?connected=" + encodeURIComponent(profile.username));
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    const msg = err.response?.data?.error_message || err.response?.data?.error?.message || err.message;
    res.redirect(`/?error=${encodeURIComponent(msg)}`);
  }
});

// ============================================================
// API ROUTES
// ============================================================

app.get("/api/accounts", requireAuth, async (req, res) => {
  const { data } = await supabase.from("accounts").select("*")
    .eq("user_id", req.user.id).order("connected_at", { ascending: true });
  const safe = (data || []).map(({ access_token, ...rest }) => ({
    ...rest, token_valid: rest.token_expires_at > Date.now(),
  }));
  res.json(safe);
});

app.delete("/api/accounts/:id", requireAuth, async (req, res) => {
  await supabase.from("accounts").delete().eq("id", req.params.id).eq("user_id", req.user.id);
  res.json({ ok: true });
});

// Refresh profile from IG
app.get("/api/accounts/:id/profile", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });
  try {
    const r = await axios.get(`${IG_GRAPH}/me`, {
      params: {
        fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography",
        access_token: account.access_token,
      },
    });
    await supabase.from("accounts").update({
      username: r.data.username, name: r.data.name || r.data.username,
      account_type: r.data.account_type, profile_picture_url: r.data.profile_picture_url || null,
      followers_count: r.data.followers_count || 0, follows_count: r.data.follows_count || 0,
      media_count: r.data.media_count || 0,
    }).eq("id", account.id);
    res.json({ ...r.data, id: account.id });
  } catch (err) { handleApiError(err, res); }
});

// Insights
app.get("/api/accounts/:id/insights", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  const { period = "day", since, until, metric } = req.query;
  const safeMetrics = metric || "reach,views,accounts_engaged";
  const params = { metric: safeMetrics, period, access_token: account.access_token };
  if (since) params.since = since;
  if (until) params.until = until;

  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, { params });
    res.json(r.data);
  } catch (err) {
    // Fallback per-metric
    const metrics = safeMetrics.split(",");
    const data = [];
    for (const m of metrics) {
      try {
        const r2 = await axios.get(`${IG_GRAPH}/me/insights`, { params: { ...params, metric: m } });
        if (r2.data?.data) data.push(...r2.data.data);
      } catch {}
    }
    if (data.length > 0) return res.json({ data });
    handleApiError(err, res);
  }
});

// Basic media list
app.get("/api/accounts/:id/media", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  const limit = req.query.limit || 50;
  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";

  const endpoints = [`${IG_GRAPH}/${account.instagram_account_id}/media`, `${IG_GRAPH}/me/media`];
  for (const ep of endpoints) {
    try {
      const r = await axios.get(ep, { params: { fields, limit, access_token: account.access_token } });
      return res.json(r.data);
    } catch {}
  }
  res.json({ data: [] });
});

// ★ DETAILED MEDIA — fetches each post's individual insights
app.get("/api/accounts/:id/media-detailed", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,media_product_type";

  // Fetch media list
  let mediaItems = [];
  const endpoints = [`${IG_GRAPH}/${account.instagram_account_id}/media`, `${IG_GRAPH}/me/media`];
  for (const ep of endpoints) {
    try {
      const r = await axios.get(ep, { params: { fields, limit, access_token: account.access_token } });
      mediaItems = r.data?.data || [];
      break;
    } catch {}
  }

  if (mediaItems.length === 0) return res.json({ data: [], followers_count: account.followers_count || 0 });

  // Fetch insights for each post (in parallel, batched)
  const BATCH_SIZE = 5;
  const enriched = [];

  for (let i = 0; i < mediaItems.length; i += BATCH_SIZE) {
    const batch = mediaItems.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (item) => {
      const post = { ...item, insights: {} };

      // Different metrics for different media types
      // CAROUSEL_ALBUM and IMAGE: reach,saved,likes,comments,shares,total_interactions
      // VIDEO/REEL: reach,saved,likes,comments,shares,total_interactions,views (plays)
      let metricList = "reach,saved,likes,comments,shares,total_interactions";
      if (item.media_type === "VIDEO" || item.media_product_type === "REELS") {
        metricList += ",plays";
      }

      try {
        const r = await axios.get(`${IG_GRAPH}/${item.id}/insights`, {
          params: { metric: metricList, access_token: account.access_token },
        });
        if (r.data?.data) {
          for (const m of r.data.data) {
            post.insights[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
          }
        }
      } catch (err) {
        // Try with fewer metrics on failure
        try {
          const r2 = await axios.get(`${IG_GRAPH}/${item.id}/insights`, {
            params: { metric: "reach,likes,comments,total_interactions", access_token: account.access_token },
          });
          if (r2.data?.data) {
            for (const m of r2.data.data) {
              post.insights[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
            }
          }
        } catch {}
      }

      return post;
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === "fulfilled") enriched.push(r.value);
    }
  }

  res.json({
    data: enriched,
    followers_count: account.followers_count || 0,
    total_fetched: enriched.length,
  });
});

// Demographics
app.get("/api/accounts/:id/demographics", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });
  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, {
      params: {
        metric: "engaged_audience_demographics,reached_audience_demographics,follower_demographics",
        period: "lifetime", metric_type: "total_value", timeframe: "last_30_days",
        access_token: account.access_token,
      },
    });
    res.json(r.data);
  } catch (err) { handleApiError(err, res); }
});

// Refresh token
app.post("/api/accounts/:id/refresh-token", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });
  try {
    const r = await axios.get(`${IG_GRAPH}/refresh_access_token`, {
      params: { grant_type: "ig_refresh_token", access_token: account.access_token },
    });
    await supabase.from("accounts").update({
      access_token: r.data.access_token, token_expires_at: Date.now() + r.data.expires_in * 1000,
    }).eq("id", account.id);
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res); }
});

// ============================================================
// Privacy
// ============================================================
app.get("/privacy", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Privacidad</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;color:#333;line-height:1.6;}</style></head>
  <body><h1>Política de Privacidad</h1><p>InstaMetrics accede solo a los datos de las cuentas que conectas voluntariamente. No compartimos ni vendemos datos.</p></body></html>`);
});

// ============================================================
function handleApiError(err, res) {
  const igError = err.response?.data?.error;
  res.status(err.response?.status || 500).json({
    error: igError?.message || err.message, type: igError?.type, code: igError?.code,
  });
}

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => {
  console.log(`\n🚀 InstaMetrics v3 — ${BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`📡 IG Graph: ${IG_GRAPH} | Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}\n`);
});
