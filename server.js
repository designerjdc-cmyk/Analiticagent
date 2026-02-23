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

// Supabase admin client (bypasses RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// OAUTH STATE STORE (in-memory, maps state → userId)
// ============================================================
const oauthStates = new Map();

function cleanOldStates() {
  const now = Date.now();
  for (const [key, val] of oauthStates.entries()) {
    if (now - val.timestamp > 600000) oauthStates.delete(key); // 10 min
  }
}

// ============================================================
// AUTH MIDDLEWARE — verifies Supabase JWT
// ============================================================
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No autenticado" });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Sesión inválida" });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Error de autenticación" });
  }
}

// Helper: get account that belongs to user
async function getUserAccount(userId, accountId) {
  const { data, error } = await supabase
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .eq("user_id", userId)
    .single();

  if (error || !data) return null;
  return data;
}

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================

// Frontend config (public keys only)
app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
  });
});

// ============================================================
// INSTAGRAM OAUTH
// ============================================================

// Step 1: Start Instagram OAuth (user must be logged in)
app.get("/auth/instagram", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect("/?error=No+autenticado");

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.redirect("/?error=Sesión+inválida");

    const state = uuidv4();
    oauthStates.set(state, { userId: user.id, timestamp: Date.now() });
    cleanOldStates();

    const authUrl =
      `https://www.instagram.com/oauth/authorize` +
      `?enable_fb_login=0` +
      `&force_authentication=1` +
      `&client_id=${INSTAGRAM_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&response_type=code` +
      `&state=${state}`;

    console.log("OAuth start for user:", user.id);
    res.redirect(authUrl);
  } catch (err) {
    console.error("OAuth start error:", err.message);
    res.redirect("/?error=Error+de+autenticación");
  }
});

// Step 2: Instagram callback
app.get("/auth/callback", async (req, res) => {
  const { code, error, error_description, state } = req.query;

  if (error) {
    console.error("OAuth error:", error, error_description);
    return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) return res.redirect("/?error=No+se+recibió+código");

  // Validate state
  const oauthData = oauthStates.get(state);
  if (!oauthData) {
    console.error("Invalid or expired OAuth state:", state);
    return res.redirect("/?error=Sesión+OAuth+expirada.+Inténtalo+de+nuevo.");
  }
  oauthStates.delete(state);
  const userId = oauthData.userId;

  try {
    console.log("Exchanging code for token (user:", userId, ")...");

    // Short-lived token
    const tokenRes = await axios.post(
      `https://api.instagram.com/oauth/access_token`,
      new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token: shortToken, user_id: igUserId } = tokenRes.data;

    // Long-lived token
    const longTokenRes = await axios.get(`${IG_GRAPH}/access_token`, {
      params: {
        grant_type: "ig_exchange_token",
        client_secret: INSTAGRAM_APP_SECRET,
        access_token: shortToken,
      },
    });
    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in;

    // Fetch profile
    const profileRes = await axios.get(`${IG_GRAPH}/me`, {
      params: {
        fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",
        access_token: longToken,
      },
    });
    const profile = profileRes.data;
    const igAccountId = String(profile.user_id || igUserId);

    console.log("IG profile:", profile.username, "| type:", profile.account_type, "| saving for user:", userId);

    // Upsert in Supabase
    const { error: dbError } = await supabase.from("accounts").upsert(
      {
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
      },
      { onConflict: "user_id,instagram_account_id" }
    );

    if (dbError) {
      console.error("DB upsert error:", dbError);
      throw new Error(dbError.message);
    }

    console.log("Account saved successfully:", profile.username);
    res.redirect("/?connected=" + encodeURIComponent(profile.username));
  } catch (err) {
    console.error("OAuth callback error:", err.response?.data || err.message);
    const msg = err.response?.data?.error_message || err.response?.data?.error?.message || err.message;
    res.redirect(`/?error=${encodeURIComponent(msg)}`);
  }
});

// ============================================================
// API ROUTES (all require auth)
// ============================================================

// List user's connected accounts
app.get("/api/accounts", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("accounts")
    .select("*")
    .eq("user_id", req.user.id)
    .order("connected_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const safe = (data || []).map(({ access_token, ...rest }) => ({
    ...rest,
    token_valid: rest.token_expires_at > Date.now(),
  }));
  res.json(safe);
});

// Remove account
app.delete("/api/accounts/:id", requireAuth, async (req, res) => {
  const { error } = await supabase
    .from("accounts")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Refresh profile
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

    // Update DB
    await supabase.from("accounts").update({
      username: r.data.username,
      name: r.data.name || r.data.username,
      account_type: r.data.account_type,
      profile_picture_url: r.data.profile_picture_url || null,
      followers_count: r.data.followers_count || 0,
      follows_count: r.data.follows_count || 0,
      media_count: r.data.media_count || 0,
    }).eq("id", account.id);

    res.json({ ...r.data, id: account.id });
  } catch (err) {
    handleApiError(err, res);
  }
});

// Insights
app.get("/api/accounts/:id/insights", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  const { period = "day", since, until, metric } = req.query;
  const safeMetrics = metric || "reach,views,accounts_engaged";

  const params = {
    metric: safeMetrics,
    period,
    access_token: account.access_token,
  };
  if (since) params.since = since;
  if (until) params.until = until;

  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, { params });
    res.json(r.data);
  } catch (err) {
    // Fallback: try each metric individually
    console.warn("Bulk insights failed, trying individually...");
    const metrics = safeMetrics.split(",");
    const data = [];
    for (const m of metrics) {
      try {
        const r2 = await axios.get(`${IG_GRAPH}/me/insights`, {
          params: { ...params, metric: m },
        });
        if (r2.data?.data) data.push(...r2.data.data);
      } catch (e) {
        console.warn(`  metric "${m}" failed:`, e.response?.data?.error?.message || e.message);
      }
    }
    if (data.length > 0) return res.json({ data });
    handleApiError(err, res);
  }
});

// Media
app.get("/api/accounts/:id/media", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  const limit = req.query.limit || 25;
  const fullFields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
  const safeFields = "id,caption,media_type,thumbnail_url,permalink,timestamp,like_count,comments_count";

  const endpoints = [
    `${IG_GRAPH}/${account.instagram_account_id}/media`,
    `${IG_GRAPH}/me/media`,
  ];

  for (const endpoint of endpoints) {
    for (const fields of [fullFields, safeFields]) {
      try {
        const r = await axios.get(endpoint, {
          params: { fields, limit, access_token: account.access_token },
        });
        return res.json(r.data);
      } catch (e) {
        console.warn(`Media failed (${endpoint}):`, e.response?.data?.error?.message || e.message);
      }
    }
  }

  res.json({ data: [] });
});

// Media insights
app.get("/api/accounts/:id/media/:mediaId/insights", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  try {
    const r = await axios.get(`${IG_GRAPH}/${req.params.mediaId}/insights`, {
      params: {
        metric: "reach,views,saves,shares,likes,comments,total_interactions",
        access_token: account.access_token,
      },
    });
    res.json(r.data);
  } catch (err) {
    handleApiError(err, res);
  }
});

// Demographics
app.get("/api/accounts/:id/demographics", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, {
      params: {
        metric: "engaged_audience_demographics,reached_audience_demographics,follower_demographics",
        period: "lifetime",
        metric_type: "total_value",
        timeframe: "last_30_days",
        access_token: account.access_token,
      },
    });
    res.json(r.data);
  } catch (err) {
    handleApiError(err, res);
  }
});

// Refresh IG token
app.post("/api/accounts/:id/refresh-token", requireAuth, async (req, res) => {
  const account = await getUserAccount(req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada" });

  try {
    const r = await axios.get(`${IG_GRAPH}/refresh_access_token`, {
      params: {
        grant_type: "ig_refresh_token",
        access_token: account.access_token,
      },
    });

    await supabase.from("accounts").update({
      access_token: r.data.access_token,
      token_expires_at: Date.now() + r.data.expires_in * 1000,
    }).eq("id", account.id);

    res.json({ ok: true, expires_in: r.data.expires_in });
  } catch (err) {
    handleApiError(err, res);
  }
});

// ============================================================
// Privacy
// ============================================================
app.get("/privacy", (req, res) => {
  res.send(`
    <!DOCTYPE html><html lang="es">
    <head><meta charset="UTF-8"><title>Política de Privacidad - InstaMetrics</title>
    <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;color:#333;line-height:1.6;}</style></head>
    <body>
      <h1>Política de Privacidad</h1>
      <p>InstaMetrics es una herramienta de analítica personal para cuentas de Instagram.</p>
      <h2>Datos que recopilamos</h2>
      <p>Solo accedemos a los datos de las cuentas de Instagram que conectas voluntariamente.</p>
      <h2>Cómo usamos los datos</h2>
      <p>Los datos se usan exclusivamente para mostrarte tus métricas. No compartimos ni vendemos datos.</p>
      <h2>Almacenamiento</h2>
      <p>Tus credenciales se almacenan de forma segura. Puedes eliminar tu cuenta en cualquier momento.</p>
      <h2>Contacto</h2>
      <p>Para consultas sobre privacidad, contacta al administrador.</p>
    </body></html>
  `);
});

// ============================================================
// HELPERS
// ============================================================
function handleApiError(err, res) {
  console.error("IG API error:", err.response?.data || err.message);
  const igError = err.response?.data?.error;
  res.status(err.response?.status || 500).json({
    error: igError?.message || err.message,
    type: igError?.type,
    code: igError?.code,
  });
}

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 InstaMetrics v2 running at ${BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`📡 Graph API: ${IG_GRAPH}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL ? "Connected" : "NOT CONFIGURED"}`);
  console.log(`🔑 IG App: ${INSTAGRAM_APP_ID ? INSTAGRAM_APP_ID.slice(0, 6) + "..." : "NOT SET"}\n`);
});
