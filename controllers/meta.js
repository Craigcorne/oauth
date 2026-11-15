// server/routes/metaCapi.js  (Node 18+, Express)
//
// Receives events from the browser helper (metaPixel.js) and forwards them
// to Meta's Conversions API. Also exports sendMetaEvent() so you can send
// events straight from the server (e.g. in your M-Pesa payment callback).
//
// Env vars (never put the token in frontend code):
//   META_PIXEL_ID
//   META_ACCESS_TOKEN
//   META_API_VERSION      optional, defaults to v25.0
//   META_TEST_EVENT_CODE  optional, only while testing in Events Manager
//
// Mount in your server entry file:
//   app.set("trust proxy", 1);   // 1 = one proxy (Render, Railway, Nginx...)
//   app.use("/api/meta", require("./routes/metaCapi"));

const crypto = require("crypto");
const express = require("express");

const router = express.Router();

// Parse JSON here so this route works regardless of where it is mounted.
router.use(express.json({ limit: "20kb" }));

const API_VERSION = process.env.META_API_VERSION || "v25.0";

const ALLOWED_EVENTS = new Set([
  "PageView",
  "ViewContent",
  "AddToCart",
  "InitiateCheckout",
  "Purchase",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Meta requires personal data to be lowercased, trimmed, then SHA-256 hashed.
const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");

// Meta wants phone numbers as digits with country code, e.g. 254712345678.
function normalizeKenyanPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return undefined;
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  return `254${digits}`;
}

function buildUserData({ user = {}, ip, userAgent }) {
  const phone = normalizeKenyanPhone(user.phone);

  return {
    // These two are NOT hashed.
    client_ip_address: ip,
    client_user_agent: userAgent,
    ...(user.fbp && { fbp: user.fbp }),
    ...(user.fbc && { fbc: user.fbc }),

    // These are hashed.
    ...(user.email && { em: [sha256(user.email)] }),
    ...(phone && { ph: [sha256(phone)] }),
    ...(user.externalId && { external_id: [sha256(user.externalId)] }),
  };
}

// ---------------------------------------------------------------------------
// Core sender (reusable from anywhere on the server)
// ---------------------------------------------------------------------------

async function sendMetaEvent({
  eventName,
  eventId,
  eventSourceUrl,
  data = {},
  user = {},
  ip,
  userAgent,
  actionSource = "website",
}) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) {
    console.error("Meta CAPI: META_PIXEL_ID or META_ACCESS_TOKEN is missing");
    return null;
  }

  const body = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId, // must match the Pixel's eventID for deduplication
        action_source: actionSource,
        event_source_url: eventSourceUrl,
        user_data: buildUserData({ user, ip, userAgent }),
        custom_data: data,
      },
    ],
    ...(process.env.META_TEST_EVENT_CODE && {
      test_event_code: process.env.META_TEST_EVENT_CODE,
    }),
  };

  const url =
    `https://graph.facebook.com/${API_VERSION}/` +
    `${process.env.META_PIXEL_ID}/events` +
    `?access_token=${process.env.META_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  if (!response.ok) {
    console.error("Meta CAPI error:", JSON.stringify(json));
  }
  return json;
}

// ---------------------------------------------------------------------------
// Route: POST /api/meta/events  (called by metaPixel.js in the browser)
// ---------------------------------------------------------------------------

router.post("/events", (req, res) => {
  const { eventName, eventId, eventSourceUrl, data, user } = req.body || {};

  if (!ALLOWED_EVENTS.has(eventName) || !eventId) {
    return res.sendStatus(400);
  }

  // Answer right away so shoppers never wait on Meta.
  res.sendStatus(202);

  sendMetaEvent({
    eventName,
    eventId: String(eventId),
    eventSourceUrl,
    data,
    user,
    ip: req.ip, // real visitor IP, as long as trust proxy is set correctly
    userAgent: req.headers["user-agent"],
  }).catch((err) => console.error("Meta CAPI failed:", err));
});

module.exports = router;
module.exports.sendMetaEvent = sendMetaEvent;
