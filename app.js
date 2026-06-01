// --- Family config (loaded from /api/config before anything renders) ---
let familyConfig = {
  appName: "Daddy Daycare",
  parentRoles: ["Dad", "Mom"],
  kidRoles: ["Child 1", "Child 2"],
  allRoles: ["Dad", "Mom", "Child 1", "Child 2"],
};

async function loadFamilyConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) familyConfig = await res.json();
  } catch { /* use defaults */ }
  // Rebuild derived state from config
  PARENT_USERS.clear();
  for (const r of familyConfig.parentRoles) PARENT_USERS.add(r);
  // Default avatars: parents get gendered emoji, kids get 🧒
  const defaultParentEmojis = ["👨", "👩", "🧑", "👤"];
  const defaultKidEmojis = ["🧒", "👧", "👦", "🧒"];
  familyConfig.parentRoles.forEach((r, i) => {
    if (!DEFAULT_AVATARS[r]) DEFAULT_AVATARS[r] = defaultParentEmojis[i] || "👤";
  });
  familyConfig.kidRoles.forEach((r, i) => {
    if (!DEFAULT_AVATARS[r]) DEFAULT_AVATARS[r] = defaultKidEmojis[i] || "🧒";
  });
  // Merge family-specific extra streaks from schedule.config.js
  const extra = window.SCHEDULE_CONFIG?.extraStreaks || {};
  for (const [id, def] of Object.entries(extra)) STREAK_DEFS[id] = def;
}

// --- State ---
let currentUser = null;
let selectedRole = null;
let setupStep = 0;
let pendingPassword = "";
let draggedChoreId = null;
let dashboardClockTimer = null;
let dashboardRefreshTimer = null;
let dashboardRefreshInFlight = false;
let eggTimerIntervals = [];
let eggAdminInFlight = false;
let dashboardAudioContext = null;
let dashboardAlerts = [];
let dashboardAlertId = 0;
let dashboardShellBuilt = false;

let appState = {
  tokens: {},
  pending: [],
  approved: [],
  denied: [],
  streaks: {},
  avatars: {},
  chores: [],
  scheduleStatuses: {},
  spendNotifications: [],
  affirmations: [],
  rewards: [],
  active_eggs: [],
  egg_accepts: [],
  egg_challenges_meta: {},
  egg_challenges_pending: [],
};

const SCHEDULE_STATUS_LABELS = {
  "not-done": "Not Done",
  "in-progress": "In Progress",
  done: "Done"
};

const DASHBOARD_MODE_STORAGE_KEY = "daycare_dashboard_mode";
const DASHBOARD_THEME_MODE_STORAGE_KEY = "daycare_dashboard_theme_mode";
const AUTH_TOKEN_KEY = "daycare_token";
const AUTH_ROLE_KEY = "daycare_role";

const DEFAULT_AVATARS = {};
const PARENT_USERS = new Set();

const AVATAR_OUTPUT_SIZE = 180;
const MAX_AVATAR_FILE_BYTES = 8 * 1024 * 1024;

function isParentUser(user = currentUser) {
  return typeof user === "string" && PARENT_USERS.has(user);
}

const STREAK_DEFS = {
  helping: {
    label: "🤝 Helping Streak",
    goal: 5,
    prompt: "Helped out today"
  },
  kindness: {
    label: "💛 Kindness Streak",
    goal: 7,
    prompt: "Was kind today"
  },
  workout: {
    label: "💪 Workout Streak",
    goal: 0,
    prompt: "Worked out today"
  },
  // Extra streaks from window.SCHEDULE_CONFIG.extraStreaks are merged in loadFamilyConfig
};

// --- Schedule (loaded from schedule.config.js via window.SCHEDULE_CONFIG) ---

function getDailyBlocks(date = new Date()) {
  const cfg = window.SCHEDULE_CONFIG || {};
  const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dateKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;

  // Exact date overrides take highest priority
  if (cfg.customDates && cfg.customDates[dateKey]) return cfg.customDates[dateKey];

  // Date range override (e.g. transition week)
  if (cfg.transitionRange) {
    const [sy,sm,sd] = cfg.transitionRange.start, [ey,em,ed] = cfg.transitionRange.end;
    const rangeStart = new Date(sy, sm-1, sd).getTime();
    const rangeEnd   = new Date(ey, em-1, ed).getTime();
    if (t >= rangeStart && t <= rangeEnd) return cfg.transitionRange.blocks || [];
  }

  // Day-of-week block override (e.g. weekend-specific schedules)
  const dow = date.getDay();
  if (cfg.dayBlocks && cfg.dayBlocks[dow]) return cfg.dayBlocks[dow];

  return cfg.dailyBlocks || [];
}

function getTodayScheduleKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getScheduleStatuses() {
  return appState.scheduleStatuses || {};
}

function getScheduleStatus(dayKey, blockId) {
  const dayStatuses = getScheduleStatuses()[dayKey] || {};
  return dayStatuses[blockId] || null;
}

function getScheduleSummary(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const blocks = getDailyBlocks(new Date(y, m - 1, d));
  const summary = {
    total: blocks.length,
    done: 0,
    inProgress: 0,
    notDone: 0,
    unmarked: 0
  };

  for (const block of blocks) {
    const status = getScheduleStatus(dayKey, block.id);
    if (status === "done") {
      summary.done += 1;
    } else if (status === "in-progress") {
      summary.inProgress += 1;
    } else if (status === "not-done") {
      summary.notDone += 1;
    } else {
      summary.unmarked += 1;
    }
  }

  return summary;
}

function getScheduleSummaryForStatuses(scheduleStatuses, dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const blocks = getDailyBlocks(new Date(y, m - 1, d));
  const summary = {
    total: blocks.length,
    done: 0,
    inProgress: 0,
    notDone: 0,
    unmarked: 0
  };
  const dayStatuses = (scheduleStatuses && scheduleStatuses[dayKey]) || {};

  for (const block of blocks) {
    const status = dayStatuses[block.id] || null;
    if (status === "done") {
      summary.done += 1;
    } else if (status === "in-progress") {
      summary.inProgress += 1;
    } else if (status === "not-done") {
      summary.notDone += 1;
    } else {
      summary.unmarked += 1;
    }
  }

  return summary;
}

function getScheduleContext(date = new Date()) {
  const dow = date.getDay();
  const currentIdx = getCurrentBlockIndex();
  const scheduleKey = getTodayScheduleKey(date);
  const theme = (window.SCHEDULE_CONFIG?.dayThemes || {})[dow] || null;
  const week = getSummerWeek(date);
  const blocks = getDailyBlocks(date);
  const currentBlock = currentIdx === null ? null : blocks[currentIdx] || null;
  const upcomingStart = currentIdx === null ? 0 : currentIdx + 1;
  const upcomingBlocks = blocks.slice(upcomingStart, upcomingStart + 4);
  const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dateStr = `${dayNames[dow]}, ${monthNames[date.getMonth()]} ${date.getDate()}`;

  return {
    dow,
    currentIdx,
    currentBlock,
    upcomingBlocks,
    scheduleKey,
    theme,
    week,
    dateStr
  };
}

function getStoredDashboardMode() {
  return localStorage.getItem(DASHBOARD_MODE_STORAGE_KEY) === "on";
}

function getStoredDashboardThemeMode() {
  const stored = localStorage.getItem(DASHBOARD_THEME_MODE_STORAGE_KEY);
  return stored === "day" || stored === "night" ? stored : "auto";
}

function setStoredDashboardMode(enabled) {
  if (enabled) {
    localStorage.setItem(DASHBOARD_MODE_STORAGE_KEY, "on");
  } else {
    localStorage.removeItem(DASHBOARD_MODE_STORAGE_KEY);
  }
}

function exitDashboard() {
  setDashboardMode(false);
  // If no one is logged in (entered from login screen), return to login
  if (!currentUser) {
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("app").style.display = "none";
  }
}

function setStoredDashboardThemeMode(mode) {
  if (mode === "day" || mode === "night") {
    localStorage.setItem(DASHBOARD_THEME_MODE_STORAGE_KEY, mode);
    return;
  }

  localStorage.removeItem(DASHBOARD_THEME_MODE_STORAGE_KEY);
}

function isAutomaticNightHours(date = new Date()) {
  const hour = date.getHours();
  return hour >= 19 || hour < 7;
}

function isDashboardNightTheme(date = new Date()) {
  const themeMode = getStoredDashboardThemeMode();
  if (themeMode === "night") return true;
  if (themeMode === "day") return false;
  return isAutomaticNightHours(date);
}

function cycleDashboardThemeMode() {
  if (!isParentUser()) {
    return;
  }

  const currentMode = getStoredDashboardThemeMode();
  const nextMode = currentMode === "auto" ? "night" : currentMode === "night" ? "day" : "auto";
  setStoredDashboardThemeMode(nextMode);
  renderDashboardMode();
}

function getDashboardThemeLabel() {
  const mode = getStoredDashboardThemeMode();
  if (mode === "night") return "Theme: Night";
  if (mode === "day") return "Theme: Day";
  return "Theme: Auto";
}

function isDashboardModeEnabled() {
  return document.body.classList.contains("dashboard-mode");
}

function updateDashboardToggle() {
  const button = document.getElementById("dashboard-toggle");
  if (!button) return;

  const enabled = isDashboardModeEnabled();
  button.textContent = enabled ? "Exit TV Dashboard" : "Enable TV Dashboard";
  button.classList.toggle("active", enabled);
}

function ensureDashboardAudio() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  if (!dashboardAudioContext) {
    dashboardAudioContext = new AudioContextCtor();
  }

  if (dashboardAudioContext.state === "suspended") {
    dashboardAudioContext.resume().catch(() => {});
  }

  return dashboardAudioContext;
}

function playDashboardSound(kind) {
  const context = ensureDashboardAudio();
  if (!context) return;

  const sequences = {
    success: [
      { freq: 523.25, duration: 0.12, gain: 0.05 },
      { freq: 659.25, duration: 0.14, gain: 0.06 },
      { freq: 783.99, duration: 0.18, gain: 0.07 }
    ],
    achievement: [
      { freq: 523.25, duration: 0.1,  gain: 0.05 },
      { freq: 659.25, duration: 0.12, gain: 0.06 },
      { freq: 783.99, duration: 0.12, gain: 0.07 },
      { freq: 1046.5, duration: 0.22, gain: 0.08 }
    ],
    progress: [
      { freq: 440,    duration: 0.12, gain: 0.045 },
      { freq: 587.33, duration: 0.16, gain: 0.05 }
    ],
    warning: [
      { freq: 369.99, duration: 0.12, gain: 0.05,  type: "triangle" },
      { freq: 329.63, duration: 0.16, gain: 0.045, type: "triangle" }
    ],
    coins: [
      { freq: 523.25, duration: 0.07, gain: 0.07 },
      { freq: 659.25, duration: 0.07, gain: 0.07 },
      { freq: 783.99, duration: 0.07, gain: 0.08 },
      { freq: 1046.5, duration: 0.07, gain: 0.09 },
      { freq: 1318.5, duration: 0.13, gain: 0.10 }
    ],
    levelup: [
      { freq: 392.00, duration: 0.09, gain: 0.06 },
      { freq: 523.25, duration: 0.09, gain: 0.07 },
      { freq: 659.25, duration: 0.09, gain: 0.08 },
      { freq: 783.99, duration: 0.09, gain: 0.08 },
      { freq: 1046.5, duration: 0.20, gain: 0.10 }
    ],
    fanfare: [
      { freq: 392.00, duration: 0.10, gain: 0.07 },
      { freq: 523.25, duration: 0.10, gain: 0.08 },
      { freq: 659.25, duration: 0.10, gain: 0.09 },
      { freq: 783.99, duration: 0.14, gain: 0.10 },
      { freq: 1046.5, duration: 0.10, gain: 0.09 },
      { freq: 1318.5, duration: 0.28, gain: 0.12 }
    ]
  };
  const steps = sequences[kind] || sequences.progress;
  let startAt = context.currentTime + 0.02;

  for (const step of steps) {
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    const duration = step.duration || 0.15;

    oscillator.type = step.type || "sine";
    oscillator.frequency.setValueAtTime(step.freq, startAt);

    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(step.gain || 0.05, startAt + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.03);

    startAt += duration * 0.82;
  }
}

function triggerConfetti(intensity = 1) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;";
  const maxW = Math.min(window.innerWidth, 640);
  const scale = maxW / window.innerWidth;
  canvas.width = maxW;
  canvas.height = Math.round(window.innerHeight * scale);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const colors = ["#ff6b6b","#ffd93d","#6bcb77","#4d96ff","#c77dff","#ff9f43","#00d2d3","#ff6348"];
  const count = Math.round(28 * intensity);
  const particles = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 80,
    vx: (Math.random() - 0.5) * 7,
    vy: Math.random() * 4 + 2,
    color: colors[Math.floor(Math.random() * colors.length)],
    w: Math.random() * 10 + 5,
    h: Math.random() * 6 + 3,
    rotation: Math.random() * 360,
    rotSpeed: (Math.random() - 0.5) * 12,
    opacity: 1
  }));

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      p.rotation += p.rotSpeed;
      if (frame > 90) p.opacity -= 0.018;
      if (p.y < canvas.height + 30 && p.opacity > 0) alive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    frame++;
    if (alive && frame < 160) requestAnimationFrame(animate);
    else canvas.remove();
  }
  requestAnimationFrame(animate);
}

function animateCounter(el, from, to, duration = 700) {
  if (!el || from === to) return;
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = to;
  }
  requestAnimationFrame(step);
}

const MOTIVATIONAL_MESSAGES = [
  "Your team is unstoppable! 💪",
  "Every kind act earns a sun token! ☀️",
  "Work together, win together! 🤝",
  "Kindness is the biggest superpower! 💛",
  "The streak is on fire — keep going! 🔥",
  "You guys are crushing it today! 🏆",
  "Be kind once and watch it multiply! 🌟",
  "Dad is so proud of you both! ❤️",
  "Small acts, big rewards! ✨",
  "Today is a great day to help! 🙌",
  "Together you can do anything! 🎉",
  "Keep that helping streak alive! 🔥",
];

function getDashboardMotivation() {
  const idx = Math.floor(Date.now() / 60000) % MOTIVATIONAL_MESSAGES.length;
  return MOTIVATIONAL_MESSAGES[idx];
}

function buildFloatingEmojisMarkup() {
  const emojis = ["⭐","🏆","💛","🌟"];
  return emojis.map((emoji, i) => {
    const left = ((i * 23 + 6) % 90).toFixed(1);
    const delay = (-(i * 4.5)).toFixed(1);
    const dur = (18 + (i % 3) * 4).toFixed(1);
    const size = (1.1 + (i % 2) * 0.3).toFixed(2);
    return `<span class="db-float-emoji" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s;font-size:${size}rem;" aria-hidden="true">${emoji}</span>`;
  }).join("");
}

function buildDashboardAvatarHtml(user) {
  // Never embed data URLs in HTML strings — use data-avatar-user and applyDashboardAvatars()
  return `<span class="db-avatar" data-avatar-user="${escapeHtml(user)}">${escapeHtml(getDefaultAvatar(user))}</span>`;
}

function applyDashboardAvatars(root) {
  root.querySelectorAll("[data-avatar-user]").forEach(el => {
    const user = el.dataset.avatarUser;
    const avatarData = getAvatar(user);
    if (avatarData) {
      el.style.backgroundImage = `url("${avatarData}")`;
      el.textContent = "";
    } else {
      el.style.backgroundImage = "none";
      el.textContent = getDefaultAvatar(user);
    }
  });
}

function formatDashboardAlertTime(time) {
  return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function pushDashboardAlert(type, title, detail, sound = "progress") {
  dashboardAlerts = [{
    id: ++dashboardAlertId,
    type,
    title,
    detail,
    time: Date.now()
  }].concat(dashboardAlerts).slice(0, 8);

  if (isParentUser() && isDashboardModeEnabled()) {
    playDashboardSound(sound);
    renderDashboardMode();
  }
}

function buildDashboardSnapshot(state = appState) {
  const dayKey = getTodayScheduleKey();
  const tokens = state.tokens || {};
  const streaks = state.streaks || {};

  return {
    dayKey,
    summary: getScheduleSummaryForStatuses(state.scheduleStatuses || {}, dayKey),
    pendingKeys: (state.pending || []).map(item => item.key).sort(),
    spendKeys: (state.spendNotifications || []).map(item => `${item.time}|${item.user}|${item.rewardName}|${item.cost}`).sort(),
    tokens: Object.fromEntries(familyConfig.kidRoles.map(r => [r, Number(tokens[r] || 0)])),
    streaks: familyConfig.kidRoles.reduce((result, user) => {
      result[user] = {};
      for (const streakId of Object.keys(STREAK_DEFS)) {
        const record = ((streaks[user] || {})[streakId]) || {};
        result[user][streakId] = {
          current: Number(record.current || 0),
          best: Number(record.best || 0)
        };
      }
      return result;
    }, {})
  };
}

function announceDashboardChanges(previousSnapshot, nextSnapshot, options = {}) {
  if (!previousSnapshot || options.silent) {
    return;
  }

  const doneDelta = nextSnapshot.summary.done - previousSnapshot.summary.done;
  const progressDelta = nextSnapshot.summary.inProgress - previousSnapshot.summary.inProgress;
  const missedDelta = nextSnapshot.summary.notDone - previousSnapshot.summary.notDone;

  if (doneDelta > 0) {
    pushDashboardAlert("success", "Schedule block completed! 🎉", `${doneDelta} block${doneDelta === 1 ? "" : "s"} moved to done.`, "levelup");
    triggerConfetti(doneDelta);
  }
  if (progressDelta > 0) {
    pushDashboardAlert("progress", "Something is underway 🚀", `${progressDelta} block${progressDelta === 1 ? " is" : "s are"} now in progress.`, "progress");
  }
  if (missedDelta > 0) {
    pushDashboardAlert("warning", "Schedule adjusted", `${missedDelta} block${missedDelta === 1 ? " was" : "s were"} marked not done.`, "warning");
  }

  for (const user of familyConfig.kidRoles) {
    const tokenDelta = nextSnapshot.tokens[user] - previousSnapshot.tokens[user];
    if (tokenDelta > 0) {
      pushDashboardAlert("success", `${user} earned ${tokenDelta} ☀️ tokens!`, `New balance: ${nextSnapshot.tokens[user]} ☀️`, "coins");
      triggerConfetti(0.6);
    }
  }

  const previousPendingKeys = new Set(previousSnapshot.pendingKeys);
  for (const pendingKey of nextSnapshot.pendingKeys) {
    if (!previousPendingKeys.has(pendingKey)) {
      const pendingItem = getPending().find(item => item.key === pendingKey);
      if (pendingItem) {
        pushDashboardAlert("progress", `New approval for ${pendingItem.user}`, pendingLabel(pendingItem), "progress");
      }
    }
  }

  const previousSpendKeys = new Set(previousSnapshot.spendKeys);
  for (const spendKey of nextSnapshot.spendKeys) {
    if (!previousSpendKeys.has(spendKey)) {
      const spendItem = getSpendNotifications().find(item => `${item.time}|${item.user}|${item.rewardName}|${item.cost}` === spendKey);
      if (spendItem) {
        pushDashboardAlert("success", `${spendItem.user} cashed out`, `${spendItem.rewardName} for ${spendItem.cost} ☀️`, "success");
      }
    }
  }

  for (const user of familyConfig.kidRoles) {
    for (const [streakId, config] of Object.entries(STREAK_DEFS)) {
      const previousRecord = previousSnapshot.streaks[user][streakId];
      const nextRecord = nextSnapshot.streaks[user][streakId];

      if (nextRecord.current > previousRecord.current) {
        pushDashboardAlert("progress", `${user}'s ${config.label} moved! 🔥`, `Now at ${nextRecord.current} day${nextRecord.current === 1 ? "" : "s"}.`, "success");
      }

      if (config.goal > 0 && previousRecord.current < config.goal && nextRecord.current >= config.goal) {
        pushDashboardAlert("achievement", `🏆 ${user} CRUSHED THE GOAL!`, `${config.label} hit ${config.goal} days — incredible!`, "fanfare");
        triggerConfetti(2);
      } else if (nextRecord.best > previousRecord.best && nextRecord.best > 0) {
        pushDashboardAlert("achievement", `🌟 ${user} set a new best!`, `${config.label} best is now ${nextRecord.best} days.`, "fanfare");
        triggerConfetti(1.2);
      }
    }
  }
}

function buildDashboardAlertsMarkup() {
  if (dashboardAlerts.length === 0) {
    return '<p class="dashboard-empty">Alerts will appear here when the day changes shape.</p>';
  }

  return dashboardAlerts.map(alert => `
    <div class="dashboard-alert-item dashboard-alert-${alert.type}">
      <div>
        <strong>${escapeHtml(alert.title)}</strong>
        <span>${escapeHtml(alert.detail)}</span>
      </div>
      <small>${escapeHtml(formatDashboardAlertTime(alert.time))}</small>
    </div>
  `).join("");
}

function buildDashboardToastMarkup() {
  if (dashboardAlerts.length === 0) {
    return "";
  }

  return `
    <div class="dashboard-toast-stack">
      ${dashboardAlerts.slice(0, 3).map(alert => `
        <div class="dashboard-toast dashboard-alert-${alert.type}">
          <strong>${escapeHtml(alert.title)}</strong>
          <span>${escapeHtml(alert.detail)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function celebrateUser(user) {
  const shell = document.getElementById("dashboard-shell");
  if (!shell) return;
  const card = shell.querySelector(`.db-score-${user.toLowerCase()}`);
  if (!card) return;
  const avatar = card.querySelector(".db-avatar");
  if (!avatar) return;
  avatar.classList.remove("db-avatar-celebrate");
  void avatar.offsetWidth;
  avatar.classList.add("db-avatar-celebrate");
  avatar.addEventListener("animationend", () => avatar.classList.remove("db-avatar-celebrate"), { once: true });
}

let streakCometGuard = null;

function streakFlyAcross(user) {
  if (streakCometGuard) return;
  streakCometGuard = setTimeout(() => streakCometGuard = null, 1600);

  const card = document.querySelector(`.db-streak-${user.toLowerCase()}`);
  if (!card) return;
  const avatarEl = card.querySelector(".db-avatar");
  const originEl = (avatarEl && avatarEl.getBoundingClientRect().width > 0) ? avatarEl : card;

  const rect = originEl.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  const flyX = window.innerWidth - startX + 120;
  const flyY = -(startY + 120);

  const fireCount = 14;
  let fires = "";
  for (let i = 0; i < fireCount; i++) {
    fires += `<span class="db-comet-fire" style="--i:${i}"></span>`;
  }

  const comet = document.createElement("div");
  comet.className = "db-comet";
  comet.style.setProperty("--start-x", startX + "px");
  comet.style.setProperty("--start-y", startY + "px");
  comet.style.setProperty("--fly-x", flyX + "px");
  comet.style.setProperty("--fly-y", flyY + "px");

  comet.innerHTML = `<span class="db-comet-avatar">${escapeHtml(getDefaultAvatar(user))}</span><span class="db-comet-trail">${fires}</span>`;

  document.body.appendChild(comet);

  void comet.offsetWidth;
  comet.classList.add("db-comet-launch");

  comet.addEventListener("animationend", () => { comet.remove(); }, { once: true });
}

function toggleDashboardMode() {
  if (!isParentUser()) {
    return;
  }

  setDashboardMode(!isDashboardModeEnabled());
}

async function enterLoginDashboard() {
  await loadFamilyConfig();
  await refreshState();
  await loadPublicAvatars();
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "flex";
  document.getElementById("parent-view").style.display = "none";
  document.getElementById("kid-view").style.display = "none";
  document.getElementById("wallet").style.display = "none";
  document.getElementById("avatar-panel").style.display = "none";
  document.getElementById("schedule-toggle").style.display = "none";
  const panel = document.getElementById("dashboard-mode");
  if (panel) panel.style.display = "block";
  document.body.classList.add("dashboard-mode");
  document.getElementById("app").classList.add("dashboard-mode");
  setStoredDashboardMode(true);
  ensureDashboardAudio();
  renderDashboardMode();
  syncDashboardClock();
  syncDashboardRefresh();
}

function setDashboardMode(enabled) {
  const shouldEnable = enabled && isParentUser();
  const app = document.getElementById("app");
  const panel = document.getElementById("dashboard-mode");

  document.body.classList.toggle("dashboard-mode", shouldEnable);
  if (app) {
    app.classList.toggle("dashboard-mode", shouldEnable);
  }
  if (panel) {
    panel.style.display = shouldEnable ? "block" : "none";
  }

  if (!shouldEnable) {
    dashboardShellBuilt = false;
    if (tickerTimeout) { clearTimeout(tickerTimeout); tickerTimeout = null; }
  }

  setStoredDashboardMode(shouldEnable);
  updateDashboardToggle();
  syncDashboardClock();
  syncDashboardRefresh();

  if (shouldEnable) {
    ensureDashboardAudio();
    renderDashboardMode();
  }
}

function syncDashboardClock() {
  if (dashboardClockTimer) {
    clearInterval(dashboardClockTimer);
    dashboardClockTimer = null;
  }

  if (isDashboardModeEnabled()) {
    dashboardClockTimer = setInterval(() => {
      renderDashboardMode();
    }, 30000);
  }
}

function syncDashboardRefresh() {
  if (dashboardRefreshTimer) {
    clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
  }

  if (isDashboardModeEnabled()) {
    dashboardRefreshTimer = setInterval(() => {
      refreshDashboardData();
    }, 60000);
  }
}

async function refreshDashboardData() {
  if (dashboardRefreshInFlight || !isDashboardModeEnabled()) {
    return;
  }

  dashboardRefreshInFlight = true;
  try {
    await refreshState();
    renderSchedule();
    renderParentView();
  } catch (err) {
    pushDashboardAlert("warning", "Dashboard refresh missed", "Could not pull the latest family state from the server.", "warning");
  } finally {
    dashboardRefreshInFlight = false;
  }
}

function buildDashboardBalancesMarkup() {
  return familyConfig.kidRoles.map(user => {
    const tokens = getTokens(user);
    return `
      <div class="dashboard-balance-card db-balance-${user.toLowerCase().replace(/\s+/g, "-")}">
        <div class="db-balance-header">
          ${buildDashboardAvatarHtml(user)}
          <span class="db-balance-name-text">${escapeHtml(user)}</span>
        </div>
        <div class="dashboard-balance-value" data-counter="${tokens}" data-user="${escapeHtml(user)}"><span class="db-token-num">${tokens}</span> <span>☀️</span></div>
      </div>
    `;
  }).join("");
}

function buildDashboardPendingMarkup() {
  const pending = getPending();
  if (pending.length === 0) {
    return '<p class="dashboard-empty">No pending approvals right now.</p>';
  }

  return pending.slice(0, 5).map(item => `
    <div class="dashboard-list-item">
      <strong>${escapeHtml(item.user)}</strong>
      <span>${escapeHtml(pendingLabel(item))}</span>
    </div>
  `).join("");
}

function buildDashboardUpcomingMarkup(scheduleKey, blocks) {
  if (blocks.length === 0) {
    return '<p class="dashboard-empty">No more blocks after this. Wrap-up time.</p>';
  }

  return blocks.map(block => {
    const status = getScheduleStatus(scheduleKey, block.id);
    const statusText = status ? SCHEDULE_STATUS_LABELS[status] : "Unmarked";
    const isDayWrap = block.id === "day-wrap";
    const showCta = isDayWrap;
    return `
      <div class="dashboard-list-item dashboard-upcoming-item">
        <div>
          <strong>${escapeHtml(block.time)} · ${escapeHtml(block.label)}</strong>
          <span>${escapeHtml(block.desc || "Planned block")}</span>
          ${showCta ? `<button type="button" class="affirmation-cta-btn" onclick="showAffirmationModal()">💛 Write an Affirmation</button>` : ""}
        </div>
        <em class="dashboard-mini-status${status ? ` schedule-status-${status}` : ""}">${escapeHtml(statusText)}</em>
      </div>
    `;
  }).join("");
}

function buildDashboardSuggestedChoresMarkup(theme) {
  if (!theme) {
    return '<p class="dashboard-empty">Weekend mode. No suggested chore set for today.</p>';
  }

  const chores = theme.chores
    .map(id => getChores().find(chore => chore.id === id))
    .filter(Boolean)
    .slice(0, 4);

  if (chores.length === 0) {
    return '<p class="dashboard-empty">No matching chores configured for today.</p>';
  }

  return chores.map(chore => `
    <div class="dashboard-chip">${escapeHtml(chore.label)} · ${chore.amount} ☀️</div>
  `).join("");
}

function buildDashboardSuggestedChoresChipsMarkup(theme) {
  if (!theme) return "";

  const chores = theme.chores
    .map(id => getChores().find(chore => chore.id === id))
    .filter(Boolean)
    .slice(0, 3);

  return chores.map(chore => `<span class="dashboard-pill">${escapeHtml(chore.label)} · ${chore.amount} ☀️</span>`).join("");
}

function buildDashboardStreakMarkup() {
  return familyConfig.kidRoles.map(user => {
    const streaks = Object.entries(STREAK_DEFS).map(([streakId, config]) => {
      const record = getStreakRecord(user, streakId);
      const current = record.current || 0;
      const goal = config.goal || 0;
      const goalHit = goal > 0 && current >= goal;
      const fireCount = Math.min(current, goal > 0 ? goal : 7);
      const fires = Array.from({ length: fireCount }, () => `<span class="db-fire">🔥</span>`).join("");
      const barPct = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0;
      const barHtml = goal > 0
        ? `<div class="db-streak-bar"><div class="db-streak-bar-fill${goalHit ? " db-streak-goal" : ""}" style="width:${barPct}%"></div></div>`
        : "";
      const goalBadge = goalHit ? `<span class="db-goal-badge">GOAL! 🏆</span>` : (goal > 0 ? `<span class="db-streak-goal-text">${current}/${goal}</span>` : `<span class="db-streak-goal-text">${current} days</span>`);
      return `
        <div class="db-streak-row">
          <div class="db-streak-label">${config.label}</div>
          <div class="db-streak-fires">${fires || "<span class='db-streak-zero'>Start today!</span>"}</div>
          ${barHtml}
          <div class="db-streak-meta">${goalBadge}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="dashboard-streak-card db-streak-${user.toLowerCase()}">
        <h4 class="db-balance-header"><span class="db-avatar clickable-streak-avatar" data-avatar-user="${escapeHtml(user)}" onclick="streakFlyAcross('${escapeHtml(user)}')">${escapeHtml(getDefaultAvatar(user))}</span><span>${escapeHtml(user)}</span></h4>
        ${streaks}
      </div>
    `;
  }).join("");
}

function renderDashboardMode() {
  const shell = document.getElementById("dashboard-shell");
  if (!shell || (!isParentUser() && !getStoredDashboardMode())) return;

  if (!shell.querySelector(".dashboard-shell")) dashboardShellBuilt = false;

  if (!dashboardShellBuilt) {
    initDashboardShell(shell);
    dashboardShellBuilt = true;
  } else {
    patchDashboardLive(shell);
  }
}

function initDashboardShell(shell) {
  const now = new Date();
  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const context = getScheduleContext(now);
  const summary = getScheduleSummary(context.scheduleKey);
  const nightTheme = isDashboardNightTheme(now);
  const themeLabel = getDashboardThemeLabel();
  const currentStatus = context.currentBlock ? getScheduleStatus(context.scheduleKey, context.currentBlock.id) : null;
  const currentStatusText = currentStatus ? SCHEDULE_STATUS_LABELS[currentStatus] : "Unmarked";
  const focusBlock = context.currentBlock || getDailyBlocks()[0];
  const focusTitle = context.currentBlock ? focusBlock.label : "Day starts soon";
  const focusSubtitle = context.currentBlock
    ? (focusBlock.desc || (context.theme ? (focusBlock.label.includes("Morning") ? context.theme.morning : context.theme.afternoon) : ""))
    : `First block: ${focusBlock.time} · ${focusBlock.label}`;
  const pending = getPending();
  const suggestedChoresHtml = buildDashboardSuggestedChoresChipsMarkup(context.theme);
  const motivation = getDashboardMotivation();

  shell.innerHTML = `
    <div class="dashboard-shell${nightTheme ? " dashboard-night" : ""}">
      <div class="db-float-layer" aria-hidden="true">${buildFloatingEmojisMarkup()}</div>
      <div id="db-toast-slot"></div>
      <div class="dashboard-topbar">
        <div>
          <div class="dashboard-kicker">🍦 ${escapeHtml(familyConfig.appName)}</div>
          <h1>${escapeHtml(context.dateStr)}${context.week ? ` · ${escapeHtml(context.week.emoji)} ${escapeHtml(context.week.label)}` : ""}</h1>
        </div>
        <div class="dashboard-topbar-actions">
          <div id="db-clock" class="dashboard-clock db-clock-pulse">${escapeHtml(clock)}</div>
          <button type="button" class="secondary-btn dashboard-theme-btn" onclick="cycleDashboardThemeMode()" id="db-theme-btn">${escapeHtml(themeLabel)}</button>
          <button type="button" class="secondary-btn" onclick="exitDashboard()">Exit</button>
        </div>
      </div>
      <div id="db-affirmation-ticker-wrap">${buildAffirmationTickerMarkup()}</div>

      <div class="dashboard-hero">
        <div class="dashboard-hero-main db-panel-enter">
          <div class="dashboard-kicker" id="db-focus-kicker">Now · ${escapeHtml(focusBlock.time)}</div>
          <h2 class="db-hero-title" id="db-focus-title">${escapeHtml(focusTitle)}</h2>
          <p class="db-motivation" id="db-motivation">${escapeHtml(motivation)}</p>
          <div class="dashboard-hero-meta" id="db-hero-meta">
            <span class="dashboard-pill${currentStatus ? ` schedule-status-${currentStatus}` : ""}" id="db-status-pill">${escapeHtml(currentStatusText)}</span>
            <span class="dashboard-pill" id="db-pending-pill">Pending ${pending.length}</span>
            ${suggestedChoresHtml}
          </div>
        </div>

        <div class="dashboard-hero-scores db-panel-enter" style="animation-delay:0.04s">
          <div class="dashboard-kicker">☀️ Token Scores</div>
          <div class="db-scoreboard">
            ${familyConfig.kidRoles.map((kid, i) => `
              <div class="db-scoreboard-card db-score-kid-${i} db-score-${kid.toLowerCase()}" onclick="celebrateUser('${escapeHtml(kid)}')">
                ${buildDashboardAvatarHtml(kid)}
                <span class="db-scoreboard-name">${escapeHtml(kid)}</span>
                <span class="db-scoreboard-num" id="db-score-kid-${i}">${getTokens(kid)}</span>
              </div>
              ${i < familyConfig.kidRoles.length - 1 ? '<div class="db-scoreboard-divider">vs</div>' : ''}
            `).join("")}
          </div>
        </div>

        <div class="dashboard-hero-side db-panel-enter" style="animation-delay:0.08s">
          <div class="dashboard-kicker">Today's Follow-Through</div>
          <div class="dashboard-metric-row dashboard-metric-row-4col">
            <div class="dashboard-metric-card db-metric-done">
              <strong id="db-metric-done">${summary.done}</strong>
              <span>✅ Done</span>
            </div>
            <div class="dashboard-metric-card db-metric-progress">
              <strong id="db-metric-progress">${summary.inProgress}</strong>
              <span>🚀 Going</span>
            </div>
            <div class="dashboard-metric-card">
              <strong id="db-metric-missed">${summary.notDone}</strong>
              <span>❌ Missed</span>
            </div>
            <div class="dashboard-metric-card">
              <strong id="db-metric-unmarked">${summary.unmarked}</strong>
              <span>⬜ Left</span>
            </div>
          </div>
        </div>
      </div>

      <div class="dashboard-grid">
        <section class="dashboard-panel dashboard-panel-upcoming db-panel-enter" style="animation-delay:0.1s">
          <div class="dashboard-panel-header">
            <h3>📅 Upcoming Blocks</h3>
            <span>${context.theme ? escapeHtml(context.theme.name) : "Weekend"}</span>
          </div>
          <div id="db-upcoming">${buildDashboardUpcomingMarkup(context.scheduleKey, context.upcomingBlocks)}</div>
        </section>

        <section class="dashboard-panel dashboard-panel-streaks db-panel-enter" style="animation-delay:0.15s">
          <div class="dashboard-panel-header">
            <h3>🔥 Streak Watch</h3>
            <span>Keep it going!</span>
          </div>
          <div class="dashboard-streak-grid" id="db-streaks">${buildDashboardStreakMarkup()}</div>
        </section>

        <section class="dashboard-panel db-panel-enter" style="animation-delay:0.25s">
          <div class="dashboard-panel-header">
            <h3>⏳ Pending Approvals</h3>
            <span id="db-pending-header-count">${pending.length} waiting</span>
          </div>
          <div id="db-pending">${buildDashboardPendingMarkup()}</div>
        </section>

        <section class="dashboard-panel db-panel-enter" style="animation-delay:0.3s">
          <div class="dashboard-panel-header">
            <h3>🔔 Live Alerts</h3>
            <span>Sound on change</span>
          </div>
          <div id="db-alerts">${buildDashboardAlertsMarkup()}</div>
        </section>
      </div>
      <button type="button" class="affirmation-fab" onclick="showAffirmationModal()" title="Write an affirmation">💛</button>
    </div>
  `;

  applyDashboardAvatars(shell);
  patchDashboardToast(shell);
  animateCounters(shell);
}

function patchDashboardLive(shell) {
  const now = new Date();
  const context = getScheduleContext(now);
  const summary = getScheduleSummary(context.scheduleKey);
  const pending = getPending();
  const nightTheme = isDashboardNightTheme(now);
  const themeLabel = getDashboardThemeLabel();
  const currentStatus = context.currentBlock ? getScheduleStatus(context.scheduleKey, context.currentBlock.id) : null;
  const currentStatusText = currentStatus ? SCHEDULE_STATUS_LABELS[currentStatus] : "Unmarked";
  const focusBlock = context.currentBlock || getDailyBlocks()[0];
  const focusTitle = context.currentBlock ? focusBlock.label : "Day starts soon";

  const $ = id => shell.querySelector(`#${id}`);
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const setHtml = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };

  setText("db-clock", now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  setText("db-focus-kicker", `Now · ${focusBlock.time}`);
  setText("db-focus-title", focusTitle);
  setText("db-motivation", getDashboardMotivation());
  setText("db-metric-done", summary.done);
  setText("db-metric-progress", summary.inProgress);
  setText("db-metric-missed", summary.notDone);
  setText("db-metric-unmarked", summary.unmarked);
  setText("db-pending-pill", `Pending ${pending.length}`);
  setText("db-pending-header-count", `${pending.length} waiting`);
  familyConfig.kidRoles.forEach((kid, i) => setText(`db-score-kid-${i}`, getTokens(kid)));

  const statusPill = $("db-status-pill");
  if (statusPill) {
    statusPill.textContent = currentStatusText;
    statusPill.className = `dashboard-pill${currentStatus ? ` schedule-status-${currentStatus}` : ""}`;
  }

  const themeBtn = $("db-theme-btn");
  if (themeBtn) themeBtn.textContent = themeLabel;

  const shellEl = shell.querySelector(".dashboard-shell");
  if (shellEl) shellEl.classList.toggle("dashboard-night", nightTheme);

  setHtml("db-upcoming", buildDashboardUpcomingMarkup(context.scheduleKey, context.upcomingBlocks));
  setHtml("db-streaks", buildDashboardStreakMarkup());
  setHtml("db-pending", buildDashboardPendingMarkup());
  setHtml("db-alerts", buildDashboardAlertsMarkup());
  setHtml("db-affirmation-ticker-wrap", buildAffirmationTickerMarkup());

  applyDashboardAvatars(shell);
  patchDashboardToast(shell);
  animateCounters(shell);
}

function patchDashboardToast(shell) {
  const slot = shell.querySelector("#db-toast-slot");
  if (slot) slot.innerHTML = buildDashboardToastMarkup();
}

function animateCounters(shell) {
  shell.querySelectorAll("[data-counter]").forEach(el => {
    const target = parseInt(el.dataset.counter, 10);
    const numEl = el.querySelector(".db-token-num");
    if (numEl) animateCounter(numEl, 0, target, 800);
  });
}

function getSummerWeek(date) {
  const nowMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  for (const w of (window.SCHEDULE_CONFIG?.weekRanges || [])) {
    const [sy,sm,sd] = w.start, [ey,em,ed] = w.end;
    if (nowMs >= new Date(sy,sm-1,sd).getTime() && nowMs <= new Date(ey,em-1,ed).getTime()) return w;
  }
  return null;
}

function getCurrentBlockIndex() {
  const now = new Date();
  const total = now.getHours() * 60 + now.getMinutes();
  const blocks = getDailyBlocks(now);
  let idx = null;
  for (let i = 0; i < blocks.length; i++) {
    if (total >= blocks[i].hour * 60 + blocks[i].min) idx = i;
  }
  return idx;
}

function toggleSchedule() {
  const panel = document.getElementById("schedule-panel");
  const btn = document.getElementById("schedule-toggle");
  if (!panel) return;
  const open = panel.style.display !== "none";
  if (!open) {
    // Close week view if open (mutual exclusion)
    const weekPanel = document.getElementById("week-panel");
    const weekBtn = document.getElementById("week-toggle");
    if (weekPanel) weekPanel.style.display = "none";
    if (weekBtn) weekBtn.classList.remove("active");
    renderSchedule();
  }
  panel.style.display = open ? "none" : "block";
  btn.classList.toggle("active", !open);
}

function toggleWeekView() {
  const panel = document.getElementById("week-panel");
  const btn = document.getElementById("week-toggle");
  if (!panel) return;
  const open = panel.style.display !== "none";
  if (!open) {
    // Close today's schedule if open (mutual exclusion)
    const schedPanel = document.getElementById("schedule-panel");
    const schedBtn = document.getElementById("schedule-toggle");
    if (schedPanel) schedPanel.style.display = "none";
    if (schedBtn) schedBtn.classList.remove("active");
    renderWeekView();
  }
  panel.style.display = open ? "none" : "block";
  btn.classList.toggle("active", !open);
}

function renderWeekView() {
  const el = document.getElementById("week-content");
  if (!el) return;

  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const days = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    days.push(d);
  }

  const html = days.map((date, idx) => {
    const dow = date.getDay();
    const dayKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    const isToday = idx === 0;
    const theme = (window.SCHEDULE_CONFIG?.dayThemes || {})[dow] || null;
    const blocks = getDailyBlocks(date);
    const week = getSummerWeek(date);

    const dayLabel = isToday ? "Today" : DAY_NAMES[dow];
    const dateStr = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;

    const themeColor = theme?.color || "#f0f4f8";
    const themeEmoji = theme?.emoji || "🛋️";
    const themeName = theme?.name || "Free Day";

    const summary = getScheduleSummaryForStatuses(appState.scheduleStatuses, dayKey);

    const blocksHtml = blocks.length === 0
      ? `<p class="week-day-empty">No schedule blocks for this day.</p>`
      : blocks.map(b => `
          <div class="week-block">
            <span class="week-block-time">${escapeHtml(b.time)}</span>
            <span class="week-block-emoji">${b.emoji}</span>
            <span class="week-block-label">${escapeHtml(b.label)}</span>
          </div>
        `).join("");

    const summaryPills = summary.total > 0
      ? `<div class="week-day-summary">
          <span class="schedule-summary-pill schedule-summary-done">✓ ${summary.done}</span>
          <span class="schedule-summary-pill schedule-summary-progress">⟳ ${summary.inProgress}</span>
          <span class="schedule-summary-pill schedule-summary-missed">✗ ${summary.notDone}</span>
          <span class="schedule-summary-pill">${summary.unmarked} unmarked</span>
        </div>`
      : "";

    const weekBadge = week
      ? `<span class="week-day-week-badge">${week.emoji} ${escapeHtml(week.label)}</span>`
      : "";

    return `
      <div class="week-day-card${isToday ? " week-day-today" : ""}">
        <div class="week-day-header" style="background:${themeColor}">
          <div class="week-day-header-left">
            <span class="week-day-name">${escapeHtml(dayLabel)}</span>
            <span class="week-day-date">${escapeHtml(dateStr)}</span>
            ${weekBadge}
          </div>
          <div class="week-day-theme">
            <span class="week-day-theme-emoji">${themeEmoji}</span>
            <span class="week-day-theme-name">${escapeHtml(themeName)}</span>
          </div>
        </div>
        ${summaryPills}
        <div class="week-blocks">${blocksHtml}</div>
      </div>
    `;
  }).join("");

  el.innerHTML = `<div class="week-days">${html}</div>`;
}

function renderSchedule() {
  const el = document.getElementById("schedule-content");
  if (!el) return;

  const now = new Date();
  const dow = now.getDay();
  const theme = (window.SCHEDULE_CONFIG?.dayThemes || {})[dow] || null;
  const week = getSummerWeek(now);
  const currentIdx = getCurrentBlockIndex();

  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dateStr = `${DAY_NAMES[dow]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;
  const scheduleKey = getTodayScheduleKey(now);
  const summary = getScheduleSummary(scheduleKey);
  const canEditSchedule = isParentUser();

  const weekHtml = week
    ? `<div class="schedule-week">${week.emoji} <strong>${escapeHtml(week.label)}</strong><br><span>${escapeHtml(week.note)}</span></div>`
    : "";

  const themeHtml = theme
    ? `<div class="schedule-theme-header" style="background:${theme.color}">
        <div class="schedule-theme-emoji">${theme.emoji}</div>
        <div>
          <div class="schedule-theme-name">${escapeHtml(theme.name)}</div>
          <div class="schedule-theme-date">${escapeHtml(dateStr)}</div>
        </div>
      </div>`
    : `<div class="schedule-theme-header">
        <div class="schedule-theme-emoji">🛋️</div>
        <div>
          <div class="schedule-theme-name">Weekend — Free Time!</div>
          <div class="schedule-theme-date">${escapeHtml(dateStr)}</div>
        </div>
      </div>`;

  const suggestedChores = theme
    ? theme.chores.map(id => getChores().find(c => c.id === id)).filter(Boolean)
    : [];
  const choreHtml = suggestedChores.length > 0
    ? `<div class="schedule-chores">
        <div class="schedule-chores-label">✨ Chores that fit today</div>
        <div class="schedule-chore-chips">${suggestedChores.map(c =>
          `<button class="chore-chip" onclick="submitChore('${c.id}')">${escapeHtml(c.label)} +${c.amount} ☀️</button>`
        ).join("")}</div>
      </div>`
    : "";

  const summaryHtml = `<div class="schedule-summary">
    <div class="schedule-summary-title">Today's Follow-Through</div>
    <div class="schedule-summary-stats">
      <span class="schedule-summary-pill schedule-summary-done">Done ${summary.done}</span>
      <span class="schedule-summary-pill schedule-summary-progress">In Progress ${summary.inProgress}</span>
      <span class="schedule-summary-pill schedule-summary-missed">Missed ${summary.notDone}</span>
      <span class="schedule-summary-pill">Unmarked ${summary.unmarked}</span>
    </div>
    <div class="schedule-summary-note">${summary.done} of ${summary.total} blocks completed today.</div>
  </div>`;

  const blocksHtml = getDailyBlocks(now).map((b, i) => {
    let desc = b.desc;
    if (!desc && theme) desc = b.label.includes("Morning") ? theme.morning : theme.afternoon;
    const now = i === currentIdx;
    const status = getScheduleStatus(scheduleKey, b.id);
    const statusText = status ? SCHEDULE_STATUS_LABELS[status] : "No status yet";
    const statusClass = status ? ` schedule-block-${status}` : "";
    const actionsHtml = canEditSchedule
      ? `<div class="schedule-status-actions">
          <button type="button" class="schedule-status-btn${status === "not-done" ? " active" : ""}" onclick="setScheduleBlockStatus('${scheduleKey}', '${b.id}', 'not-done')">Not Done</button>
          <button type="button" class="schedule-status-btn${status === "in-progress" ? " active" : ""}" onclick="setScheduleBlockStatus('${scheduleKey}', '${b.id}', 'in-progress')">In Progress</button>
          <button type="button" class="schedule-status-btn${status === "done" ? " active" : ""}" onclick="setScheduleBlockStatus('${scheduleKey}', '${b.id}', 'done')">Done</button>
        </div>`
      : `<div class="schedule-status-note">Mom or Dad updates the schedule status.</div>`;
    return `<div class="schedule-block${now ? " schedule-block-now" : ""}${statusClass}">
      <div class="schedule-block-time">${escapeHtml(b.time)}</div>
      <div class="schedule-block-emoji">${b.emoji}</div>
      <div class="schedule-block-info">
        <div class="schedule-block-label">${escapeHtml(b.label)}${now ? ' <span class="schedule-now-pill">NOW</span>' : ""}</div>
        ${desc ? `<div class="schedule-block-desc">${escapeHtml(desc)}</div>` : ""}
        <div class="schedule-block-status-row">
          <span class="schedule-status-tag${status ? ` schedule-status-${status}` : ""}">${escapeHtml(statusText)}</span>
          ${actionsHtml}
        </div>
      </div>
    </div>`;
  }).join("");

  el.innerHTML = weekHtml + themeHtml + choreHtml + summaryHtml + `<div class="schedule-blocks">${blocksHtml}</div>`;
}

// --- API client ---
function getToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_ROLE_KEY);
}

function getStoredRole() {
  return localStorage.getItem(AUTH_ROLE_KEY);
}

function setStoredRole(role) {
  localStorage.setItem(AUTH_ROLE_KEY, role);
}

function resetAppState() {
  appState = {
    tokens: Object.fromEntries(familyConfig.kidRoles.map(r => [r, 0])),
    pending: [],
    approved: [],
    denied: [],
    streaks: {},
    avatars: {},
    chores: [],
    scheduleStatuses: {},
    spendNotifications: [],
    affirmations: [],
    rewards: [],
    active_eggs: [],
    egg_accepts: [],
    egg_challenges_meta: {},
    egg_challenges_pending: [],
  };
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json"
  };
  if (token) {
    headers["Authorization"] = "Bearer " + token;
  }
  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  const response = await fetch(path, { ...options, headers });

  if (response.status === 401) {
    logout();
    showMessage("Session expired. Sign in again.", "#e74c3c");
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Request failed (${response.status}): ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function refreshState(options = {}) {
  const previousSnapshot = buildDashboardSnapshot(appState);
  const endpoint = currentUser ? "/api/state" : "/api/dashboard";
  const state = await apiFetch(endpoint);
  appState = {
    tokens: state.tokens || Object.fromEntries(familyConfig.kidRoles.map(r => [r, 0])),
    pending: state.pending || [],
    approved: state.approved || [],
    denied: state.denied || [],
    streaks: state.streaks || {},
    avatars: appState.avatars || {},
    chores: state.chores || [],
    scheduleStatuses: state.scheduleStatuses || {},
    spendNotifications: state.spendNotifications || [],
    affirmations: state.affirmations || [],
    rewards: state.rewards || [],
    active_eggs: state.active_eggs || [],
    egg_accepts: state.egg_accepts || [],
    egg_challenges_meta: state.egg_challenges_meta || {},
    egg_challenges_pending: state.egg_challenges_pending || [],
    egg_challenges_approved: state.egg_challenges_approved || [],
  };
  announceDashboardChanges(previousSnapshot, buildDashboardSnapshot(appState), options);
  return appState;
}

// ---------- Affirmations ----------

function getAffirmations() {
  return appState.affirmations || [];
}

let tickerTimeout = null;
let tickerIndex = 0;
let tickerPrevCount = 0;

function calcTickerDuration(textLength) {
  return Math.min(20000, Math.max(8000, textLength * 60));
}

function buildAffirmationTickerMarkup() {
  if (tickerTimeout) { clearTimeout(tickerTimeout); tickerTimeout = null; }

  const items = getAffirmations();
  if (!items.length) { tickerIndex = 0; tickerPrevCount = 0; return ""; }

  // New items are prepended — show them first
  if (items.length > tickerPrevCount) {
    tickerIndex = 0;
  }
  tickerPrevCount = items.length;

  const startIdx = tickerIndex % items.length;

  const slidesHtml = items.map((a, i) =>
    `<div class="affirmation-ticker-slide${i === startIdx ? " active" : ""}" data-index="${i}">
      <strong class="affirmation-ticker-author">${escapeHtml(a.from)} → ${escapeHtml(a.to)}</strong>
      <span class="affirmation-ticker-text">${escapeHtml(a.text)}</span>
    </div>`
  ).join("");

  if (items.length > 1) {
    tickerTimeout = setTimeout(advanceTicker, calcTickerDuration(items[startIdx].text.length));
  }

  return `<div class="affirmation-ticker" id="db-affirmation-ticker">
    <div class="affirmation-ticker-viewport">${slidesHtml}</div>
  </div>`;
}

function advanceTicker() {
  tickerIndex++;

  const items = getAffirmations();
  if (items.length < 2) return;

  const viewport = document.querySelector("#db-affirmation-ticker .affirmation-ticker-viewport");
  if (!viewport) return;
  const slides = viewport.querySelectorAll(".affirmation-ticker-slide");
  if (slides.length < 2) return;

  const current = viewport.querySelector(".affirmation-ticker-slide.active");
  if (!current) return;

  const nextIdx = (parseInt(current.dataset.index) + 1) % slides.length;
  const next = viewport.querySelector(`[data-index="${nextIdx}"]`);
  if (!next) return;

  current.classList.remove("active");
  current.classList.add("exit");
  next.classList.add("active");

  setTimeout(() => current.classList.remove("exit"), 600);

  tickerTimeout = setTimeout(advanceTicker, calcTickerDuration(items[nextIdx].text.length));
}

function showAffirmationModal() {
  const existing = document.getElementById("affirmation-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "affirmation-modal";
  modal.className = "affirmation-modal-overlay";
  modal.innerHTML = `
    <div class="affirmation-modal-box">
      <h3>💛 Write an Affirmation</h3>
      <p class="affirmation-modal-hint">Say something kind. First 3 each day earn 3 tokens.</p>
      <select id="affirmation-to" class="affirmation-modal-select">
        <option value="">— Who is this for? —</option>
        ${familyConfig.allRoles.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("")}
      </select>
      <textarea id="affirmation-text" class="affirmation-modal-textarea" placeholder="I really appreciated when you…" rows="4" maxlength="400"></textarea>
      <div class="affirmation-modal-actions">
        <button type="button" class="secondary-btn" onclick="document.getElementById('affirmation-modal').remove()">Cancel</button>
        <button type="button" class="primary-btn" id="affirmation-submit-btn" onclick="submitAffirmation()">Send 💛</button>
      </div>
      <p id="affirmation-modal-error" class="affirmation-modal-error"></p>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById("affirmation-text").focus();
}

async function submitAffirmation() {
  const toRole = document.getElementById("affirmation-to").value;
  const text = document.getElementById("affirmation-text").value.trim();
  const errEl = document.getElementById("affirmation-modal-error");
  const btn = document.getElementById("affirmation-submit-btn");

  if (!toRole) { errEl.textContent = "Pick who this is for."; return; }
  if (!text) { errEl.textContent = "Write something kind first."; return; }

  btn.disabled = true;
  btn.textContent = "Sending…";
  errEl.textContent = "";

  try {
    await apiFetch("/api/affirmation", { method: "POST", body: JSON.stringify({ toRole, text }) });
    document.getElementById("affirmation-modal").remove();
    await refreshState();
    renderDashboardMode();
    showDashboardAlert(`💛 Affirmation sent to ${toRole}!`, "#f59e0b");
  } catch (err) {
    errEl.textContent = "Couldn't send. Try again.";
    btn.disabled = false;
    btn.textContent = "Send 💛";
  }
}

// ---------- Rewards ----------

function getRewards() {
  return appState.rewards && appState.rewards.length ? appState.rewards : [];
}

function buildRewardsAdminMarkup() {
  const rewards = getRewards();
  const rows = rewards.map(r => `
    <div class="admin-reward-row" data-id="${escapeHtml(r.id)}">
      <div class="admin-chore-fields">
        <div class="admin-field">
          <label>Label</label>
          <input type="text" class="reward-label-input" value="${escapeHtml(r.label)}" maxlength="60" />
        </div>
        <div class="admin-field">
          <label>Cost (☀️)</label>
          <input type="number" class="reward-cost-input" min="1" step="1" value="${r.cost}" />
        </div>
      </div>
      <button type="button" class="ghost-btn" onclick="removeRewardRow('${escapeHtml(r.id)}')">Remove</button>
    </div>
  `).join("");

  return `
    <div id="reward-admin-list">${rows || "<p>No rewards yet.</p>"}</div>
    <div class="admin-actions">
      <button type="button" class="secondary-btn" onclick="addRewardRow()">Add Reward</button>
      <button type="button" onclick="saveRewards()">Save Rewards</button>
    </div>
  `;
}

function renderRewardsAdmin() {
  let section = document.getElementById("dad-rewards-admin");
  if (!section) {
    const dadView = document.getElementById("parent-view");
    if (!dadView) return;
    section = document.createElement("section");
    section.id = "dad-rewards-admin";
    dadView.appendChild(section);
  }
  section.innerHTML = `<h2>🎁 Rewards Admin</h2>${buildRewardsAdminMarkup()}`;
}

function addRewardRow() {
  const list = document.getElementById("reward-admin-list");
  if (!list) return;
  const id = "reward-" + Date.now();
  const row = document.createElement("div");
  row.className = "admin-reward-row";
  row.dataset.id = id;
  row.innerHTML = `
    <div class="admin-chore-fields">
      <div class="admin-field">
        <label>Label</label>
        <input type="text" class="reward-label-input" value="" maxlength="60" placeholder="e.g. 🎮 $10 Robux" />
      </div>
      <div class="admin-field">
        <label>Cost (☀️)</label>
        <input type="number" class="reward-cost-input" min="1" step="1" value="100" />
      </div>
    </div>
    <button type="button" class="ghost-btn" onclick="removeRewardRow('${id}')">Remove</button>
  `;
  if (list.querySelector("p")) list.innerHTML = "";
  list.appendChild(row);
}

function removeRewardRow(id) {
  const row = document.querySelector(`.admin-reward-row[data-id="${id}"]`);
  if (row) row.remove();
}

async function saveRewards() {
  const rows = Array.from(document.querySelectorAll(".admin-reward-row"));
  const rewards = rows.map(row => ({
    id: row.dataset.id,
    label: row.querySelector(".reward-label-input").value.trim(),
    cost: parseInt(row.querySelector(".reward-cost-input").value, 10),
  })).filter(r => r.label && r.cost > 0);

  if (rewards.length === 0) {
    showMessage("Add at least one reward.", "#e74c3c");
    return;
  }

  try {
    await apiFetch("/api/rewards", { method: "POST", body: JSON.stringify({ rewards }) });
    await refreshState();
    renderRewardsAdmin();
    renderKidRewards();
    showMessage("Rewards saved! ✅");
  } catch {
    showMessage("Could not save rewards. Try again.", "#e74c3c");
  }
}

// Override the hardcoded rewards panel in kid view with dynamic rewards from state
function renderKidRewards() {
  const panel = document.getElementById("rewards-panel");
  if (!panel) return;
  const rewards = getRewards();
  if (!rewards.length) return;

  const items = rewards.map(r => `
    <div class="reward-item">
      <span>${escapeHtml(r.label)}</span>
      <button onclick="redeemReward('${r.id}')">
        ${r.cost} ☀️
      </button>
    </div>
  `).join("");
  panel.innerHTML = `<h2>Cash Out Rewards</h2>${items}`;
}

async function setScheduleBlockStatus(dayKey, blockId, status) {
  if (!isParentUser()) {
    showMessage("Only Mom or Dad can update the schedule status.", "#e74c3c");
    return;
  }

  try {
    const previousSnapshot = buildDashboardSnapshot(appState);
    const result = await apiFetch("/api/schedule-status", {
      method: "POST",
      body: JSON.stringify({ dayKey, blockId, status })
    });
    appState.scheduleStatuses = result.scheduleStatuses || {};
    announceDashboardChanges(previousSnapshot, buildDashboardSnapshot(appState));
  } catch (err) {
    showMessage("Could not update schedule status. Try again.", "#e74c3c");
    return;
  }

  renderSchedule();
  renderParentView();
}

async function loadPublicAvatars() {
  try {
    const state = await apiFetch("/api/avatars");
    appState.avatars = state.avatars || {};
    renderRoleAvatars();
    if (currentUser) {
      renderAvatarUI();
    }
  } catch {
    appState.avatars = {};
    renderRoleAvatars();
  }
}

function getTokens(user) {
  return appState.tokens[user] || 0;
}

function getPending() {
  return appState.pending;
}

function getApproved() {
  return appState.approved;
}

function getDenied() {
  return appState.denied;
}

function getStreaks() {
  return appState.streaks;
}

function getChores() {
  return Array.isArray(appState.chores) ? appState.chores : [];
}

function getAvatar(user) {
  return appState.avatars[user] || null;
}

function getSpendNotifications() {
  return appState.spendNotifications;
}

function getDefaultAvatar(user) {
  return DEFAULT_AVATARS[user] || "🙂";
}

function renderAvatarElement(element, user) {
  if (!element) return;

  const avatar = getAvatar(user);
  if (avatar) {
    element.style.backgroundImage = `url("${avatar}")`;
    element.textContent = "";
  } else {
    element.style.backgroundImage = "none";
    element.textContent = getDefaultAvatar(user);
  }
}

function renderRoleAvatars() {
  document.querySelectorAll(".role-btn").forEach(btn => {
    const avatarSlot = btn.querySelector(".role-btn-avatar");
    renderAvatarElement(avatarSlot, btn.dataset.role);
  });
}

function renderAvatarUI() {
  if (!currentUser) return;

  renderAvatarElement(document.getElementById("header-avatar"), currentUser);
  renderAvatarElement(document.getElementById("avatar-preview"), currentUser);

  const clearButton = document.getElementById("clear-avatar-btn");
  const help = document.getElementById("avatar-help");
  const hasAvatar = Boolean(getAvatar(currentUser));

  clearButton.disabled = !hasAvatar;
  help.textContent = hasAvatar
    ? "Your current avatar is saved. Choose another photo any time."
    : "Upload a photo or image file to use as your avatar.";
}

async function fileToAvatarDataUrl(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("invalid_type");
  }
  if (file.size > MAX_AVATAR_FILE_BYTES) {
    throw new Error("file_too_large");
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  return resizeImageDataUrl(rawDataUrl, AVATAR_OUTPUT_SIZE);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

function resizeImageDataUrl(source, size) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;

      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("canvas_unavailable"));
        return;
      }

      const cropSize = Math.min(image.width, image.height);
      const startX = (image.width - cropSize) / 2;
      const startY = (image.height - cropSize) / 2;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size, size);
      context.drawImage(image, startX, startY, cropSize, cropSize, 0, 0, size, size);

      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    image.onerror = () => reject(new Error("image_load_failed"));
    image.src = source;
  });
}

async function saveAvatar(avatarDataUrl) {
  try {
    const result = await apiFetch("/api/avatar", {
      method: "POST",
      body: JSON.stringify({ avatarDataUrl })
    });
    appState.avatars = result && result.avatars ? result.avatars : {};
    renderRoleAvatars();
    renderAvatarUI();
    showMessage(avatarDataUrl ? "Avatar updated." : "Avatar removed.");
  } catch {
    showMessage("Could not save avatar. Try another photo.", "#e74c3c");
  }
}

async function handleAvatarFileChange(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";

  if (!file || !currentUser) {
    return;
  }

  try {
    const avatarDataUrl = await fileToAvatarDataUrl(file);
    await saveAvatar(avatarDataUrl);
  } catch (err) {
    if (err && err.message === "file_too_large") {
      showMessage("That file is too large. Try a smaller photo.", "#e74c3c");
      return;
    }
    showMessage("Pick an image file to use as your avatar.", "#e74c3c");
  }
}

async function clearAvatar() {
  if (!currentUser || !getAvatar(currentUser)) {
    return;
  }

  await saveAvatar(null);
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayKeyUtc() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDayKey(dayKey, amount) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const shifted = new Date(year, month - 1, day + amount);
  const shiftedYear = shifted.getFullYear();
  const shiftedMonth = String(shifted.getMonth() + 1).padStart(2, "0");
  const shiftedDay = String(shifted.getDate()).padStart(2, "0");
  return `${shiftedYear}-${shiftedMonth}-${shiftedDay}`;
}

function getStreakRecord(user, streakId) {
  const streaks = getStreaks();
  const userStreaks = streaks[user] || {};
  const record = userStreaks[streakId] || {};

  return {
    current: record.current || 0,
    best: record.best || 0,
    lastApprovedDay: record.lastApprovedDay || null
  };
}

function getPendingStreakSubmission(user, streakId, dayKey = getTodayKey()) {
  return getPending().find(item => item.type === "streak" && item.user === user && item.id === streakId && item.dayKey === dayKey);
}

function getPendingVacationHoldSubmission(user, streakId, dayKey = getTodayKey()) {
  return getPending().find(item => item.type === "streak" && item.user === user && item.id === streakId && item.dayKey === dayKey && item.mode === "vacation-hold");
}

function buildStreakStatus(record, streakId) {
  const config = STREAK_DEFS[streakId];
  const streakCount = record.current;
  const bestCount = record.best;
  const currentLabel = `Current ${streakCount} day${streakCount === 1 ? "" : "s"}`;
  const bestLabel = `Best ${bestCount} day${bestCount === 1 ? "" : "s"}`;

  if (config.goal > 0 && streakCount >= config.goal) {
    return `${currentLabel} · ${bestLabel} · Goal hit`;
  }

  if (config.goal > 0) {
    const daysLeft = Math.max(config.goal - streakCount, 0);
    return `${currentLabel} · ${bestLabel} · ${daysLeft} to goal`;
  }

  return `${currentLabel} · ${bestLabel}`;
}

function buildStreakBoardMarkup() {
  const players = familyConfig.kidRoles;
  return players.map(player => {
    const items = Object.entries(STREAK_DEFS).map(([streakId, config]) => {
      const record = getStreakRecord(player, streakId);
      return `
        <div class="notification-item">
          <span><strong>${player}</strong> · ${config.label}</span>
          <small>${buildStreakStatus(record, streakId)}</small>
        </div>
      `;
    }).join("");

    return `
      <div class="streak-board-group">
        ${items}
      </div>
    `;
  }).join("");
}

function createChoreId(label) {
  const normalized = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  if (normalized) {
    return normalized;
  }

  return `chore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function findChore(id) {
  return getChores().find(chore => chore.id === id) || null;
}

function renderChoreList() {
  const list = document.getElementById("chore-list");
  if (!list) return;

  const chores = getChores();
  if (chores.length === 0) {
    list.innerHTML = "<p>No chores configured yet.</p>";
    return;
  }

  list.innerHTML = chores.map(chore => `
    <div class="chore-item" data-id="${chore.id}" data-amount="${chore.amount}">
      <span>${escapeHtml(chore.label)}</span>
      <button onclick="submitChore('${chore.id}')">Submit +${chore.amount} ☀️</button>
    </div>
  `).join("");
}

function buildChoreAdminMarkup() {
  const chores = getChores();
  if (chores.length === 0) {
    return "<p>No chores yet. Add one below.</p>";
  }

  return chores.map(chore => `
    <div class="admin-chore-row" data-id="${chore.id}" ondragover="allowChoreDrop(event)" ondrop="dropChoreAt(event, '${chore.id}')">
      <div class="drag-handle" draggable="true" ondragstart="startChoreDrag(event, '${chore.id}')" ondragend="endChoreDrag()" title="Drag to reorder">↕</div>
      <div class="admin-chore-fields">
        <div class="admin-field">
          <label>Name</label>
          <input type="text" class="chore-name-input" value="${escapeHtml(chore.label)}" maxlength="60" />
        </div>
        <div class="admin-field">
          <label>Points</label>
          <input type="number" class="chore-amount-input" min="1" step="1" value="${chore.amount}" />
        </div>
      </div>
      <button type="button" class="ghost-btn" onclick="removeChoreDraft('${chore.id}')">Remove</button>
    </div>
  `).join("");
}

function renderChoreAdmin() {
  const admin = document.getElementById("parent-chore-admin");
  if (!admin) return;
  admin.innerHTML = buildChoreAdminMarkup();
}

function startChoreDrag(event, id) {
  draggedChoreId = id;
  syncAdminDraftFromDom();

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }
}

function allowChoreDrop(event) {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
}

function dropChoreAt(event, targetId) {
  event.preventDefault();

  const sourceId = draggedChoreId || (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
  if (!sourceId || sourceId === targetId) {
    endChoreDrag();
    return;
  }

  syncAdminDraftFromDom();
  const chores = getChores().slice();
  const sourceIndex = chores.findIndex(chore => chore.id === sourceId);
  const targetIndex = chores.findIndex(chore => chore.id === targetId);

  if (sourceIndex === -1 || targetIndex === -1) {
    endChoreDrag();
    return;
  }

  const [movedChore] = chores.splice(sourceIndex, 1);
  const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  chores.splice(insertionIndex, 0, movedChore);

  appState.chores = chores;
  renderChoreAdmin();
  endChoreDrag();
}

function endChoreDrag() {
  draggedChoreId = null;
}

function syncAdminDraftFromDom() {
  const rows = Array.from(document.querySelectorAll("#parent-chore-admin .admin-chore-row"));
  appState.chores = rows.map(row => {
    const nameInput = row.querySelector(".chore-name-input");
    const amountInput = row.querySelector(".chore-amount-input");
    const label = nameInput ? nameInput.value.trim() : "";
    const amount = amountInput ? parseInt(amountInput.value, 10) : 0;
    const existingId = row.dataset.id || createChoreId(label);
    row.dataset.id = existingId;

    return {
      id: existingId,
      label,
      amount,
    };
  });
}

function addChoreDraft() {
  syncAdminDraftFromDom();
  appState.chores = getChores().concat({
    id: createChoreId(""),
    label: "",
    amount: 10,
  });
  renderChoreAdmin();
}

function removeChoreDraft(id) {
  syncAdminDraftFromDom();
  appState.chores = getChores().filter(chore => chore.id !== id);
  renderChoreAdmin();
}

async function saveChores() {
  if (!isParentUser()) {
    return;
  }

  syncAdminDraftFromDom();

  const chores = getChores().map(chore => ({
    id: chore.id || createChoreId(chore.label),
    label: String(chore.label || "").trim(),
    amount: Number(chore.amount),
  }));

  if (chores.length === 0) {
    showMessage("Add at least one chore.", "#e74c3c");
    return;
  }

  if (chores.some(chore => !chore.label || !Number.isInteger(chore.amount) || chore.amount <= 0)) {
    showMessage("Each chore needs a name and whole-number points.", "#e74c3c");
    return;
  }

  const ids = new Set();
  for (const chore of chores) {
    if (ids.has(chore.id)) {
      showMessage("Two chores ended up with the same ID. Rename one and try again.", "#e74c3c");
      return;
    }
    ids.add(chore.id);
  }

  try {
    const result = await apiFetch("/api/chores", {
      method: "POST",
      body: JSON.stringify({ chores })
    });
    appState.chores = result.chores || chores;
  } catch (err) {
    showMessage("Could not save chores. Try again.", "#e74c3c");
    return;
  }

  renderChoreList();
  renderChoreAdmin();
  renderParentView();
  showMessage("Chores updated.");
}

// --- Login ---
async function selectRole(role) {
  selectedRole = role;
  const input = document.getElementById("login-password");
  const subtitle = document.getElementById("login-subtitle");
  const label = document.getElementById("password-label");
  const submit = document.getElementById("auth-submit");
  const error = document.getElementById("login-error");

  document.querySelectorAll(".role-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.role === role);
  });

  submit.disabled = true;
  submit.textContent = "...";
  input.value = "";
  error.style.display = "none";

  let exists = false;
  try {
    const result = await apiFetch("/api/auth/check", {
      method: "POST",
      body: JSON.stringify({ role })
    });
    exists = Boolean(result && result.exists);
  } catch (err) {
    error.textContent = "Could not reach server. Try again.";
    error.style.display = "block";
    submit.disabled = true;
    submit.textContent = "Continue";
    return;
  }

  submit.disabled = false;

  if (exists) {
    setupStep = 3;
    subtitle.textContent = `${role}: enter your password to sign in.`;
    label.textContent = "Password";
    submit.textContent = "Sign In";
  } else {
    setupStep = 1;
    pendingPassword = "";
    subtitle.textContent = `${role}: choose your password.`;
    label.textContent = "Choose password";
    submit.textContent = "Continue";
  }

  input.focus();
}

async function handleAuthSubmit() {
  const input = document.getElementById("login-password");
  const subtitle = document.getElementById("login-subtitle");
  const label = document.getElementById("password-label");
  const submit = document.getElementById("auth-submit");
  const error = document.getElementById("login-error");
  const entered = input.value.trim();

  if (!selectedRole) {
    error.textContent = "Choose your character first.";
    error.style.display = "block";
    return;
  }

  if (!entered) {
    error.textContent = "Type your password.";
    error.style.display = "block";
    return;
  }

  error.style.display = "none";

  if (setupStep === 1) {
    pendingPassword = entered;
    input.value = "";
    setupStep = 2;
    subtitle.textContent = `${selectedRole}: type it one more time to lock it in.`;
    label.textContent = "Confirm password";
    return;
  }

  if (setupStep === 2) {
    if (entered !== pendingPassword) {
      pendingPassword = "";
      setupStep = 1;
      input.value = "";
      subtitle.textContent = `${selectedRole}: passwords did not match. Choose password again.`;
      label.textContent = "Choose password";
      error.textContent = "Passwords did not match.";
      error.style.display = "block";
      return;
    }

    const originalText = submit.textContent;
    submit.disabled = true;
    submit.textContent = "...";

    try {
      await apiFetch("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ role: selectedRole, password: entered })
      });
    } catch (err) {
      submit.disabled = false;
      submit.textContent = originalText;
      error.textContent = "Could not save password. Try again.";
      error.style.display = "block";
      return;
    }

    pendingPassword = "";
    setupStep = 3;
    input.value = "";
    submit.disabled = false;
    subtitle.textContent = `${selectedRole}: password locked. Enter it again to sign in.`;
    label.textContent = "Password";
    submit.textContent = "Sign In";
    return;
  }

  if (setupStep === 3) {
    const originalText = submit.textContent;
    submit.disabled = true;
    submit.textContent = "...";

    let result;
    try {
      result = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ role: selectedRole, password: entered })
      });
    } catch (err) {
      submit.disabled = false;
      submit.textContent = originalText;
      error.textContent = "Wrong password for that character.";
      error.style.display = "block";
      input.value = "";
      input.focus();
      return;
    }

    if (!result || !result.token) {
      submit.disabled = false;
      submit.textContent = originalText;
      error.textContent = "Wrong password for that character.";
      error.style.display = "block";
      input.value = "";
      input.focus();
      return;
    }

    setToken(result.token);
    setStoredRole(selectedRole);
    input.value = "";

    try {
      await login(selectedRole);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = originalText;
      error.textContent = "Could not load your data. Try again.";
      error.style.display = "block";
      return;
    }
  }
}

function resetAuthUI() {
  selectedRole = null;
  setupStep = 0;
  pendingPassword = "";

  const input = document.getElementById("login-password");
  const subtitle = document.getElementById("login-subtitle");
  const label = document.getElementById("password-label");
  const submit = document.getElementById("auth-submit");
  const error = document.getElementById("login-error");

  subtitle.textContent = "Click your character first.";
  label.textContent = "Password";
  submit.textContent = "Continue";
  submit.disabled = true;
  input.value = "";
  error.style.display = "none";

  document.querySelectorAll(".role-btn").forEach(btn => btn.classList.remove("active"));

  input.blur();
}

async function login(user) {
  currentUser = user;

  await refreshState({ silent: true });

  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "block";
  document.getElementById("logged-in-as").textContent = `Signed in as ${user}`;
  renderRoleAvatars();
  renderAvatarUI();
  renderChoreList();
  renderSchedule();

  if (isParentUser(user)) {
    document.getElementById("parent-view").style.display = "block";
    document.getElementById("kid-view").style.display = "none";
    document.getElementById("wallet").style.display = "none";
    renderParentView();
    setDashboardMode(getStoredDashboardMode());
  } else {
    document.getElementById("kid-view").style.display = "block";
    document.getElementById("parent-view").style.display = "none";
    document.getElementById("wallet").style.display = "";
    setDashboardMode(false);
    document.getElementById("token-count").textContent = getTokens(user);
    document.getElementById("chores-panel").style.display = "none";
    document.getElementById("chores-toggle").textContent = "Chores";
    document.getElementById("rewards-panel").style.display = "none";
    document.getElementById("rewards-toggle").textContent = "Cash Out";
    renderKidView();
  }
}

function logout() {
  setDashboardMode(false);
  currentUser = null;
  clearToken();
  resetAppState();
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app").style.display = "none";
  document.getElementById("chores-panel").style.display = "none";
  document.getElementById("chores-toggle").textContent = "Chores";
  document.getElementById("rewards-panel").style.display = "none";
  document.getElementById("rewards-toggle").textContent = "Cash Out";
  resetAuthUI();
  loadPublicAvatars();
}

function toggleChores() {
  const panel = document.getElementById("chores-panel");
  const toggle = document.getElementById("chores-toggle");
  const isOpen = panel.style.display === "block";

  panel.style.display = isOpen ? "none" : "block";
  toggle.textContent = isOpen ? "Chores" : "Hide Chores";
}

function toggleRewards() {
  const panel = document.getElementById("rewards-panel");
  const toggle = document.getElementById("rewards-toggle");
  const isOpen = panel.style.display === "block";

  panel.style.display = isOpen ? "none" : "block";
  toggle.textContent = isOpen ? "Cash Out" : "Hide Cash Out";
  if (!isOpen) renderKidRewards();
}

async function redeemReward(rewardId) {
  if (!currentUser || isParentUser()) {
    return;
  }

  const reward = getRewards().find(item => item.id === rewardId);
  if (!reward) {
    showMessage("That reward is no longer available.", "#e74c3c");
    return;
  }

  const cost = reward.cost;
  const rewardName = reward.label;

  const balance = getTokens(currentUser);
  if (balance < cost) {
    showMessage(`Not enough Summer Tokens. Need ${cost - balance} more.`, "#e74c3c");
    return;
  }

  let result;
  try {
    result = await apiFetch("/api/spend", {
      method: "POST",
      body: JSON.stringify({ rewardId })
    });
    await refreshState();
  } catch (err) {
    showMessage("Could not redeem reward. Try again.", "#e74c3c");
    return;
  }

  document.getElementById("token-count").textContent = getTokens(currentUser);
  const redeemedReward = result && result.reward ? result.reward : reward;
  showMessage(`Redeemed ${redeemedReward.label} for ${redeemedReward.cost} Summer Tokens.`);
}

// --- Kid View ---
function renderKidView() {
  const pending = getPending();
  const approved = getApproved();
  const denied = getDenied();
  const todayKey = getTodayKey();
  const streakBoard = document.getElementById("kid-streak-board");
  const adHocStatus = document.getElementById("ad-hoc-chore-status");

  renderChoreList();

  document.querySelectorAll(".chore-item").forEach(item => {
    const id = item.dataset.id;
    if (!id) return;
    const btn = item.querySelector("button");
    const key = `${currentUser}:${id}:${todayKey}`;

    if (approved.includes(key)) {
      btn.disabled = true;
      btn.textContent = "✅ Approved";
      btn.style.background = "#27ae60";
    } else if (pending.find(p => p.key === key)) {
      btn.disabled = true;
      btn.textContent = "⏳ Waiting...";
      btn.style.background = "#f39c12";
    } else if (denied.includes(key)) {
      btn.disabled = false;
      btn.textContent = `Resubmit +${item.dataset.amount} ☀️`;
      btn.style.background = "#e74c3c";
    }
  });

  document.querySelectorAll(".streak-item").forEach(item => {
    const streakId = item.dataset.streakId;
    const button = item.querySelector("button[data-streak-log-btn]") || item.querySelector("button");
    const vacationButton = item.querySelector("button[data-vacation-hold-btn]");
    const info = item.querySelector("small");
    const record = getStreakRecord(currentUser, streakId);
    const pendingSubmission = pending.find(entry => entry.type === "streak" && entry.user === currentUser && entry.id === streakId && entry.dayKey === todayKey);
    const pendingVacationHold = getPendingVacationHoldSubmission(currentUser, streakId, todayKey);
    const approvedToday = record.lastApprovedDay === todayKey;
    const supportsVacationHold = STREAK_DEFS[streakId]?.vacationHold === true;

    info.textContent = buildStreakStatus(record, streakId);

    if (vacationButton) {
      vacationButton.style.display = supportsVacationHold ? "inline-block" : "none";
    }

    if (approvedToday) {
      button.disabled = true;
      button.textContent = "✅ Logged Today";
      button.style.background = "#27ae60";
      if (vacationButton && supportsVacationHold) {
        vacationButton.disabled = true;
        vacationButton.textContent = "🏖️ Covered Today";
      }
    } else if (pendingSubmission) {
      button.disabled = true;
      button.textContent = pendingVacationHold ? "🏖️ Vacation Pending" : "⏳ Waiting...";
      button.style.background = "#f39c12";
      if (vacationButton && supportsVacationHold) {
        vacationButton.disabled = true;
        vacationButton.textContent = "🏖️ Waiting...";
      }
    } else {
      button.disabled = false;
      button.textContent = "Log Today";
      button.style.background = "#f9a825";
      if (vacationButton && supportsVacationHold) {
        vacationButton.disabled = false;
        vacationButton.textContent = "🏖️ Vacation Keep-Alive";
      }
    }
  });

  streakBoard.innerHTML = buildStreakBoardMarkup() || "<p>No streak progress yet.</p>";

  if (adHocStatus) {
    const adHocItems = pending.filter(item => item.type === "chore" && item.user === currentUser && item.isAdHoc);
    if (!adHocItems.length) {
      adHocStatus.innerHTML = "<p>No ad-hoc chore requests waiting right now.</p>";
    } else {
      adHocStatus.innerHTML = adHocItems.map(item => {
        const requestKey = item.key;
        const wasApproved = approved.includes(requestKey);
        const wasDenied = denied.includes(requestKey);
        const statusLabel = wasApproved ? "✅ Approved" : wasDenied ? "❌ Denied" : "⏳ Waiting for Mom or Dad";
        return `<div class="notification-item"><span>${escapeHtml(item.label)}</span><small>${statusLabel}</small></div>`;
      }).join("");
    }
  }

  // Easter Egg Challenges section
  const kidViewEl = document.getElementById("kid-view");
  let eggSection = document.getElementById("egg-challenges-section");
  if (!eggSection && kidViewEl) {
    eggSection = document.createElement("section");
    eggSection.id = "egg-challenges-section";
    kidViewEl.appendChild(eggSection);
  }
  if (eggSection) renderEggChallengesSection(eggSection);
  renderEggOverlay();

  // Inject affirmation section into kid view (not in index.html — kids built that)
  const kidView = document.getElementById("kid-view");
  let affirmSection = document.getElementById("kid-affirmation-section");
  if (!affirmSection && kidView) {
    affirmSection = document.createElement("section");
    affirmSection.id = "kid-affirmation-section";
    kidView.appendChild(affirmSection);
  }
  if (affirmSection) {
    const affirmationTodayKey = getTodayKeyUtc();
    const todayAffirmed = getAffirmations().filter(a => a.from === currentUser && a.dayKey === affirmationTodayKey).length;
    const creditRemaining = Math.max(0, 3 - todayAffirmed);
    affirmSection.innerHTML = `
      <h2>💛 Affirmations</h2>
      <p style="font-size:0.85rem;color:var(--muted,#888)">Say something kind. First 3 each day earn 3 tokens.</p>
      <button onclick="showAffirmationModal()" style="margin-bottom:8px">
        ${creditRemaining > 0 ? `💛 Write an Affirmation (${creditRemaining} credit remaining)` : "💛 Write an Affirmation (credit used up, keep being kind!)"}
      </button>
    `;
  }
}

async function submitChore(id) {
  const chore = findChore(id);
  if (!chore) {
    showMessage("That chore is no longer available.", "#e74c3c");
    return;
  }

  const key = `${currentUser}:${id}:${getTodayKey()}`;
  if (getPending().find(p => p.key === key)) return;

  const item = document.querySelector(`.chore-item[data-id="${id}"]`);
  const btn = item ? item.querySelector("button") : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Waiting...";
    btn.style.background = "#f39c12";
  }

  try {
    await apiFetch("/api/submit", {
      method: "POST",
      body: JSON.stringify({ item: { key, type: "chore", user: currentUser, id, amount: chore.amount, dayKey: getTodayKey() } })
    });
    await refreshState();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = `Submit +${chore.amount} ☀️`;
      btn.style.background = "";
    }
    showMessage("Could not submit chore. Try again.", "#e74c3c");
    return;
  }

  renderKidView();
  showMessage("Submitted! Waiting for Mom or Dad to approve. ⏳");
}

function buildAdHocChoreId(label) {
  return `adhoc-${String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34)}`;
}

function showAdHocChoreModal() {
  const existing = document.getElementById("ad-hoc-chore-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "ad-hoc-chore-modal";
  modal.className = "affirmation-modal-overlay";
  modal.innerHTML = `
    <div class="affirmation-modal-box">
      <h3>🧹 Request a Chore</h3>
      <p class="affirmation-modal-hint">Did something extra? Tell Mom or Dad what you did and they can choose the points.</p>
      <input id="ad-hoc-chore-label" class="affirmation-modal-textarea" maxlength="80" placeholder="Example: Cleaned the kitchen" />
      <div class="affirmation-modal-actions">
        <button type="button" class="secondary-btn" onclick="document.getElementById('ad-hoc-chore-modal').remove()">Cancel</button>
        <button type="button" class="primary-btn" id="ad-hoc-chore-submit-btn" onclick="submitAdHocChore()">Send Request</button>
      </div>
      <p id="ad-hoc-chore-error" class="affirmation-modal-error"></p>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById("ad-hoc-chore-label").focus();
}

async function submitAdHocChore() {
  if (!currentUser || isParentUser()) {
    return;
  }

  const input = document.getElementById("ad-hoc-chore-label");
  const error = document.getElementById("ad-hoc-chore-error");
  const button = document.getElementById("ad-hoc-chore-submit-btn");
  const label = input.value.trim();
  if (!label) {
    error.textContent = "Tell Mom or Dad what you did first.";
    return;
  }

  const todayKey = getTodayKey();
  const choreId = buildAdHocChoreId(label);
  const key = `${currentUser}:${choreId}:${todayKey}`;
  if (getPending().find(item => item.key === key)) {
    error.textContent = "That request is already waiting for approval.";
    return;
  }

  button.disabled = true;
  error.textContent = "";

  try {
    await apiFetch("/api/submit", {
      method: "POST",
      body: JSON.stringify({
        item: {
          key,
          type: "chore",
          user: currentUser,
          id: choreId,
          label,
          isAdHoc: true,
          dayKey: todayKey,
        }
      })
    });
    await refreshState();
  } catch (err) {
    button.disabled = false;
    error.textContent = "Could not send that request. Try again.";
    return;
  }

  document.getElementById("ad-hoc-chore-modal").remove();
  renderKidView();
  showMessage("Ad-hoc chore sent to Mom or Dad for points. ⏳");
}

async function submitStreak(streakId) {
  if (!currentUser || isParentUser()) {
    return;
  }

  const todayKey = getTodayKey();
  const record = getStreakRecord(currentUser, streakId);
  if (record.lastApprovedDay === todayKey) {
    showMessage("That streak is already counted for today.", "#e67e22");
    return;
  }

  if (getPendingStreakSubmission(currentUser, streakId, todayKey)) {
    showMessage("That streak is already waiting for approval.", "#e67e22");
    return;
  }

  const streakItem = {
    key: `${currentUser}:streak:${streakId}:${todayKey}`,
    type: "streak",
    user: currentUser,
    id: streakId,
    dayKey: todayKey
  };

  try {
    await apiFetch("/api/submit", {
      method: "POST",
      body: JSON.stringify({ item: streakItem })
    });
    await refreshState();
  } catch (err) {
    showMessage("Could not log streak. Try again.", "#e74c3c");
    return;
  }

  renderKidView();
  showMessage("Streak logged for today. Waiting for Mom or Dad to approve. ⏳");
}

async function requestVacationStreakHold(streakId) {
  if (!currentUser || isParentUser()) {
    return;
  }

  const todayKey = getTodayKey();
  const record = getStreakRecord(currentUser, streakId);
  if (record.lastApprovedDay === todayKey) {
    showMessage("That streak is already covered for today.", "#e67e22");
    return;
  }

  if (getPendingStreakSubmission(currentUser, streakId, todayKey)) {
    showMessage("That streak already has a request waiting for approval.", "#e67e22");
    return;
  }

  const streakItem = {
    key: `${currentUser}:streak:${streakId}:${todayKey}:vacation-hold`,
    type: "streak",
    user: currentUser,
    id: streakId,
    dayKey: todayKey,
    mode: "vacation-hold"
  };

  try {
    await apiFetch("/api/submit", {
      method: "POST",
      body: JSON.stringify({ item: streakItem })
    });
    await refreshState();
  } catch (err) {
    showMessage("Could not request a vacation keep-alive. Try again.", "#e74c3c");
    return;
  }

  renderKidView();
  showMessage("Vacation keep-alive requested. Waiting for Mom or Dad to approve. 🏖️");
}

function renderLoginButtons() {
  const container = document.getElementById("role-buttons");
  if (!container) return;
  container.innerHTML = familyConfig.allRoles.map(role => `
    <button class="role-btn" data-role="${escapeHtml(role)}" onclick="selectRole('${escapeHtml(role)}')">
      <span class="role-btn-avatar avatar-badge">${escapeHtml(getDefaultAvatar(role))}</span>
      <span>${escapeHtml(role)}</span>
    </button>
  `).join("");
}

function renderKidBalancesAndBank() {
  const balanceList = document.getElementById("kids-balances-list");
  const bankControls = document.getElementById("token-bank-controls");
  if (balanceList) {
    balanceList.innerHTML = familyConfig.kidRoles.map(kid => {
      const safeId = kid.toLowerCase().replace(/\s+/g, "-");
      return `<div class="chore-item"><span>${escapeHtml(getDefaultAvatar(kid))} ${escapeHtml(kid)}</span><strong id="kid-balance-${safeId}">0 ☀️</strong></div>`;
    }).join("");
  }
  if (bankControls) {
    bankControls.innerHTML = familyConfig.kidRoles.map(kid => {
      const safeId = kid.toLowerCase().replace(/\s+/g, "-");
      return `
        <div class="token-row">
          <span>${escapeHtml(kid)}</span>
          <input id="kid-adjust-${safeId}" type="number" min="1" step="1" value="10" />
          <button onclick="adjustTokens('${escapeHtml(kid)}', 1)">Deposit</button>
          <button class="danger-btn" onclick="adjustTokens('${escapeHtml(kid)}', -1)">Take Out</button>
        </div>`;
    }).join("");
  }
}

// --- Parent View ---
function renderParentView() {
  const pending = getPending();
  const list = document.getElementById("pending-list");
  const spendList = document.getElementById("spend-notification-list");
  const streakBoard = document.getElementById("parent-streak-board");

  updateDashboardToggle();

  if (pending.length === 0) {
    list.innerHTML = "<p>No pending approvals.</p>";
  } else {
    list.innerHTML = pending.map(p => {
      if (p.type === "egg_challenge") {
        const timeUsed = p.completed_at && p.accepted_at
          ? Math.round((p.completed_at - p.accepted_at) / 60000) : 0;
        const pct = p.time_limit_minutes ? timeUsed / p.time_limit_minutes : 1;
        const mx = pct <= 0.25 ? 2.0 : pct <= 0.50 ? 1.6 : pct <= 0.75 ? 1.4 : pct <= 1.00 ? 1.2 : 1.0;
        const award = Math.round((p.token_reward || 0) * mx);
        return `<div class="chore-item">
          <span>
            <strong>${escapeHtml(p.kid_role)}</strong>: 🥚 ${escapeHtml(p.challenge_title || "Challenge")}<br>
            <small style="color:#6b7280">${timeUsed} of ${p.time_limit_minutes} min used &middot; ${mx}x multiplier &middot; ${award} ☀️</small>
          </span>
          <div>
            <button style="background:#f59e0b;color:white;width:auto;margin:2px" onclick="submitEggVerify('${p.accept_id}','approve')">🏆 Award ${award} ☀️</button>
            <button style="background:#e74c3c;width:auto;margin:2px" onclick="submitEggVerify('${p.accept_id}','deny')">❌ Deny</button>
          </div>
        </div>`;
      }
      return `<div class="chore-item">
        <span><strong>${escapeHtml(p.user)}</strong>: ${escapeHtml(pendingLabel(p))}</span>
        <div>
          ${p.type === "chore" && p.isAdHoc ? `<input id="${getPendingAmountInputId(p.key)}" class="pending-amount-input" type="number" min="1" step="1" value="10" />` : ""}
          <button style="background:#27ae60;width:auto;margin:2px" onclick="approvePending('${p.key}')">✅ Approve</button>
          <button style="background:#e74c3c;width:auto;margin:2px" onclick="denyPending('${p.key}')">❌ Deny</button>
        </div>
      </div>`;
    }).join("");
  }

  familyConfig.kidRoles.forEach(kid => {
    const el = document.getElementById(`kid-balance-${kid.toLowerCase().replace(/\s+/g, "-")}`);
    if (el) el.textContent = getTokens(kid) + " ☀️";
  });

  const notices = getSpendNotifications();
  if (notices.length === 0) {
    spendList.innerHTML = "<p>No spend notifications yet.</p>";
  } else {
    spendList.innerHTML = notices.map(n => `
      <div class="notification-item">
        <span><strong>${n.user}</strong> spent ${n.cost} ☀️ on ${n.rewardName}</span>
        <small>${new Date(n.time).toLocaleString()}</small>
      </div>
    `).join("");
  }

  streakBoard.innerHTML = buildStreakBoardMarkup() || "<p>No streak progress yet.</p>";
  renderChoreAdmin();
  renderRewardsAdmin();
  renderDashboardMode();

  // Easter Egg admin
  let eggAdminSection = document.getElementById("egg-admin-section");
  if (!eggAdminSection) {
    eggAdminSection = document.createElement("section");
    eggAdminSection.id = "egg-admin-section";
    document.getElementById("parent-view").appendChild(eggAdminSection);
  }
  renderEggAdminSection(eggAdminSection);
  if (isDashboardModeEnabled()) renderEggOverlay();
}

async function adjustTokens(user, direction) {
  if (!isParentUser()) {
    return;
  }

  const inputId = `kid-adjust-${user.toLowerCase().replace(/\s+/g, "-")}`;
  const amount = parseInt(document.getElementById(inputId).value, 10);

  if (!Number.isInteger(amount) || amount <= 0) {
    showMessage("Enter a valid token amount.", "#e74c3c");
    return;
  }

  try {
    await apiFetch("/api/tokens/adjust", {
      method: "POST",
      body: JSON.stringify({ user, amount, direction })
    });
    await refreshState();
  } catch (err) {
    showMessage("Could not adjust tokens. Try again.", "#e74c3c");
    return;
  }

  if (direction > 0) {
    showMessage(`Deposited ${amount} tokens to ${user}.`);
  } else {
    showMessage(`Took out ${amount} tokens from ${user}.`, "#e67e22");
  }

  renderParentView();
}

function choreLabel(id) {
  const chore = findChore(id);
  return chore ? chore.label : id;
}

function pendingLabel(item) {
  if (item.type === "egg_challenge") {
    const mins = item.time_limit_minutes || 0;
    const used = item.completed_at && item.accepted_at
      ? Math.round((item.completed_at - item.accepted_at) / 60000)
      : 0;
    return `🥚 ${item.challenge_title || "Challenge"} — ${item.kid_role} · ${used}/${mins} min`;
  }

  if (item.type === "streak") {
    const streakLabel = STREAK_DEFS[item.id]?.label || item.id;
    if (item.mode === "vacation-hold") {
      return `${streakLabel} · Vacation Keep-Alive · ${item.dayKey}`;
    }
    return `${streakLabel} · ${item.dayKey}`;
  }

  if (item.isAdHoc) {
    return `${item.label} · Ad-Hoc Chore`;
  }

  return item.label || choreLabel(item.id);
}

function getPendingAmountInputId(key) {
  return `pending-amount-${String(key).replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

async function approvePending(key) {
  const pendingItem = getPending().find(item => item.key === key);
  const body = { key };

  if (pendingItem && pendingItem.type === "chore" && pendingItem.isAdHoc) {
    const input = document.getElementById(getPendingAmountInputId(key));
    const amount = input ? parseInt(input.value, 10) : NaN;
    if (!Number.isInteger(amount) || amount <= 0) {
      showMessage("Enter a valid point amount for that ad-hoc chore.", "#e74c3c");
      return;
    }
    body.amount = amount;
  }

  try {
    await apiFetch("/api/approve", {
      method: "POST",
      body: JSON.stringify(body)
    });
    await refreshState();
  } catch (err) {
    showMessage("Could not approve. Try again.", "#e74c3c");
    return;
  }

  if (pendingItem && pendingItem.type === "streak") {
    const record = getStreakRecord(pendingItem.user, pendingItem.id);
    const streakLabel = (STREAK_DEFS[pendingItem.id]?.label || pendingItem.id).toLowerCase();
    const dayWord = record.current === 1 ? "" : "s";
    if (pendingItem.mode === "vacation-hold") {
      showMessage(`Approved! ${pendingItem.user}'s ${streakLabel} stays alive on vacation at ${record.current} day${dayWord}.`);
    } else {
      showMessage(`Approved! ${pendingItem.user}'s ${streakLabel} is now ${record.current} day${dayWord}.`);
    }
  } else if (pendingItem) {
    const approvedAmount = body.amount || pendingItem.amount;
    showMessage(`Approved! ${pendingItem.user} earned ${approvedAmount} ☀️`);
  } else {
    showMessage("Approved!");
  }

  renderParentView();
}

async function denyPending(key) {
  const pendingItem = getPending().find(item => item.key === key);

  try {
    await apiFetch("/api/deny", {
      method: "POST",
      body: JSON.stringify({ key })
    });
    await refreshState();
  } catch (err) {
    showMessage("Could not deny. Try again.", "#e74c3c");
    return;
  }

  if (pendingItem && pendingItem.type === "streak") {
    showMessage(pendingItem.mode === "vacation-hold" ? "Vacation keep-alive denied." : "Streak entry denied.", "#e74c3c");
  } else {
    showMessage("Denied.", "#e74c3c");
  }
  renderParentView();
}

// --- Shared ---
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showMessage(text, color = "#2ecc71") {
  const message = document.getElementById("message");
  message.textContent = text;
  message.style.color = color;
  message.style.opacity = "1";
  clearTimeout(message._timeout);
  message._timeout = setTimeout(() => { message.style.opacity = "0"; }, 2500);
}

// ── Easter Egg Challenge System ──────────────────────────────────────────────

let _eggModalEgg = null;
let _eggModalKidRole = null;
let _eggCountdownInterval = null;

function renderEggOverlay() {
  const existing = document.getElementById("egg-overlay");
  if (existing) existing.remove();
  const eggs = appState.active_eggs || [];
  if (!eggs.length) return;
  const now = Date.now();
  const visible = eggs.filter(e => e.display_end >= now);
  if (!visible.length) return;

  const overlay = document.createElement("div");
  overlay.id = "egg-overlay";
  overlay.className = "egg-overlay";
  document.body.appendChild(overlay);

  const colors = ["egg-color-warm", "egg-color-sage", "egg-color-sky"];
  const isTv = document.body.classList.contains("dashboard-mode");

  visible.forEach((egg, i) => {
    const el = document.createElement("div");
    el.className = "floating-egg " + colors[i % colors.length] + (isTv ? " egg-tv" : "");
    el.style.top  = (10 + Math.random() * 75) + "%";
    el.style.left = (10 + Math.random() * 75) + "%";
    el.style.fontSize = (28 + Math.random() * 28) + "px"; // 28–56px random per egg
    el.textContent = "🥚";
    el.title = "Click me!";
    el.addEventListener("click", () => openEggModal(egg));
    overlay.appendChild(el);
  });
}

function openEggModal(egg) {
  _eggModalEgg = egg;
  document.getElementById("egg-modal-title").textContent = egg.challenge_title || "Challenge";
  document.getElementById("egg-modal-desc").textContent  = egg.challenge_description || "";
  document.getElementById("egg-modal-tokens").textContent = egg.token_reward || 0;
  document.getElementById("egg-modal-timelimit").textContent = (egg.time_limit_minutes || 0) + " min time limit";
  document.getElementById("egg-modal-error").style.display = "none";
  document.getElementById("egg-modal-pw").value = "";

  if (_eggCountdownInterval) clearInterval(_eggCountdownInterval);
  const countdownEl = document.getElementById("egg-modal-countdown");
  function updateCountdown() {
    const rem = Math.max(0, egg.display_end - Date.now());
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    countdownEl.textContent = "Egg disappears in: " + m + ":" + String(s).padStart(2, "0");
    if (rem <= 0) { clearInterval(_eggCountdownInterval); countdownEl.textContent = "Window closed (grace period still active)"; }
  }
  updateCountdown();
  _eggCountdownInterval = setInterval(updateCountdown, 1000);

  const kidSelect = document.getElementById("egg-modal-kidselect");
  const pwField   = document.getElementById("egg-modal-pwfield");
  const isKid = currentUser && !isParentUser(currentUser);

  if (isKid) {
    _eggModalKidRole = currentUser;
    kidSelect.style.display = "none";
    pwField.style.display   = "block";
    document.getElementById("egg-modal-kidlabel").textContent = "Enter your password to accept:";
  } else {
    _eggModalKidRole = null;
    kidSelect.style.display = "block";
    pwField.style.display   = "none";
    const btns = document.getElementById("egg-kid-buttons");
    btns.innerHTML = "";
    familyConfig.kidRoles.forEach(k => {
      const b = document.createElement("button");
      b.textContent = k;
      b.style.cssText = "padding:0.5rem 1rem;border:1px solid #d1d5db;border-radius:6px;background:white;color:#1f2937;cursor:pointer;font-size:1rem";
      b.onclick = () => {
        _eggModalKidRole = k;
        kidSelect.style.display = "none";
        pwField.style.display   = "block";
        document.getElementById("egg-modal-kidlabel").textContent = k + " — enter your password:";
      };
      btns.appendChild(b);
    });
  }

  const modal = document.getElementById("egg-discovery-modal");
  modal.style.display = "flex";
}

function closeEggModal() {
  if (_eggCountdownInterval) clearInterval(_eggCountdownInterval);
  document.getElementById("egg-discovery-modal").style.display = "none";
  _eggModalEgg = null;
  _eggModalKidRole = null;
}

async function submitEggAccept() {
  if (!_eggModalEgg || !_eggModalKidRole) return;
  const pw  = document.getElementById("egg-modal-pw").value;
  const err = document.getElementById("egg-modal-error");
  const btn = document.getElementById("egg-modal-accept-btn");
  err.style.display = "none";
  btn.disabled = true;
  btn.textContent = "Accepting…";
  try {
    const data = await apiFetch("/api/eggs/accept", {
      method: "POST",
      body: JSON.stringify({ challenge_id: _eggModalEgg.challenge_id, kid_role: _eggModalKidRole, password: pw })
    });
    if (data && data.success) {
      closeEggModal();
      showMessage("Challenge accepted! Good luck, " + _eggModalKidRole + "! 🥚");
      await refreshState();
    }
  } catch (e) {
    const msg = e.message || "";
    err.textContent = msg.includes("401") || msg.includes("wrong_password")
      ? "Wrong password. Try again."
      : msg.includes("409") ? "Already accepted this challenge!"
      : msg.includes("400") ? "Egg has expired."
      : "Something went wrong. Try again.";
    err.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Accept Challenge";
  }
}

function renderEggChallengesSection(container) {
  const now = Date.now();
  const accepts = appState.egg_accepts || [];

  const active   = accepts.filter(a => !a.completed_at && a.expires_at > now);
  const pending  = accepts.filter(a =>  a.completed_at && !a.approved);
  const approved = accepts.filter(a =>  a.approved);
  const expired  = accepts.filter(a => !a.completed_at && a.expires_at <= now);

  function fmtTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m + ":" + String(s).padStart(2, "0");
  }

  function calcDisplayMx(a) {
    const tlm = a.time_limit_minutes || 0;
    if (!tlm) return "?";
    const used = (now - a.accepted_at) / 60000;
    const pct  = used / tlm;
    if (pct <= 0.25) return "2.0";
    if (pct <= 0.50) return "1.6";
    if (pct <= 0.75) return "1.4";
    if (pct <= 1.00) return "1.2";
    return "1.0";
  }

  let html = "<h2>🥚 Easter Egg Challenges</h2>";

  if (active.length) {
    html += "<p class='egg-section-header' style='color:#d97706'>🟡 Active Challenges</p>";
    active.forEach(a => {
      const rem = a.expires_at - now;
      const mx  = calcDisplayMx(a);
      const pot = Math.round((a.token_reward || 0) * parseFloat(mx));
      html += `<div class="egg-challenge-card">
        <div style="min-width:0;flex:1">
          <strong style="display:block;word-break:break-word">${escapeHtml(a.challenge_title || "Challenge")}</strong>
          <span class="egg-multiplier-badge">up to ${mx}x = ${pot} ☀️</span>
          <span class="egg-challenge-timer" id="egg-timer-${a.id}">⏱ ${fmtTime(Math.max(0, rem))}</span>
        </div>
        <button onclick="submitEggComplete('${a.id}')"
          style="background:#f59e0b;color:white;border:none;border-radius:6px;padding:0.5rem 1rem;font-size:0.9rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;width:auto;margin-left:0.75rem">
          I Did It!
        </button>
      </div>`;
    });
  }

  if (pending.length) {
    html += "<p class='egg-section-header' style='color:#6b7280'>⏳ Pending Approval</p>";
    pending.forEach(a => {
      html += `<div class="egg-challenge-card"><strong>${escapeHtml(a.challenge_title || "Challenge")}</strong><span style="font-size:0.82rem;color:#6b7280">Waiting for dad 👀</span></div>`;
    });
  }

  if (approved.length) {
    html += "<p class='egg-section-header' style='color:#16a34a'>✅ Completed</p>";
    approved.forEach(a => {
      html += `<div class="egg-challenge-card"><strong>${escapeHtml(a.challenge_title || "Challenge")}</strong><span style="color:#16a34a;font-weight:700">+${a.tokens_awarded} ☀️</span></div>`;
    });
  }

  if (expired.length) {
    html += "<p class='egg-section-header' style='color:#9ca3af'>❌ Missed</p>";
    expired.forEach(a => {
      html += `<div class="egg-challenge-card expired"><strong>${escapeHtml(a.challenge_title || "Challenge")}</strong><span style="font-size:0.8rem;color:#9ca3af">missed window</span></div>`;
    });
  }

  if (!active.length && !pending.length && !approved.length && !expired.length) {
    html += "<p style='color:#9ca3af;font-size:0.85rem'>No egg challenges yet. Keep an eye out for hidden eggs! 🥚</p>";
  }

  html += `<details style="margin-top:1rem"><summary style="cursor:pointer;font-size:0.9rem;color:#6b7280;list-style:none">💡 Submit a Challenge Idea ▸</summary>
    <div class="egg-submit-form">
      <input id="egg-idea-title" placeholder="Challenge title (e.g. Build the robot kit)" maxlength="80">
      <textarea id="egg-idea-desc" placeholder="What's the challenge? (optional)" rows="2"></textarea>
      <input id="egg-idea-tokens" type="number" placeholder="Suggested tokens (e.g. 40)" min="1" max="500">
      <input id="egg-idea-time"   type="number" placeholder="Time limit in minutes (e.g. 120)" min="5" max="480">
      <button onclick="submitEggIdea()"
        style="margin-top:0.5rem;width:100%;background:#6b7280;color:white;border:none;border-radius:6px;padding:0.5rem;cursor:pointer">
        Submit Idea
      </button>
    </div>
  </details>`;

  container.innerHTML = html;

  // Live timers — clear previous batch before creating new ones
  eggTimerIntervals.forEach(iv => clearInterval(iv));
  eggTimerIntervals = [];
  active.forEach(a => {
    const el = document.getElementById("egg-timer-" + a.id);
    if (!el) return;
    const iv = setInterval(() => {
      const rem = a.expires_at - Date.now();
      if (rem <= 0) { clearInterval(iv); el.textContent = "⏱ 0:00 (grace)"; return; }
      el.textContent = "⏱ " + fmtTime(rem);
    }, 1000);
    eggTimerIntervals.push(iv);
  });
}

async function submitEggComplete(acceptId) {
  try {
    const data = await apiFetch("/api/egg-challenges/complete", {
      method: "POST",
      body: JSON.stringify({ accept_id: acceptId })
    });
    if (data && data.success) {
      showMessage("Nice work! Submitted for dad's approval 🏆");
      await refreshState();
    }
  } catch (e) {
    const msg = e.message || "";
    showMessage(msg.includes("400") ? "Challenge window expired." : "Could not submit. Try again.", "#e74c3c");
  }
}

async function submitEggIdea() {
  const title   = (document.getElementById("egg-idea-title")?.value || "").trim();
  const desc    = (document.getElementById("egg-idea-desc")?.value  || "").trim();
  const tokens  = parseInt(document.getElementById("egg-idea-tokens")?.value || "0", 10);
  const minutes = parseInt(document.getElementById("egg-idea-time")?.value   || "0", 10);

  if (!title)           { showMessage("Please enter a challenge title.", "#e74c3c"); return; }
  if (tokens < 1)       { showMessage("Please enter a valid token reward.", "#e74c3c"); return; }
  if (minutes < 5)      { showMessage("Time limit must be at least 5 minutes.", "#e74c3c"); return; }

  try {
    const data = await apiFetch("/api/egg-challenges/submit", {
      method: "POST",
      body: JSON.stringify({ title, description: desc, token_reward: tokens, time_limit_minutes: minutes, repeatable: true })
    });
    if (data && data.success) {
      showMessage("Idea submitted! Dad will review it 👍");
      await refreshState();
    }
  } catch {
    showMessage("Could not submit idea. Try again.", "#e74c3c");
  }
}

function renderEggAdminSection(container) {
  const meta     = appState.egg_challenges_meta || {};
  const pending  = appState.egg_challenges_pending || [];
  const approved = appState.egg_challenges_approved || [];
  const poolOk   = (meta.pool_size || 0) >= 3;
  const enabled = meta.enabled !== false;

  let lastActStr = "Never";
  if (meta.last_activated) {
    const hoursAgo = Math.round((Date.now() - meta.last_activated) / 3600000);
    lastActStr = hoursAgo < 1 ? "Less than an hour ago" : hoursAgo + " hour" + (hoursAgo === 1 ? "" : "s") + " ago";
  }

  let html = `<h2>🥚 Challenge Admin</h2>
    <div class="egg-pool-status">
      <span class="egg-pool-stat ${poolOk ? "" : "warning"}">${meta.pool_size || 0} challenges ready${poolOk ? "" : " ⚠️ low"}</span>
      <span class="egg-pool-stat">${meta.pending_approval || 0} pending approval</span>
      <span class="egg-pool-stat">${meta.pending_completion || 0} awaiting completion review</span>
    </div>
    <div class="egg-last-activated">Last egg appeared: ${lastActStr}</div>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem">
      <button onclick="activateEggNow()" style="background:#f59e0b;color:white;border:none;border-radius:6px;padding:0.5rem 0.9rem;cursor:pointer;font-size:0.9rem">
        🥚 Activate Egg Now
      </button>
      <button onclick="toggleEggs()" style="background:${enabled ? "#ef4444" : "#22c55e"};color:white;border:none;border-radius:6px;padding:0.5rem 0.9rem;cursor:pointer;font-size:0.9rem">
        ${enabled ? "⏸ Disable Eggs" : "▶ Enable Eggs"}
      </button>
    </div>`;

  html += `<p class='egg-section-header'>Add a Challenge Idea</p>
    <div class="egg-submit-form">
      <input id="parent-egg-title" type="text" placeholder="Challenge title (e.g. Build the robot kit)" />
      <textarea id="parent-egg-desc" placeholder="Optional description" rows="2"></textarea>
      <div style="display:flex;gap:0.5rem">
        <input id="parent-egg-tokens" type="number" placeholder="Tokens (e.g. 40)" min="1" style="width:50%" />
        <input id="parent-egg-time" type="number" placeholder="Minutes (e.g. 120)" min="5" style="width:50%" />
      </div>
      <button onclick="submitParentEggIdea()">Submit Idea</button>
    </div>`;

  if (pending.length) {
    html += "<p class='egg-section-header'>Pending Challenge Ideas</p>";
    pending.forEach(c => {
      html += `<div class="egg-pending-idea">
        <div>
          <strong>${escapeHtml(c.title)}</strong>
          <div class="egg-idea-meta">${escapeHtml(c.description || "")} &middot; ${c.token_reward} ☀️ &middot; ${c.time_limit_minutes} min &middot; from ${escapeHtml(c.created_by)}</div>
        </div>
        <div style="display:flex;gap:0.3rem;flex-shrink:0">
          <button onclick="approveEggChallenge('${c.id}')" style="background:#22c55e;color:white;border:none;border-radius:4px;padding:0.3rem 0.6rem;cursor:pointer;font-size:0.8rem">✓</button>
          <button onclick="rejectEggChallenge('${c.id}')"  style="background:#ef4444;color:white;border:none;border-radius:4px;padding:0.3rem 0.6rem;cursor:pointer;font-size:0.8rem">✗</button>
        </div>
      </div>`;
    });
  } else {
    html += "<p style='color:#9ca3af;font-size:0.85rem'>No pending challenge ideas.</p>";
  }

  if (approved.length) {
    html += "<p class='egg-section-header'>Challenge Pool</p>";
    approved.forEach(c => {
      html += `<div class="egg-pending-idea">
        <div>
          <strong>${escapeHtml(c.title)}</strong>
          <div class="egg-idea-meta">${escapeHtml(c.description || "")} &middot; ${c.token_reward} ☀️ &middot; ${c.time_limit_minutes} min</div>
        </div>
        <div style="flex-shrink:0">
          <button onclick="rejectEggChallenge('${c.id}')" style="background:#ef4444;color:white;border:none;border-radius:4px;padding:0.3rem 0.6rem;cursor:pointer;font-size:0.8rem">✗</button>
        </div>
      </div>`;
    });
  }

  container.innerHTML = html;
}

async function activateEggNow() {
  try {
    await apiFetch("/api/eggs/activate", { method: "POST", body: "{}" });
    showMessage("Egg activated! 🥚");
    await refreshState();
  } catch (e) {
    const msg = e.message || "";
    showMessage(msg.includes("max_eggs") ? "Already 3 eggs active." : msg.includes("no_approved") ? "No approved challenges in pool." : "Could not activate.", "#e74c3c");
  }
}

async function toggleEggs() {
  const enabled = (appState.egg_challenges_meta || {}).enabled !== false;
  try {
    await apiFetch("/api/eggs/toggle", { method: "POST", body: JSON.stringify({ enabled: !enabled }) });
    showMessage(enabled ? "Eggs disabled." : "Eggs enabled!");
    await refreshState();
  } catch {
    showMessage("Could not toggle eggs.", "#e74c3c");
  }
}

async function approveEggChallenge(id) {
  if (eggAdminInFlight) return;
  eggAdminInFlight = true;
  try {
    await apiFetch("/api/egg-challenges/approve", { method: "POST", body: JSON.stringify({ id }) });
    showMessage("Challenge approved and added to pool! ✅");
    await refreshState();
  } catch {
    showMessage("Could not approve.", "#e74c3c");
  } finally {
    eggAdminInFlight = false;
  }
}

async function submitParentEggIdea() {
  if (eggAdminInFlight) return;
  const title = (document.getElementById("parent-egg-title").value || "").trim();
  const desc  = (document.getElementById("parent-egg-desc").value || "").trim();
  const tokens = Number(document.getElementById("parent-egg-tokens").value);
  const time   = Number(document.getElementById("parent-egg-time").value);
  if (!title) { showMessage("Challenge title required.", "#e74c3c"); return; }
  eggAdminInFlight = true;
  try {
    await apiFetch("/api/egg-challenges/submit", {
      method: "POST",
      body: JSON.stringify({ title, description: desc, token_reward: tokens, time_limit_minutes: time })
    });
    showMessage("Idea submitted and auto-approved! ✅");
    document.getElementById("parent-egg-title").value = "";
    document.getElementById("parent-egg-desc").value  = "";
    document.getElementById("parent-egg-tokens").value = "";
    document.getElementById("parent-egg-time").value   = "";
    await refreshState();
  } catch (e) {
    showMessage("Could not submit: " + (e.message || "unknown error"), "#e74c3c");
  } finally {
    eggAdminInFlight = false;
  }
}

async function rejectEggChallenge(id) {
  if (eggAdminInFlight) return;
  eggAdminInFlight = true;
  try {
    await apiFetch("/api/egg-challenges/reject", { method: "POST", body: JSON.stringify({ id }) });
    showMessage("Challenge idea removed.");
    await refreshState();
  } catch {
    showMessage("Could not reject.", "#e74c3c");
  } finally {
    eggAdminInFlight = false;
  }
}

async function submitEggVerify(acceptId, action) {
  try {
    const data = await apiFetch("/api/egg-challenges/verify", {
      method: "POST",
      body: JSON.stringify({ accept_id: acceptId, action })
    });
    if (data && data.success) {
      if (action === "approve") {
        showMessage("Challenge approved! " + (data.tokens_awarded || 0) + " ☀️ awarded 🏆");
      } else {
        showMessage("Challenge denied.", "#e74c3c");
      }
      await refreshState();
      renderParentView();
    }
  } catch {
    showMessage("Could not process. Try again.", "#e74c3c");
  }
}

document.getElementById("login-password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleAuthSubmit();
  }
});

document.getElementById("avatar-file").addEventListener("change", handleAvatarFileChange);

resetAuthUI();
const avatarReadyPromise = loadPublicAvatars();

(async () => {
  await loadFamilyConfig();
  document.title = familyConfig.appName;
  document.querySelectorAll(".app-name").forEach(el => { el.textContent = familyConfig.appName; });
  renderKidBalancesAndBank();
  renderLoginButtons();

  const token = getToken();
  const role = getStoredRole();
  if (token && role) {
    try {
      await avatarReadyPromise;
      await login(role);
    } catch {
      clearToken();
    }
  }
})();
