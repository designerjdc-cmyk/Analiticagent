require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ============================================================
// DATA STORAGE (JSON file - swap for a DB in production)
// ============================================================
const DATA_FILE = path.join(__dirname, "data", "accounts.json");

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "{}");
}

function loadAccounts() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveAccounts(accounts) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2));
}

// ============================================================
// CONFIG
// ============================================================
const {
  INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET,
  BASE_URL,
  PORT = 3000,
} = process.env;

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const IG_GRAPH = "https://graph.instagram.com";

// Scopes for Instagram Business Login
const SCOPES = "instagram_business_basic,instagram_business_manage_insights";

// ============================================================
// AUTH ROUTES
// ============================================================

// Step 1: Redirect user to Instagram OAuth
// IMPORTANT: Uses www.instagram.com (NOT api.instagram.com)
// and enable_fb_login=0 for standalone Instagram Business Login
app.get("/auth/login", (req, res) => {
  const state = uuidv4();
  const authUrl =
    `https://www.instagram.com/oauth/authorize` +
    `?enable_fb_login=0` +
    `&force_authentication=1` +
    `&client_id=${INSTAGRAM_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&response_type=code` +
    `&state=${state}`;

  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback
app.get("/auth/callback", async (req, res) => {
  const { code, error, error_description, error_reason } = req.query;

  if (error) {
    console.error("OAuth error:", error, error_description, error_reason);
    return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect("/?error=No+authorization+code+received");
  }

  try {
    console.log("Exchanging code for token...");

    // Exchange code for short-lived token
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

    console.log("Short-lived token obtained");

    const { access_token: shortToken, user_id } = tokenRes.data;

    // Exchange for long-lived token (60 days)
    const longTokenRes = await axios.get(`${IG_GRAPH}/access_token`, {
      params: {
        grant_type: "ig_exchange_token",
        client_secret: INSTAGRAM_APP_SECRET,
        access_token: shortToken,
      },
    });

    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in;

    console.log("Long-lived token obtained, fetching profile...");

    // Fetch basic profile info
    const profileRes = await axios.get(`${IG_GRAPH}/me`, {
      params: {
        fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",
        access_token: longToken,
      },
    });

    const profile = profileRes.data;
    const accountId = profile.user_id || user_id;

    console.log("Profile fetched:", profile.username);

    // Save account
    const accounts = loadAccounts();
    accounts[accountId] = {
      id: accountId,
      username: profile.username,
      name: profile.name || profile.username,
      account_type: profile.account_type,
      profile_picture_url: profile.profile_picture_url || null,
      followers_count: profile.followers_count,
      follows_count: profile.follows_count,
      media_count: profile.media_count,
      access_token: longToken,
      token_expires_at: Date.now() + expiresIn * 1000,
      connected_at: new Date().toISOString(),
    };
    saveAccounts(accounts);

    res.redirect("/?connected=" + encodeURIComponent(profile.username));
  } catch (err) {
    console.error("OAuth token exchange error:", err.response?.data || err.message);
    const msg = err.response?.data?.error_message || err.response?.data?.error?.message || err.message;
    res.redirect(`/?error=${encodeURIComponent(msg)}`);
  }
});

// ============================================================
// API ROUTES
// ============================================================

// List all connected accounts (without exposing tokens)
app.get("/api/accounts", (req, res) => {
  const accounts = loadAccounts();
  const safe = Object.values(accounts).map(
    ({ access_token, ...rest }) => ({
      ...rest,
      token_valid: rest.token_expires_at > Date.now(),
    })
  );
  res.json(safe);
});

// Remove an account
app.delete("/api/accounts/:id", (req, res) => {
  const accounts = loadAccounts();
  delete accounts[req.params.id];
  saveAccounts(accounts);
  res.json({ ok: true });
});

// Get profile data (refreshed)
app.get("/api/accounts/:id/profile", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

  try {
    const r = await axios.get(`${IG_GRAPH}/me`, {
      params: {
        fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography",
        access_token: account.access_token,
      },
    });

    accounts[req.params.id] = {
      ...account,
      ...r.data,
      id: account.id,
    };
    saveAccounts(accounts);

    res.json(r.data);
  } catch (err) {
    handleApiError(err, res);
  }
});

// Get account insights
app.get("/api/accounts/:id/insights", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

  const { period = "day", since, until } = req.query;

  const params = {
    metric: "reach,views,accounts_engaged,follows_and_unfollows,profile_views",
    period,
    access_token: account.access_token,
  };

  if (since) params.since = since;
  if (until) params.until = until;

  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, { params });
    res.json(r.data);
  } catch (err) {
    handleApiError(err, res);
  }
});

// Get recent media with metrics
app.get("/api/accounts/:id/media", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

  const limit = req.query.limit || 25;

  try {
    const r = await axios.get(`${IG_GRAPH}/me/media`, {
      params: {
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
        limit,
        access_token: account.access_token,
      },
    });
    res.json(r.data);
  } catch (err) {
    handleApiError(err, res);
  }
});

// Get insights for a specific media item
app.get("/api/accounts/:id/media/:mediaId/insights", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

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

// Get audience demographics
app.get("/api/accounts/:id/demographics", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

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

// Refresh token
app.post("/api/accounts/:id/refresh-token", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

  try {
    const r = await axios.get(`${IG_GRAPH}/refresh_access_token`, {
      params: {
        grant_type: "ig_refresh_token",
        access_token: account.access_token,
      },
    });

    accounts[req.params.id].access_token = r.data.access_token;
    accounts[req.params.id].token_expires_at =
      Date.now() + r.data.expires_in * 1000;
    saveAccounts(accounts);

    res.json({ ok: true, expires_in: r.data.expires_in });
  } catch (err) {
    handleApiError(err, res);
  }
});

// ============================================================
// Privacy policy page (required by Meta)
// ============================================================
app.get("/privacy", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>Política de Privacidad - InstaMetrics</title>
    <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;color:#333;line-height:1.6;}</style></head>
    <body>
      <h1>Política de Privacidad</h1>
      <p>InstaMetrics es una herramienta de analítica personal para cuentas de Instagram.</p>
      <h2>Datos que recopilamos</h2>
      <p>Solo accedemos a los datos de las cuentas de Instagram que conectas voluntariamente: métricas públicas, publicaciones y datos de audiencia proporcionados por la API de Instagram.</p>
      <h2>Cómo usamos los datos</h2>
      <p>Los datos se usan exclusivamente para mostrarte tus métricas en el dashboard. No compartimos, vendemos ni transferimos tus datos a terceros.</p>
      <h2>Almacenamiento</h2>
      <p>Los tokens de acceso se almacenan de forma segura en el servidor. Puedes desconectar tu cuenta en cualquier momento.</p>
      <h2>Contacto</h2>
      <p>Para cualquier consulta sobre privacidad, contacta al administrador de esta instancia.</p>
    </body></html>
  `);
});

// ============================================================
// HELPERS
// ============================================================
function handleApiError(err, res) {
  console.error("Instagram API error:", err.response?.data || err.message);
  const igError = err.response?.data?.error;
  res.status(err.response?.status || 500).json({
    error: igError?.message || err.message,
    type: igError?.type,
    code: igError?.code,
  });
}

// ============================================================
// SERVE FRONTEND (SPA fallback)
// ============================================================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 InstaMetrics running at ${BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`📊 Dashboard: ${BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`🔗 OAuth callback: ${REDIRECT_URI}`);
  console.log(`🔑 App ID: ${INSTAGRAM_APP_ID ? INSTAGRAM_APP_ID.slice(0, 6) + "..." : "NOT SET"}\n`);

  if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) {
    console.warn("⚠️  Missing INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET in .env");
    console.warn("   The app will run but OAuth login won't work.\n");
  }
});
