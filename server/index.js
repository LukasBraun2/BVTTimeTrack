require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express     = require("express");
const session     = require("express-session");
const passport    = require("passport");
const GoogleStrat = require("passport-google-oauth20").Strategy;
const path        = require("path");
const crypto      = require("crypto");
const fs          = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const DATA_DIR    = path.join(__dirname, "..", "data");
const DB_PATH     = path.join(DATA_DIR, "tempo.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── App-wide constants (single source of truth, served to clients) ────────────
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

// ── Shared app config (replaces duplicated constants in every HTML file) ──────
app.get("/api/config", (_req, res) => {
  res.json({ projects: PROJECTS, tags: TAGS });
});

app.get("/api/config/ui", (_req, res) => {
  const sidebarProjects = Object.entries(PROJECTS).map(([,p]) =>
    `<div class="proj-item"><span class="proj-dot" style="background:${p.color};box-shadow:0 0 5px ${p.color}80;"></span>${p.name}</div>`
  ).join("");
  const projDropItems = Object.entries(PROJECTS).map(([id, p]) =>
    `<div class="ditem" onclick="selectProj('${id}')"><span style="width:8px;height:8px;border-radius:50%;background:${p.color};flex-shrink:0;display:inline-block;"></span>${p.name}</div>`
  ).join("");
  const editProjOptions = Object.entries(PROJECTS).map(([id, p]) =>
    `<option value="${id}">${p.name}</option>`
  ).join("");
  const tagsDropItems = TAGS.map(t =>
    `<div class="ditem" id="tag-opt-${t.replace(/\s+/g,"-")}" onclick="event.stopPropagation();toggleTag('${t.replace(/'/g,"\\'")}')"><span class="check-box" id="chk-${t.replace(/\s+/g,"-")}"></span>${t}</div>`
  ).join("");
  res.json({ sidebarProjects, projDropItems, editProjOptions, tagsDropItems });
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// OAuth callback: supports popup postMessage flow and plain redirect fallback.
// The inline script is kept minimal — just route-selection logic.
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?error=auth_failed" }),
  (req, res) => {
    const user = {
      id:    req.user.id,
      email: req.user.email,
      name:  req.user.name,
      photo: req.user.photo,
    };
    // Encoded once here so the inline script never needs to do JSON.stringify
    const userJson = JSON.stringify(user).replace(/</g, "\\u003c");
    res.send(`<!DOCTYPE html><html><body><script>
(function(){
  var u=${userJson};
  if(window.opener){
    window.opener.postMessage({type:"GOOGLE_AUTH_SUCCESS",user:u},"${BASE_URL}");
    window.close();
  }else{
    localStorage.setItem("tempo_user",JSON.stringify(u));
    window.location.href="/";
  }
})();
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

// ── Admin auth — session-based (no more password in query strings) ────────────
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

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Entries: CRUD ─────────────────────────────────────────────────────────────
const fmtSec = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`; };
const fmtShort = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };
const fmtTime  = d => new Date(d).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fmtDate  = d => { const t=new Date(),y=new Date(t); y.setDate(y.getDate()-1); const dd=new Date(d); if(dd.toDateString()===t.toDateString())return"Today"; if(dd.toDateString()===y.toDateString())return"Yesterday"; return dd.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric"}); };

// /api/entries/list/:uid — grouped+formatted data for the tracker view
app.get("/api/entries/list/:uid", (req, res) => {
  const entries = db.entries.filter(e => e.uid === req.params.uid)
    .sort((a, b) => new Date(b.start) - new Date(a.start));
  const dayMap = {};
  entries.forEach(e => {
    const label = fmtDate(e.start);
    if (!dayMap[label]) dayMap[label] = [];
    const p = e.projectId ? PROJECTS[e.projectId] : null;
    dayMap[label].push({ ...e, startFormatted: fmtTime(e.start), endFormatted: fmtTime(e.end),
      durationFormatted: fmtSec(e.duration), projectName: p?.name||null, projectColor: p?.color||null });
  });
  const days = Object.entries(dayMap).map(([label, dayEntries]) => {
    const groupMap = {};
    dayEntries.forEach(e => { const k=(e.desc||"Untitled")+"||"+(e.projectId||""); if(!groupMap[k])groupMap[k]=[]; groupMap[k].push(e); });
    const groups = Object.entries(groupMap).map(([key, ge]) => ({
      key, hasMultiple: ge.length>1,
      totalFormatted: fmtSec(ge.reduce((s,e)=>s+e.duration,0)),
      entries: ge,
    }));
    return { label, entryCount: dayEntries.length, totalFormatted: fmtShort(dayEntries.reduce((s,e)=>s+e.duration,0)), groups };
  });
  res.json(days);
});

// /api/entries/stats/:uid — today + week seconds for the topbar
app.get("/api/entries/stats/:uid", (req, res) => {
  const entries = db.entries.filter(e => e.uid === req.params.uid);
  const now = new Date(), ws = new Date(now);
  ws.setDate(now.getDate()-now.getDay()); ws.setHours(0,0,0,0);
  res.json({
    todaySeconds: entries.filter(e=>new Date(e.start).toDateString()===now.toDateString()).reduce((s,e)=>s+e.duration,0),
    weekSeconds:  entries.filter(e=>new Date(e.start)>=ws).reduce((s,e)=>s+e.duration,0),
  });
});

// /api/entries/reports/:uid — aggregated data for the reports view
app.get("/api/entries/reports/:uid", (req, res) => {
  const entries = db.entries.filter(e => e.uid === req.params.uid);
  const total = entries.reduce((s,e)=>s+e.duration,0);
  const uniqueDays = new Set(entries.map(e=>new Date(e.start).toDateString())).size;
  const byProj = Object.entries(PROJECTS).map(([id,p]) => {
    const pe = entries.filter(e=>e.projectId===id);
    return { id, ...p, total: pe.reduce((s,e)=>s+e.duration,0), count: pe.length };
  }).filter(p=>p.total>0).sort((a,b)=>b.total-a.total);
  const grand = byProj.reduce((s,p)=>s+p.total,0);
  res.json({
    totalFormatted: fmtSec(total), entryCount: entries.length,
    activeProjects: byProj.length, avgDailyFormatted: fmtShort(Math.round(total/Math.max(1,uniqueDays))),
    grandFormatted: fmtSec(grand),
    projects: byProj.map(p=>({ ...p, totalFormatted: fmtSec(p.total), pct: grand>0?Math.round(p.total/grand*100):0 })),
  });
});

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
  if (!uid || !start || !end || duration == null)
    return res.status(400).json({ error: "Missing fields" });
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

// ── Admin: aggregated stats ───────────────────────────────────────────────────
// Moves all the stat computation that was happening client-side in admin.html.
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const now = new Date();
  const ws  = new Date(now);
  ws.setDate(now.getDate() - now.getDay());
  ws.setHours(0, 0, 0, 0);

  const weekEntries = db.entries.filter(e => new Date(e.start) >= ws);
  const allUids     = [...new Set(db.entries.map(e => e.uid))];
  const weekUids    = [...new Set(weekEntries.map(e => e.uid))];
  const weekSecs    = weekEntries.reduce((s, e) => s + e.duration, 0);
  const avgSecs     = weekUids.length > 0 ? Math.round(weekSecs / weekUids.length) : 0;

  res.json({
    totalStudents:  allUids.length,
    weekSeconds:    weekSecs,
    totalEntries:   db.entries.length,
    avgWeekSeconds: avgSecs,
  });
});

// ── Admin: students view (grouped, filtered, sorted server-side) ──────────────
// Accepts: ?project=academy|volunteer|module5  &period=week|all  &search=text
// Returns an array of student objects, each with their filtered entry list and
// pre-computed totals — so admin.html only has to render, not aggregate.
app.get("/api/admin/students", requireAdmin, (req, res) => {
  const { project = "", period = "week", search = "" } = req.query;

  const now = new Date();
  const ws  = new Date(now);
  ws.setDate(now.getDate() - now.getDay());
  ws.setHours(0, 0, 0, 0);

  // Build per-user buckets
  const byUser = {};
  db.entries.forEach(e => {
    const user = db.users.find(u => u.id === e.uid);
    if (!byUser[e.uid]) {
      byUser[e.uid] = {
        uid:     e.uid,
        email:   e.email || user?.email || "",
        name:    e.userName || user?.name || e.email || "Unknown",
        photo:   user?.photo || null,
        entries: [],
      };
    }
    byUser[e.uid].entries.push({ ...e, userName: byUser[e.uid].name });
  });

  let students = Object.values(byUser);

  // Text search
  if (search) {
    const q = search.toLowerCase();
    students = students.filter(u =>
      u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );
  }

  // Project filter
  if (project) {
    students = students.filter(u => u.entries.some(e => e.projectId === project));
  }

  // Period filter + project filter applied to each student's entry list
  students = students.map(u => {
    let entries = period === "week"
      ? u.entries.filter(e => new Date(e.start) >= ws)
      : u.entries;
    if (project) entries = entries.filter(e => e.projectId === project);

    // Sort entries newest-first
    entries = entries.slice().sort((a, b) => new Date(b.start) - new Date(a.start));

    // Project breakdown
    const projBreakdown = Object.entries(
      u.entries // always use all entries for breakdown totals
        .filter(e => e.projectId && (!project || e.projectId === project))
        .filter(e => period !== "week" || new Date(e.start) >= ws)
        .reduce((acc, e) => {
          acc[e.projectId] = (acc[e.projectId] || 0) + e.duration;
          return acc;
        }, {})
    ).sort((a, b) => b[1] - a[1]);

    const totalSeconds = entries.reduce((s, e) => s + e.duration, 0);
    const weekSeconds  = u.entries
      .filter(e => new Date(e.start) >= ws)
      .reduce((s, e) => s + e.duration, 0);

    return {
      uid:           u.uid,
      email:         u.email,
      name:          u.name,
      photo:         u.photo,
      totalSeconds,
      weekSeconds,
      totalEntries:  entries.length,
      projBreakdown, // [[projectId, seconds], ...]
      entries,       // filtered + sorted, capped at 50 for response size
    };
  });

  // Sort by week hours descending
  students.sort((a, b) => b.weekSeconds - a.weekSeconds);

  // Cap entries per student to keep payload manageable
  students = students.map(u => ({ ...u, entries: u.entries.slice(0, 50) }));

  res.json(students);
});

// ── Admin: all raw entries (kept for backward compat / CSV export use) ─────────
app.get("/api/admin/entries", requireAdmin, (req, res) => {
  const entries = [...db.entries].sort((a, b) => new Date(b.start) - new Date(a.start));
  const resolved = entries.map(e => {
    const user = db.users.find(u => u.id === e.uid);
    return { ...e, userName: e.userName || user?.name || e.email };
  });
  res.json(resolved);
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

app.listen(PORT, () => {
  console.log(`\n✅ Tempo server running at ${BASE_URL}`);
  console.log(`   Student tracker: ${BASE_URL}/`);
  console.log(`   Admin panel:     ${BASE_URL}/admin.html`);
  console.log(`   Admin password:  ${config.adminPassword}`);
  console.log(`   Data stored at:  ${DB_PATH}\n`);
});
