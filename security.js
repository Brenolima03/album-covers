import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------- config ----------

const config = {
  banDurationMs: 24 * 60 * 60 * 1000, // how long an IP stays banned (24h)
  strikesToBan: 3, // strikes before a ban
  strikeWindowMs: 60 * 60 * 1000, // strikes count within 1 hour
  requestsPerMinute: 120, // overall limit per IP
  coversPer10Minutes: 5, // new covers limit per IP
  minFormFillMs: 3000, // humans take more than 3s to fill in the form
};

const bansFile = path.join(import.meta.dirname, 'data', 'bans.json');

// Paths only vulnerability scanners request. Anyone who tries is banned immediately.
const scannerPaths =
  /\.(php|asp|aspx|jsp|cgi)$|\/\.(env|git|aws|ssh|htaccess)|wp-(admin|login|content|includes)|phpmyadmin|xmlrpc|\/server-status|\/config\.(json|yml|yaml)$/i;

// ---------- helpers ----------

function clientIp(req) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip; // "::ffff:1.2.3.4" -> "1.2.3.4"
}

// Per-IP counter with a fixed time window.
function createCounter(windowMs) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count;
    },
    sweep() {
      const now = Date.now();
      for (const [key, entry] of hits) {
        if (entry.resetAt <= now) hits.delete(key);
      }
    },
  };
}

const requestCounter = createCounter(60 * 1000);
const coverCounter = createCounter(10 * 60 * 1000);
const strikeCounter = createCounter(config.strikeWindowMs);

// Clear expired counters so memory doesn't grow forever.
setInterval(() => {
  requestCounter.sweep();
  coverCounter.sweep();
  strikeCounter.sweep();
}, 60 * 1000).unref();

function reject(req, res, status, message) {
  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: message });
  } else {
    res.status(status).type('text').send(message);
  }
}

// ---------- bans (saved to data/bans.json) ----------

let bans = {}; // ip -> { reason, bannedAt, until }
let saving = Promise.resolve();

async function loadBans() {
  try {
    bans = JSON.parse(await readFile(bansFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    bans = {};
  }
}

function saveBans() {
  saving = saving
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(bansFile), { recursive: true });
      await writeFile(bansFile, JSON.stringify(bans, null, 2));
    })
    .catch((err) => console.error('[security] could not save bans:', err));
  return saving;
}

function ban(ip, reason) {
  if (bans[ip]) return;
  const now = Date.now();
  bans[ip] = {
    reason,
    bannedAt: new Date(now).toISOString(),
    until: new Date(now + config.banDurationMs).toISOString(),
  };
  console.warn(`[security] BANNED ${ip}: ${reason}`);
  saveBans();
}

function isBanned(ip) {
  const entry = bans[ip];
  if (!entry) return false;
  if (Date.parse(entry.until) <= Date.now()) {
    delete bans[ip]; // ban expired
    saveBans();
    return false;
  }
  return true;
}

// One strike. Reaching `strikesToBan` within the window bans the IP.
function strike(ip, reason) {
  const count = strikeCounter.hit(ip);
  console.warn(`[security] strike ${count}/${config.strikesToBan} for ${ip}: ${reason}`);
  if (count >= config.strikesToBan) {
    ban(ip, `${count} strikes (last: ${reason})`);
  }
}

// ---------- middlewares ----------

// Headers that make XSS, clickjacking and similar attacks harder.
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      'img-src http: https: data:', // covers can come from any site
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
}

// Block banned IPs before anything else.
function blockBanned(req, res, next) {
  if (isBanned(clientIp(req))) {
    return reject(req, res, 403, 'Access blocked.');
  }
  next();
}

// Ban anyone probing for WordPress, .env, .git, etc.
function trapScanners(req, res, next) {
  if (scannerPaths.test(req.path)) {
    ban(clientIp(req), `scanner probe: ${req.method} ${req.path}`);
    return reject(req, res, 404, 'Not found.');
  }
  next();
}

// Overall request limit per IP.
function rateLimit(req, res, next) {
  const ip = clientIp(req);
  const count = requestCounter.hit(ip);
  const max = config.requestsPerMinute;

  if (count > max * 2) {
    ban(ip, `flooding (${count} requests in a minute)`);
    return reject(req, res, 429, 'Too many requests.');
  }
  if (count > max) {
    if (count === max + 1) strike(ip, 'too many requests');
    res.set('Retry-After', '60');
    return reject(req, res, 429, 'Too many requests. Wait a minute and try again.');
  }
  next();
}

// Extra checks only for new cover submissions.
function guardNewCover(req, res, next) {
  const ip = clientIp(req);
  const body = req.body ?? {};

  // Hidden field: people don't see it, bots fill it in.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    ban(ip, 'filled the hidden honeypot field');
    return reject(req, res, 400, "The cover wasn't added.");
  }

  if (!req.get('user-agent')) {
    strike(ip, 'request without user agent');
    return reject(req, res, 400, "The cover wasn't added.");
  }

  const fillTimeMs = Number(body.fillTimeMs);
  if (!Number.isFinite(fillTimeMs) || fillTimeMs < config.minFormFillMs) {
    strike(ip, `form sent too fast (${body.fillTimeMs} ms)`);
    return reject(req, res, 400, 'That was too fast. Check the details and try again.');
  }

  const count = coverCounter.hit(ip);
  if (count > config.coversPer10Minutes) {
    if (count === config.coversPer10Minutes + 1) strike(ip, 'too many covers');
    return reject(req, res, 429, "You've added a lot of covers in a short time. Wait a few minutes and try again.");
  }

  next();
}

// Malformed JSON or an oversized body counts as a strike.
function handleBadRequests(err, req, res, next) {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    strike(clientIp(req), err.type);
    return reject(req, res, err.status ?? 400, 'Invalid request.');
  }
  next(err);
}

export {
  loadBans,
  securityHeaders,
  blockBanned,
  trapScanners,
  rateLimit,
  guardNewCover,
  handleBadRequests,
};
