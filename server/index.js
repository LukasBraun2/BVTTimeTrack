require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express     = require("express");
const session     = require("express-session");
const passport    = require("passport");
const GoogleStrat = require("passport-google-oauth20").Strategy;
const path        = require("path");
const crypto      = require("crypto");
const fs          = require("fs");
const Database    = require("better-sqlite3");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const DATA_DIR    = path.join(__dirname, "..", "data");
const DB_PATH     = path.join(DATA_DIR, "tempo.db");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── App-wide constants ────────────────────────────────────────────────────────
const PROJECTS = {
  academy:   { name: "Academy",   color: "#818CF8", cls: "academy"  },
  volunteer: { name: "Volunteer", color: "#22C97A", cls: "volunteer" },
  module5:   { name: "Module 5",  color: "#F5A623", cls: "module5"  },
};

const TAGS = [
  "Class Attendance", "Coding", "freecodecamp", "general study time",
  "HTML and CSS Tutorial", "interview prep", "JS tutorials", "Khan Academy",
  "online lecture", "Outlining / Wireframes", "WIX assignment",
];

// ── Load / create config (admin password only — not user data) ────────────────
let config = { adminPassword: "admin123" };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── SQLite database ───────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email     TEXT NOT NULL,
    name      TEXT NOT NULL,
    photo     TEXT,
    created   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entries (
    id         TEXT PRIMARY KEY,
    uid        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    desc       TEXT NOT NULL DEFAULT 'Untitled',
    project_id TEXT,
    tags       TEXT NOT NULL DEFAULT '[]',
    start      TEXT NOT NULL,
    end        TEXT NOT NULL,
    duration   INTEGER NOT NULL,
    created    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_uid       ON entries(uid);
  CREATE INDEX IF NOT EXISTS idx_entries_start     ON entries(start);
  CREATE INDEX IF NOT EXISTS idx_entries_uid_start ON entries(uid, start);
`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmt = {
  // users
  findUserByGoogleId: db.prepare("SELECT * FROM users WHERE google_id = ?"),
  findUserById:       db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser:         db.prepare(
    "INSERT INTO users (id, google_id, email, name, photo, created) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  updateUser: db.prepare("UPDATE users SET name = ?, photo = ? WHERE id = ?"),

  // entries
  entriesByUid: db.prepare(
    "SELECT * FROM entries WHERE uid = ? ORDER BY start DESC"
  ),
  entryById:    db.prepare("SELECT * FROM entries WHERE id = ?"),
  insertEntry:  db.prepare(
    `INSERT INTO entries (id, uid, desc, project_id, tags, start, end, duration, created)
     VALUES (@id, @uid, @desc, @project_id, @tags, @start, @end, @duration, @created)`
  ),
  updateEntry: db.prepare(
    `UPDATE entries
     SET desc = @desc, project_id = @project_id, tags = @tags,
         start = @start, end = @end, duration = @duration
     WHERE id = @id AND uid = @uid`
  ),
  deleteEntry: db.prepare("DELETE FROM entries WHERE id = ? AND uid = ?"),

  // admin stats
  allEntries:     db.prepare("SELECT * FROM entries ORDER BY start DESC"),
  weekEntries:    db.prepare("SELECT * FROM entries WHERE start >= ?"),
  allUsers:       db.prepare("SELECT * FROM users"),
  countEntries:   db.prepare("SELECT COUNT(*) AS n FROM entries"),
};

// ── Row helpers ───────────────────────────────────────────────────────────────
// SQLite stores tags as a JSON string; parse on the way out.
function parseEntry(row) {
  if (!row) return null;
  return { ...row, tags: JSON.parse(row.tags || "[]"), projectId: row.project_id };
}

const newId = () => crypto.randomUUID();

// ── Validate env ──────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL             = process.env.BASE_URL || "https://bvttimetrack.onrender.com";
const SESSION_SECRET       = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("\n❌  Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env\n");
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

    let user = stmt.findUserByGoogleId.get(profile.id);
    if (!user) {
      const id = newId();
      stmt.insertUser.run(id, profile.id, email, name, photo, Date.now());
      user = stmt.findUserById.get(id);
    } else if (user.name !== name || user.photo !== photo) {
      stmt.updateUser.run(name, photo, user.id);
      user = stmt.findUserById.get(user.id);
    }
    done(null, user);
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = stmt.findUserById.get(id);
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

// ── Middleware ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Shared config ─────────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({ projects: PROJECTS, tags: TAGS });
});

app.get("/api/config/ui", (_req, res) => {
  res.json({
    projects: Object.entries(PROJECTS).map(([id, p]) => ({ id, name: p.name, color: p.color })),
    tags: TAGS,
  });
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?error=auth_failed" }),
  (_req, res) => {
    res.send(`<!DOCTYPE html><html><body><script>
(function(){
  if(window.opener){
    window.opener.postMessage({type:"GOOGLE_AUTH_SUCCESS"},"${BASE_URL}");
    window.close();
  }else{
    window.location.href="/";
  }
})();
</script></body></html>`);
  }
);

app.get("/auth/me", (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  const { id, email, name, photo } = req.user;
  res.json({ id, email, name, photo });
});

app.post("/auth/logout", (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

// ── Admin auth ────────────────────────────────────────────────────────────────
app.post("/api/auth/admin", (req, res) => {
  const { password } = req.body;
  if (password !== config.adminPassword)
    return res.status(401).json({ error: "Wrong password" });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post("/api/auth/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

app.get("/api/auth/admin/check", (req, res) => {
  res.json({ ok: !!req.session.isAdmin });
});

// ── Formatting helpers ────────────────────────────────────────────────────────
const fmtSec   = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`; };
const fmtShort = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };
const fmtTime  = d => new Date(d).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fmtDate  = d => {
  const today = new Date(), yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dd = new Date(d);
  if (dd.toDateString() === today.toDateString())     return "Today";
  if (dd.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dd.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};

// ── Entries: list (grouped + formatted for tracker view) ─────────────────────
app.get("/api/entries/list", requireAuth, (req, res) => {
  const rows    = stmt.entriesByUid.all(req.user.id).map(parseEntry);
  const dayMap  = {};

  rows.forEach(e => {
    const label = fmtDate(e.start);
    if (!dayMap[label]) dayMap[label] = [];
    const p = e.projectId ? PROJECTS[e.projectId] : null;
    dayMap[label].push({
      ...e,
      startFormatted:    fmtTime(e.start),
      endFormatted:      fmtTime(e.end),
      durationFormatted: fmtSec(e.duration),
      projectName:       p?.name  || null,
      projectColor:      p?.color || null,
    });
  });

  const days = Object.entries(dayMap).map(([label, dayEntries]) => {
    const groupMap = {};
    dayEntries.forEach(e => {
      const k = (e.desc || "Untitled") + "||" + (e.projectId || "");
      if (!groupMap[k]) groupMap[k] = [];
      groupMap[k].push(e);
    });
    const groups = Object.entries(groupMap).map(([key, ge]) => ({
      key,
      hasMultiple:   ge.length > 1,
      totalFormatted: fmtSec(ge.reduce((s, e) => s + e.duration, 0)),
      entries:        ge,
    }));
    return {
      label,
      entryCount:    dayEntries.length,
      totalFormatted: fmtShort(dayEntries.reduce((s, e) => s + e.duration, 0)),
      groups,
    };
  });

  res.json(days);
});

// ── Entries: stats (topbar today/week counts) ─────────────────────────────────
app.get("/api/entries/stats", requireAuth, (req, res) => {
  const now  = new Date();
  const ws   = new Date(now);
  ws.setDate(now.getDate() - now.getDay());
  ws.setHours(0, 0, 0, 0);

  const todayStr = now.toDateString();

  // Two focused queries instead of pulling all rows into JS
  const todaySeconds = db.prepare(
    "SELECT COALESCE(SUM(duration),0) AS n FROM entries WHERE uid = ? AND start >= ?"
  ).get(req.user.id, new Date(todayStr).toISOString()).n;

  const weekSeconds = db.prepare(
    "SELECT COALESCE(SUM(duration),0) AS n FROM entries WHERE uid = ? AND start >= ?"
  ).get(req.user.id, ws.toISOString()).n;

  res.json({ todaySeconds, weekSeconds });
});

// ── Entries: reports (aggregated breakdown for reports view) ──────────────────
app.get("/api/entries/reports", requireAuth, (req, res) => {
  const rows  = stmt.entriesByUid.all(req.user.id).map(parseEntry);
  const total = rows.reduce((s, e) => s + e.duration, 0);
  const uniqueDays = new Set(rows.map(e => new Date(e.start).toDateString())).size;

  const byProj = Object.entries(PROJECTS).map(([id, p]) => {
    const pe = rows.filter(e => e.projectId === id);
    return { id, ...p, total: pe.reduce((s, e) => s + e.duration, 0), count: pe.length };
  }).filter(p => p.total > 0).sort((a, b) => b.total - a.total);

  const grand = byProj.reduce((s, p) => s + p.total, 0);

  res.json({
    totalFormatted:    fmtSec(total),
    entryCount:        rows.length,
    activeProjects:    byProj.length,
    avgDailyFormatted: fmtShort(Math.round(total / Math.max(1, uniqueDays))),
    grandFormatted:    fmtSec(grand),
    projects: byProj.map(p => ({
      ...p,
      totalFormatted: fmtSec(p.total),
      pct: grand > 0 ? Math.round(p.total / grand * 100) : 0,
    })),
  });
});

// ── Entries: raw list (used by admin CSV export) ──────────────────────────────
app.get("/api/entries", requireAuth, (req, res) => {
  res.json(stmt.entriesByUid.all(req.user.id).map(parseEntry));
});

// ── Entries: create ───────────────────────────────────────────────────────────
app.post("/api/entries", requireAuth, (req, res) => {
  const { desc, projectId, tags, start, end, duration } = req.body;
  if (!start || !end || duration == null)
    return res.status(400).json({ error: "Missing fields" });

  const id = newId();
  stmt.insertEntry.run({
    id,
    uid:        req.user.id,
    desc:       desc || "Untitled",
    project_id: projectId || null,
    tags:       JSON.stringify(tags || []),
    start,
    end,
    duration,
    created:    Date.now(),
  });

  res.status(201).json(parseEntry(stmt.entryById.get(id)));
});

// ── Entries: update ───────────────────────────────────────────────────────────
app.patch("/api/entries/:id", requireAuth, (req, res) => {
  const existing = stmt.entryById.get(req.params.id);
  if (!existing)              return res.status(404).json({ error: "Not found" });
  if (existing.uid !== req.user.id) return res.status(403).json({ error: "Forbidden" });

  const { desc, projectId, tags, start, end, duration } = req.body;

  // Merge: only overwrite fields that were actually sent
  stmt.updateEntry.run({
    id:         req.params.id,
    uid:        req.user.id,
    desc:       desc       !== undefined ? desc       : existing.desc,
    project_id: projectId  !== undefined ? projectId  : existing.project_id,
    tags:       tags       !== undefined ? JSON.stringify(tags) : existing.tags,
    start:      start      !== undefined ? start      : existing.start,
    end:        end        !== undefined ? end        : existing.end,
    duration:   duration   !== undefined ? duration   : existing.duration,
  });

  res.json(parseEntry(stmt.entryById.get(req.params.id)));
});

// ── Entries: delete ───────────────────────────────────────────────────────────
app.delete("/api/entries/:id", requireAuth, (req, res) => {
  const existing = stmt.entryById.get(req.params.id);
  if (!existing)              return res.status(404).json({ error: "Not found" });
  if (existing.uid !== req.user.id) return res.status(403).json({ error: "Forbidden" });
  stmt.deleteEntry.run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Admin: aggregated stats ───────────────────────────────────────────────────
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const ws = weekStart();

  const { weekSecs } = db.prepare(
    "SELECT COALESCE(SUM(duration),0) AS weekSecs FROM entries WHERE start >= ?"
  ).get(ws.toISOString());

  const { totalEntries } = db.prepare(
    "SELECT COUNT(*) AS totalEntries FROM entries"
  ).get();

  const { totalStudents } = db.prepare(
    "SELECT COUNT(DISTINCT uid) AS totalStudents FROM entries"
  ).get();

  const { weekStudents } = db.prepare(
    "SELECT COUNT(DISTINCT uid) AS weekStudents FROM entries WHERE start >= ?"
  ).get(ws.toISOString());

  const avgSecs = weekStudents > 0 ? Math.round(weekSecs / weekStudents) : 0;

  res.json({
    totalStudents,
    weekSeconds:      weekSecs,
    weekFormatted:    fmtSec(weekSecs),
    totalEntries,
    avgWeekSeconds:   avgSecs,
    avgWeekFormatted: fmtShort(avgSecs),
  });
});

// ── Admin: students view ──────────────────────────────────────────────────────
app.get("/api/admin/students", requireAdmin, (req, res) => {
  const { project = "", period = "week", search = "" } = req.query;
  const ws = weekStart();

  // Single query: all users who have entries, with their entries attached.
  // Entries come back as one flat list; we group by uid in JS below.
  const allUsers   = db.prepare("SELECT DISTINCT u.* FROM users u JOIN entries e ON e.uid = u.id").all();
  const allEntries = db.prepare("SELECT * FROM entries ORDER BY start DESC").all().map(parseEntry);

  // Group entries by uid for O(1) lookup
  const entriesByUid = {};
  for (const e of allEntries) {
    (entriesByUid[e.uid] = entriesByUid[e.uid] || []).push(e);
  }

  // Text search
  let users = allUsers;
  if (search) {
    const q = search.toLowerCase();
    users = users.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }

  // Project filter: keep only users who have at least one entry in that project
  if (project) {
    users = users.filter(u => (entriesByUid[u.id] || []).some(e => e.projectId === project));
  }

  const students = users.map(u => {
    const allRows = entriesByUid[u.id] || [];

    // Filtered entry list (period + project)
    let filtered = allRows;
    if (period === "week") filtered = filtered.filter(e => new Date(e.start) >= ws);
    if (project)           filtered = filtered.filter(e => e.projectId === project);

    const weekRows = allRows.filter(e => new Date(e.start) >= ws);

    // Project breakdown (respects period + project filters)
    const projTotals = {};
    allRows
      .filter(e => e.projectId && (!project || e.projectId === project))
      .filter(e => period !== "week" || new Date(e.start) >= ws)
      .forEach(e => { projTotals[e.projectId] = (projTotals[e.projectId] || 0) + e.duration; });

    const projBreakdown = Object.entries(projTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([id, secs]) => {
        const p = PROJECTS[id] || {};
        return { id, name: p.name || id, color: p.color || "#888", cls: p.cls || "", formatted: fmtShort(secs) };
      });

    const totalSeconds = filtered.reduce((s, e) => s + e.duration, 0);
    const weekSeconds  = weekRows.reduce((s, e) => s + e.duration, 0);

    return {
      uid:            u.id,
      displayName:    u.name,
      avatarColor:    avatarColor(u.email),
      initials:       avatarInitials(u.name),
      photo:          u.photo,
      totalSeconds,
      totalFormatted: fmtSec(totalSeconds),
      weekSeconds,
      totalEntries:   filtered.length,
      projBreakdown,
    };
  });

  students.sort((a, b) => b.weekSeconds - a.weekSeconds);
  res.json(students);
});

// ── Admin: entries for one student (loaded on expand) ────────────────────────
app.get("/api/admin/students/:uid/entries", requireAdmin, (req, res) => {
  const { project = "", period = "week" } = req.query;
  const ws = weekStart();

  const user = stmt.findUserById.get(req.params.uid);
  if (!user) return res.status(404).json({ error: "User not found" });

  let filtered = db.prepare("SELECT * FROM entries WHERE uid = ? ORDER BY start DESC")
    .all(req.params.uid).map(parseEntry);

  if (period === "week") filtered = filtered.filter(e => new Date(e.start) >= ws);
  if (project)           filtered = filtered.filter(e => e.projectId === project);

  const entries = filtered.slice(0, 50).map(e => ({
    id:                e.id,
    desc:              e.desc,
    tags:              e.tags,
    projectId:         e.projectId,
    duration:          e.duration,
    dateShort:         new Date(e.start).toLocaleDateString([], { month: "short", day: "numeric" }),
    startFormatted:    fmtTime(e.start),
    endFormatted:      fmtTime(e.end),
    durationFormatted: fmtSec(e.duration),
    projectName:       e.projectId ? PROJECTS[e.projectId]?.name  : null,
    projectColor:      e.projectId ? PROJECTS[e.projectId]?.color : null,
  }));

  res.json({ entries, totalEntries: filtered.length });
});

// ── Admin: all raw entries (CSV export) ───────────────────────────────────────
app.get("/api/admin/entries", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, u.name AS user_name, u.email AS user_email
    FROM entries e LEFT JOIN users u ON u.id = e.uid
    ORDER BY e.start DESC
  `).all().map(row => ({ ...parseEntry(row), userName: row.user_name || row.user_email }));
  res.json(rows);
});

// ── Admin: import entries from Excel export ───────────────────────────────────
// ── Admin: import entries from Excel/CSV export ───────────────────────────────
app.post("/api/admin/import", requireAdmin, (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ error: "No entries provided" });

  const projByName = {};
  for (const [id, p] of Object.entries(PROJECTS))
    projByName[p.name.toLowerCase()] = id;

  const userCache = {};
  const getOrCreateUser = (name, email) => {
    if (userCache[email]) return userCache[email];
    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      const id = newId();
      const fakeGoogleId = "import_" + crypto.createHash("sha1").update(email).digest("hex");
      db.prepare("INSERT OR IGNORE INTO users (id, google_id, email, name, photo, created) VALUES (?, ?, ?, ?, NULL, ?)")
        .run(id, fakeGoogleId, email, name || email, Date.now());
      user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    }
    userCache[email] = user;
    return user;
  };

  const existingKeys = new Set(
    db.prepare("SELECT uid, start FROM entries").all()
      .map(r => `${r.uid}|${r.start}`)
  );

  const insertMany = db.transaction(rows => {
    let inserted = 0, skipped = 0;
    const affectedUsers = new Set();
    for (const r of rows) {
      if (!r.email || !r.startDate) { skipped++; continue; }
      const user = getOrCreateUser(r.user, r.email);
      if (!user) { skipped++; continue; }
      const startISO = `${r.startDate}T${r.startTime || "00:00:00"}`;
      const endISO   = `${r.endDate}T${r.endTime   || "00:00:00"}`;
      const key = `${user.id}|${startISO}`;
      if (existingKeys.has(key)) { skipped++; continue; }
      const durationSecs = Math.round((parseFloat(r.durationDecimal) || 0) * 3600);
      const projectId    = r.project ? (projByName[r.project.toLowerCase()] || null) : null;
      const tags         = r.tags ? r.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
      stmt.insertEntry.run({
        id:         newId(),
        uid:        user.id,
        desc:       r.description || "Untitled",
        project_id: projectId,
        tags:       JSON.stringify(tags),
        start:      startISO,
        end:        endISO,
        duration:   durationSecs,
        created:    Date.now(),
      });
      existingKeys.add(key);
      affectedUsers.add(user.id);
      inserted++;
    }
    return { inserted, skipped, users: affectedUsers.size };
  });

  try {
    const result = insertMany(entries);
    res.json(result);
  } catch(err) {
    console.error("Import error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: change password ────────────────────────────────────────────────────
app.post("/api/admin/change-password", requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== config.adminPassword)
    return res.status(401).json({ error: "Wrong current password" });
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: "Password too short" });
  config.adminPassword = newPassword;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

// ── Avatar helpers (server-side so PII never reaches the client) ──────────────
const AVATAR_COLORS = ["#818CF8","#22C97A","#F5A623","#38BDF8","#F472B6","#FB923C","#A78BFA","#34D399"];
function avatarColor(email) {
  const sum = [...email].reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[Math.abs(sum) % AVATAR_COLORS.length];
}
function avatarInitials(name) {
  return (name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function weekStart() {
  const ws = new Date();
  ws.setDate(ws.getDate() - ws.getDay());
  ws.setHours(0, 0, 0, 0);
  return ws;
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Tempo server running at ${BASE_URL}`);
  console.log(`   Student tracker: ${BASE_URL}/`);
  console.log(`   Admin panel:     ${BASE_URL}/admin.html`);
  console.log(`   Admin password:  ${config.adminPassword}`);
  console.log(`   Database:        ${DB_PATH}\n`);
});
