import { createHash, timingSafeEqual } from "crypto";

// Constant-time password check. Hashing both sides first makes the buffers
// the same length, so neither the comparison time nor an early length
// mismatch leaks anything about the real password.
export function passwordMatches(candidate, expected) {
  const a = createHash("sha256").update(String(candidate ?? "")).digest();
  const b = createHash("sha256").update(String(expected ?? "")).digest();
  return timingSafeEqual(a, b);
}

// Failed-login limiter, per client IP: after `maxFailures` wrong passwords
// inside `windowMs`, further attempts are refused until the window passes.
// A successful login clears that IP's count. In-memory is enough for a
// single-instance, single-user dashboard.
export function createLoginLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const failures = new Map(); // ip -> { count, firstAt }

  function entry(ip) {
    const e = failures.get(ip);
    if (e && now() - e.firstAt >= windowMs) {
      failures.delete(ip);
      return null;
    }
    return e || null;
  }

  return {
    // Seconds until this IP may try again, or 0 if it may try now.
    retryAfterSeconds(ip) {
      const e = entry(ip);
      if (!e || e.count < maxFailures) return 0;
      return Math.ceil((e.firstAt + windowMs - now()) / 1000);
    },
    recordFailure(ip) {
      const e = entry(ip);
      if (e) e.count += 1;
      else failures.set(ip, { count: 1, firstAt: now() });
    },
    recordSuccess(ip) {
      failures.delete(ip);
    },
  };
}

// Cross-origin guard for /api. The built app is served by this server, so
// its requests are same-origin; the only foreign origins allowed are the
// ones in `allowedOrigins` (the Vite dev server outside production).
// Anything else — including a random website open in the same browser —
// gets 403, for reads as well as writes, so it can neither exfiltrate the
// ledger nor delete, edit or trigger paid builds.
export function originGuard(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (!origin) return next(); // non-browser client, or a same-origin GET
    const self = `${req.protocol}://${req.get("host")}`;
    if (origin === self) return next();
    if (!allowed.has(origin)) {
      return res.status(403).json({ error: "Cross-origin request refused" });
    }

    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.sendStatus(204);
    }
    next();
  };
}
