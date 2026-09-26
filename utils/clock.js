const https = require("https");

let offsetMs = 0;
let isPatched = false;

function fetchGoogleServerTimeMs() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "www.google.com",
        path: "/generate_204",
        method: "HEAD",
        timeout: 5000,
      },
      (res) => {
        const dateHeader = res.headers.date;
        res.resume(); // drain so the socket can close
        if (!dateHeader) {
          reject(new Error("Google response had no Date header"));
          return;
        }
        resolve(new Date(dateHeader).getTime());
      },
    );

    req.on("timeout", () =>
      req.destroy(new Error("Clock sync request timed out")),
    );
    req.on("error", reject);
    req.end();
  });
}

function patchGlobalDate() {
  if (isPatched) return;
  isPatched = true;

  const RealDate = Date;

  class CorrectedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(RealDate.now() + offsetMs);
      } else {
        super(...args);
      }
    }

    static now() {
      return RealDate.now() + offsetMs;
    }
  }

  global.Date = CorrectedDate;
}

/**
 * Measures this machine's offset from Google's server time and patches
 * global Date to compensate. Safe to call more than once - later calls
 * just refresh the offset to track further drift.
 */
async function syncClockWithGoogle({ warnThresholdMs = 30_000 } = {}) {
  const localBefore = Date.now();
  const googleTimeMs = await fetchGoogleServerTimeMs();
  const localAfter = Date.now();

  // Midpoint roughly cancels out request latency.
  const localMidpoint = (localBefore + localAfter) / 2;
  offsetMs = googleTimeMs - localMidpoint;

  if (Math.abs(offsetMs) > warnThresholdMs) {
    console.warn(
      `[clockSync] System clock is off by ~${Math.round(offsetMs / 1000)}s ` +
        "vs Google's servers. Compensating in-process, but you should " +
        "also fix the OS clock (Windows: Settings > Time & Language > " +
        "'Set time automatically', or run 'w32tm /resync' as admin).",
    );
  }

  patchGlobalDate();
  return offsetMs;
}

module.exports = { syncClockWithGoogle };
