require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express      = require("express");
const session      = require("express-session");
const passport     = require("passport");
const GoogleStrat  = require("passport-google-oauth20").Strategy;
const path         = require("path");
const crypto       = require("crypto");
const fs           = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const DATA_DIR    = path.join(__dirname, "..", "data");
const DB_PATH     = path.join(DATA_DIR, "tempo.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Load / create config ──────────────────────────────────────────────────────
let config = { adminPassword: "admin123" };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── JSON "database" ───────────────────────────────────────────────────────────
let db = { users: [], entries: [] };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch {}
}
if (!db.users)   db.users   = [];
if (!db.entries) db.entries = [];

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const newId = () => crypto.randomUUID();

// ── Validate env ──────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL             = process.env.BASE_URL || "https://bvttimetrack.onrender.com";
const SESSION_SECRET       = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("\n❌  Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env\n");
  console.error("   See README.md for setup instructions.\n");
  process.exit(1);
}

// ── Passport / Google OAuth ───────────────────────────────────────────────────
passport.use(new GoogleStrat(
  {
    clientID:     GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL:  `${BASE_URL}/auth/google/callback`,
  },
  (_accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || "";
    const name  = profile.displayName || email;
    const photo = profile.photos?.[0]?.value || null;

    let user = db.users.find(u => u.googleId === profile.id);
    if (!user) {
      user = { id: newId(), googleId: profile.id, email, name, photo, created: Date.now() };
      db.users.push(user);
      saveDB();
    } else {
      // Refresh name/photo in case they changed
      let changed = false;
      if (user.name !== name)   { user.name  = name;  changed = true; }
      if (user.photo !== photo) { user.photo = photo; changed = true; }
      if (changed) saveDB();
    }
    done(null, user);
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.users.find(u => u.id === id);
  done(null, user || false);
});

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));
app.use(express.json());
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?error=auth_failed" }),
  (req, res) => {
    // Send a small page that passes the user back to the opener window (popup flow)
    // or just redirects (redirect flow). We support both.
    const user = { id: req.user.id, email: req.user.email, name: req.user.name, photo: req.user.photo };
    res.send(`<!DOCTYPE html><html><body><script>
      const u = ${JSON.stringify(user)};
      if (window.opener) {
        window.opener.postMessage({ type: "GOOGLE_AUTH_SUCCESS", user: u }, "${BASE_URL}");
        window.close();
      } else {
        localStorage.setItem("tempo_user", JSON.stringify(u));
        window.location.href = "/";
      }
    </script></body></html>`);
  }
);

app.get("/auth/me", (req, res) => {
  if (req.isAuthenticated()) {
    const { id, email, name, photo } = req.user;
    res.json({ id, email, name, photo });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.post("/auth/logout", (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

// ── Admin auth ────────────────────────────────────────────────────────────────
app.post("/api/auth/admin", (req, res) => {
  const { password } = req.body;
  if (password === config.adminPassword) res.json({ ok: true });
  else res.status(401).json({ error: "Wrong password" });
});

// ── Entries: CRUD ─────────────────────────────────────────────────────────────
function requireUser(req, res) {
  // Accept session-based OR uid-in-body (for backward compat)
  if (req.isAuthenticated()) return req.user;
  return null;
}

app.get("/api/entries", (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "uid required" });
  const entries = db.entries
    .filter(e => e.uid === uid)
    .sort((a, b) => new Date(b.start) - new Date(a.start));
  res.json(entries);
});

app.post("/api/entries", (req, res) => {
  const { uid, email, userName, desc, projectId, tags, start, end, duration } = req.body;
  if (!uid || !start || !end || duration == null) return res.status(400).json({ error: "Missing fields" });
  const entry = {
    id: newId(), uid, email: email || "", userName: userName || "",
    desc: desc || "Untitled", projectId: projectId || null,
    tags: tags || [], start, end, duration, created: Date.now(),
  };
  db.entries.push(entry);
  saveDB();
  res.status(201).json(entry);
});

app.patch("/api/entries/:id", (req, res) => {
  const { id } = req.params;
  const { uid, desc, projectId, tags, start, end, duration } = req.body;
  const idx = db.entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  if (db.entries[idx].uid !== uid) return res.status(403).json({ error: "Forbidden" });
  Object.assign(db.entries[idx], {
    ...(desc      !== undefined && { desc }),
    ...(projectId !== undefined && { projectId }),
    ...(tags      !== undefined && { tags }),
    ...(start     !== undefined && { start }),
    ...(end       !== undefined && { end }),
    ...(duration  !== undefined && { duration }),
  });
  saveDB();
  res.json(db.entries[idx]);
});

app.delete("/api/entries/:id", (req, res) => {
  const { id } = req.params;
  const { uid } = req.query;
  const idx = db.entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  if (uid && db.entries[idx].uid !== uid) return res.status(403).json({ error: "Forbidden" });
  db.entries.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// ── Admin: all entries ────────────────────────────────────────────────────────
app.get("/api/admin/entries", (req, res) => {
  const { adminPassword } = req.query;
  if (adminPassword !== config.adminPassword) return res.status(401).json({ error: "Unauthorized" });
  const entries = [...db.entries].sort((a, b) => new Date(b.start) - new Date(a.start));
  const resolved = entries.map(e => {
    const user = db.users.find(u => u.id === e.uid);
    return { ...e, userName: e.userName || user?.name || e.email };
  });
  res.json(resolved);
});

// ── Admin: change password ────────────────────────────────────────────────────
app.post("/api/admin/change-password", (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== config.adminPassword) return res.status(401).json({ error: "Wrong current password" });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: "Password too short" });
  config.adminPassword = newPassword;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n✅ Tempo server running at ${BASE_URL}`);
  console.log(`   Student tracker: ${BASE_URL}/`);
  console.log(`   Admin panel:     ${BASE_URL}/admin.html`);
  console.log(`   Admin password:  ${config.adminPassword}`);
  console.log(`   Data stored at:  ${DB_PATH}\n`);
});
