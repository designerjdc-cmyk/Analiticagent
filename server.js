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

// FIX: Always use a versioned API endpoint
const IG_GRAPH = "https://graph.instagram.com/v21.0";

// Scopes for Instagram Business Login
const SCOPES = "instagram_business_basic,instagram_business_manage_insights";

// ============================================================
// AUTH ROUTES
// ============================================================

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

    // Short-lived token (no version prefix on this endpoint)
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

    // Long-lived token (60 days)
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

    // Profile
    const profileRes = await axios.get(`${IG_GRAPH}/me`, {
      params: {
        fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",
        access_token: longToken,
      },
    });

    const profile = profileRes.data;
    const accountId = String(profile.user_id || user_id);

    console.log("Profile fetched:", profile.username, "| type:", profile.account_type, "| id:", accountId);
    console.log("Raw profile response keys:", Object.keys(profile));

    // Save account — always store id as string
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

// List connected accounts (without tokens)
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

// Remove account
app.delete("/api/accounts/:id", (req, res) => {
  const accounts = loadAccounts();
  delete accounts[req.params.id];
  saveAccounts(accounts);
  res.json({ ok: true });
});

// Profile (refreshed)
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

    console.log("Profile refresh raw keys:", Object.keys(r.data), "| user_id:", r.data.user_id, "| id:", r.data.id);

    // Merge but ALWAYS keep our stored id
    accounts[req.params.id] = {
      ...account,
      ...r.data,
      id: account.id,
    };
    saveAccounts(accounts);

    // FIX: Send response with our stored id, not whatever Instagram returns
    // This prevents the frontend from getting a mismatched id
    const safeResponse = { ...r.data, id: account.id };
    res.json(safeResponse);
  } catch (err) {
    handleApiError(err, res);
  }
});

// Insights (Creator-safe)
app.get("/api/accounts/:id/insights", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

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
    console.warn("Bulk insights failed, trying individual metrics...");
    const metrics = safeMetrics.split(",");
    const data = [];

    for (const m of metrics) {
      try {
        const r2 = await axios.get(`${IG_GRAPH}/me/insights`, {
          params: { ...params, metric: m },
        });
        if (r2.data && r2.data.data) data.push(...r2.data.data);
      } catch (innerErr) {
        console.warn(`  metric "${m}" failed:`, innerErr.response?.data?.error?.message || innerErr.message);
      }
    }

    if (data.length > 0) {
      return res.json({ data });
    }
    handleApiError(err, res);
  }
});

// Media with fallback cascade
app.get("/api/accounts/:id/media", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Account not found" });

  const limit = req.query.limit || 25;
  const fullFields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
  const safeFields = "id,caption,media_type,thumbnail_url,permalink,timestamp,like_count,comments_count";

  const endpoints = [
    `${IG_GRAPH}/${account.id}/media`,
    `${IG_GRAPH}/me/media`,
  ];

  for (const endpoint of endpoints) {
    for (const fields of [fullFields, safeFields]) {
      try {
        const r = await axios.get(endpoint, {
          params: { fields, limit, access_token: account.access_token },
        });
        console.log(`Media OK via ${endpoint} (${(r.data && r.data.data && r.data.data.length) || 0} items)`);
        return res.json(r.data);
      } catch (innerErr) {
        console.warn(`Media failed (${endpoint}):`, innerErr.response?.data?.error?.message || innerErr.message);
      }
    }
  }

  console.error("All media fetch attempts failed for account", account.id);
  res.json({ data: [] });
});

// Media insights
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

// Demographics
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
    accounts[req.params.id].token_expires_at = Date.now() + r.data.expires_in * 1000;
    saveAccounts(accounts);
    res.json({ ok: true, expires_in: r.data.expires_in });
  } catch (err) {
    handleApiError(err, res);
  }
});

// ============================================================
// DEBUG ENDPOINT — hit /api/debug/:id to diagnose all calls
// ============================================================
app.get("/api/debug/:id", async (req, res) => {
  const accounts = loadAccounts();
  const account = accounts[req.params.id];

  const report = {
    timestamp: new Date().toISOString(),
    graph_base: IG_GRAPH,
    account_found: !!account,
    stored_id: req.params.id,
    stored_id_type: typeof req.params.id,
    tests: {},
  };

  if (!account) {
    report.all_stored_ids = Object.keys(accounts);
    report.all_stored_id_types = Object.keys(accounts).map(k => typeof k);
    return res.json(report);
  }

  report.stored_account = {
    id: account.id,
    id_type: typeof account.id,
    username: account.username,
    account_type: account.account_type,
    token_prefix: account.access_token ? account.access_token.slice(0, 20) + "..." : "MISSING",
    token_expires_at: account.token_expires_at,
    token_valid: account.token_expires_at > Date.now(),
    days_until_expiry: Math.floor((account.token_expires_at - Date.now()) / 86400000),
  };

  // Test 1: /me (profile)
  try {
    const r = await axios.get(`${IG_GRAPH}/me`, {
      params: {
        fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",
        access_token: account.access_token,
      },
    });
    report.tests.profile = {
      status: "OK",
      response_keys: Object.keys(r.data),
      response_id: r.data.id,
      response_id_type: typeof r.data.id,
      response_user_id: r.data.user_id,
      response_user_id_type: typeof r.data.user_id,
      id_matches_stored: String(r.data.user_id) === String(account.id),
      username: r.data.username,
      account_type: r.data.account_type,
      followers: r.data.followers_count,
      media_count: r.data.media_count,
    };
  } catch (err) {
    report.tests.profile = {
      status: "FAILED",
      error: err.response?.data?.error || err.message,
      http_status: err.response?.status,
    };
  }

  // Test 2: /me/insights (bulk)
  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, {
      params: {
        metric: "reach,views,accounts_engaged",
        period: "day",
        access_token: account.access_token,
      },
    });
    report.tests.insights_bulk = {
      status: "OK",
      metrics_returned: (r.data.data || []).map(m => m.name),
      data_points: (r.data.data || []).map(m => ({
        name: m.name,
        values_count: m.values ? m.values.length : 0,
      })),
    };
  } catch (err) {
    report.tests.insights_bulk = {
      status: "FAILED",
      error: err.response?.data?.error || err.message,
      http_status: err.response?.status,
    };
  }

  // Test 3: individual metrics
  for (const metric of ["reach", "views", "accounts_engaged", "follows_and_unfollows", "profile_views"]) {
    try {
      const r = await axios.get(`${IG_GRAPH}/me/insights`, {
        params: { metric, period: "day", access_token: account.access_token },
      });
      report.tests["metric_" + metric] = {
        status: "OK",
        values_count: r.data.data && r.data.data[0] ? r.data.data[0].values.length : 0,
      };
    } catch (err) {
      report.tests["metric_" + metric] = {
        status: "FAILED",
        error: err.response?.data?.error?.message || err.message,
        error_code: err.response?.data?.error?.code,
      };
    }
  }

  // Test 4: media via /{id}/media
  try {
    const r = await axios.get(`${IG_GRAPH}/${account.id}/media`, {
      params: {
        fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count",
        limit: 5,
        access_token: account.access_token,
      },
    });
    report.tests.media_by_id = {
      status: "OK",
      count: r.data.data ? r.data.data.length : 0,
      endpoint: `${IG_GRAPH}/${account.id}/media`,
      sample: r.data.data ? r.data.data.slice(0, 2).map(m => ({
        id: m.id, type: m.media_type, likes: m.like_count,
      })) : [],
    };
  } catch (err) {
    report.tests.media_by_id = {
      status: "FAILED",
      endpoint: `${IG_GRAPH}/${account.id}/media`,
      error: err.response?.data?.error?.message || err.message,
      error_code: err.response?.data?.error?.code,
    };
  }

  // Test 5: media via /me/media
  try {
    const r = await axios.get(`${IG_GRAPH}/me/media`, {
      params: {
        fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count",
        limit: 5,
        access_token: account.access_token,
      },
    });
    report.tests.media_by_me = {
      status: "OK",
      count: r.data.data ? r.data.data.length : 0,
      endpoint: `${IG_GRAPH}/me/media`,
      sample: r.data.data ? r.data.data.slice(0, 2).map(m => ({
        id: m.id, type: m.media_type, likes: m.like_count,
      })) : [],
    };
  } catch (err) {
    report.tests.media_by_me = {
      status: "FAILED",
      endpoint: `${IG_GRAPH}/me/media`,
      error: err.response?.data?.error?.message || err.message,
      error_code: err.response?.data?.error?.code,
    };
  }

  // Test 6: demographics
  try {
    const r = await axios.get(`${IG_GRAPH}/me/insights`, {
      params: {
        metric: "follower_demographics",
        period: "lifetime",
        metric_type: "total_value",
        timeframe: "last_30_days",
        access_token: account.access_token,
      },
    });
    report.tests.demographics = { status: "OK" };
  } catch (err) {
    report.tests.demographics = {
      status: "FAILED",
      error: err.response?.data?.error?.message || err.message,
    };
  }

  // Summary
  const testResults = Object.values(report.tests);
  report.summary = {
    total: testResults.length,
    passed: testResults.filter(t => t.status === "OK").length,
    failed: testResults.filter(t => t.status === "FAILED").length,
  };

  console.log("\n========== DEBUG REPORT ==========");
  console.log(JSON.stringify(report, null, 2));
  console.log("==================================\n");

  res.json(report);
});

// ============================================================
// DEBUG: List raw stored data (without token)
// ============================================================
app.get("/api/debug-accounts", (req, res) => {
  const accounts = loadAccounts();
  const report = {};
  for (const [key, val] of Object.entries(accounts)) {
    report[key] = {
      storage_key: key,
      storage_key_type: typeof key,
      id: val.id,
      id_type: typeof val.id,
      id_matches_key: key === String(val.id),
      username: val.username,
      account_type: val.account_type,
      token_valid: val.token_expires_at > Date.now(),
      connected_at: val.connected_at,
    };
  }
  res.json(report);
});

// ============================================================
// Privacy
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
      <p>Solo accedemos a los datos de las cuentas de Instagram que conectas voluntariamente.</p>
      <h2>Cómo usamos los datos</h2>
      <p>Los datos se usan exclusivamente para mostrarte tus métricas. No compartimos ni vendemos datos.</p>
      <h2>Almacenamiento</h2>
      <p>Los tokens se almacenan de forma segura. Puedes desconectar tu cuenta en cualquier momento.</p>
      <h2>Contacto</h2>
      <p>Para consultas sobre privacidad, contacta al administrador de esta instancia.</p>
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

// SPA fallback
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
  console.log(`📡 Graph API: ${IG_GRAPH}`);
  console.log(`🔑 App ID: ${INSTAGRAM_APP_ID ? INSTAGRAM_APP_ID.slice(0, 6) + "..." : "NOT SET"}`);
  console.log(`🐛 Debug: ${BASE_URL || `http://localhost:${PORT}`}/api/debug-accounts\n`);

  if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) {
    console.warn("⚠️  Missing INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET in .env\n");
  }
});
