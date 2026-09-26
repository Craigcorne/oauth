const express = require("express");
const https = require("https");
const { BetaAnalyticsDataClient } = require("@google-analytics/data");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

const router = express.Router();

const propertyId = process.env.GA4_PROPERTY_ID;

let clockOffsetMs = 0;
let dateIsPatched = false;
let clockSyncPromise = null;

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
        res.resume();
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
  if (dateIsPatched) return;
  dateIsPatched = true;

  const RealDate = Date;
  class CorrectedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(RealDate.now() + clockOffsetMs);
      } else {
        super(...args);
      }
    }
    static now() {
      return RealDate.now() + clockOffsetMs;
    }
  }
  global.Date = CorrectedDate;
}

function ensureClockSynced() {
  if (!clockSyncPromise) {
    clockSyncPromise = (async () => {
      const localBefore = Date.now();
      const googleTimeMs = await fetchGoogleServerTimeMs();
      const localAfter = Date.now();
      clockOffsetMs = googleTimeMs - (localBefore + localAfter) / 2;

      if (Math.abs(clockOffsetMs) > 30_000) {
        // console.warn(
        //   `[GA4] System clock is off by ~${Math.round(
        //     clockOffsetMs / 1000,
        //   )}s vs Google's servers. Compensating automatically for GA4 auth.`,
        // );
      }
      patchGlobalDate();
    })().catch((err) => {
      console.warn(
        "[GA4] Clock sync check failed, continuing on system clock:",
        err.message,
      );
    });
  }
  return clockSyncPromise;
}

/* ─── Client lifecycle with automatic reset on gRPC failure ─── */
let analyticsDataClient = null;

const resetClient = () => {
  analyticsDataClient = null;
};

const isUnavailableError = (err) =>
  err?.code === 14 ||
  err?.details?.includes("UNAVAILABLE") ||
  err?.message?.includes("Name resolution failed") ||
  err?.message?.includes("UNAVAILABLE");

const getClient = async () => {
  await ensureClockSynced();
  if (analyticsDataClient) return analyticsDataClient;

  const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
  if (!base64) {
    throw new Error(
      "Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64. " +
        "Ensure your .env file is loaded before requiring this router.",
    );
  }

  const credentials = JSON.parse(
    Buffer.from(base64, "base64").toString("utf-8"),
  );

  analyticsDataClient = new BetaAnalyticsDataClient({ credentials });
  return analyticsDataClient;
};

const dateRange = (startDaysAgo = 30, endDaysAgo = 0) => ({
  startDate: `${startDaysAgo}daysAgo`,
  endDate: `${endDaysAgo}daysAgo`,
});

const previousDateRange = (days = 30) => ({
  startDate: `${2 * days + 1}daysAgo`,
  endDate: `${days + 1}daysAgo`,
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shiftDateStr(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

function previousExplicitRange(startDate, spanDays) {
  return {
    startDate: shiftDateStr(startDate, -spanDays),
    endDate: shiftDateStr(startDate, -1),
  };
}

function parseDateRangesFromQuery(req) {
  const { startDate, endDate } = req.query;
  const days = Number(req.query.days) || 30;

  const hasValidExplicitRange =
    ISO_DATE_RE.test(startDate || "") &&
    ISO_DATE_RE.test(endDate || "") &&
    startDate <= endDate;

  if (hasValidExplicitRange) {
    const spanDays = daysBetweenInclusive(startDate, endDate);
    return {
      current: { startDate, endDate },
      previous: previousExplicitRange(startDate, spanDays),
      spanDays,
    };
  }

  return {
    current: dateRange(days),
    previous: previousDateRange(days),
    spanDays: days,
  };
}

/* ─── 1. Overview ─── */
router.get("/overview", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const client = await getClient();
    const { current, previous } = parseDateRangesFromQuery(req);

    const metrics = [
      { name: "activeUsers" },
      { name: "sessions" },
      { name: "screenPageViews" },
      { name: "averageSessionDuration" },
      { name: "bounceRate" },
      { name: "totalRevenue" },
      { name: "ecommercePurchases" },
      { name: "averagePurchaseRevenue" },
    ];

    const [currentPair, previousPair] = await Promise.all([
      client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [current],
        metrics,
      }),
      client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [previous],
        metrics,
      }),
    ]);

    const currentRow = currentPair[0].rows?.[0]?.metricValues || [];
    const previousRow = previousPair[0].rows?.[0]?.metricValues || [];

    const data = {
      activeUsers: currentRow[0]?.value || "0",
      sessions: currentRow[1]?.value || "0",
      pageViews: currentRow[2]?.value || "0",
      avgSessionDuration: currentRow[3]?.value || "0",
      bounceRate: currentRow[4]?.value || "0",
      totalRevenue: currentRow[5]?.value || "0",
      ecommercePurchases: currentRow[6]?.value || "0",
      avgOrderValue: currentRow[7]?.value || "0",

      activeUsersPrev: previousRow[0]?.value || "0",
      sessionsPrev: previousRow[1]?.value || "0",
      pageViewsPrev: previousRow[2]?.value || "0",
      avgSessionDurationPrev: previousRow[3]?.value || "0",
      bounceRatePrev: previousRow[4]?.value || "0",
      totalRevenuePrev: previousRow[5]?.value || "0",
      ecommercePurchasesPrev: previousRow[6]?.value || "0",
      avgOrderValuePrev: previousRow[7]?.value || "0",
    };

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("GA4 OVERVIEW ERROR:", err);
    if (isUnavailableError(err)) resetClient();
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─── 2. Top pages ─── */
router.get(
  "/top-pages",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const client = await getClient();
      const { current, previous } = parseDateRangesFromQuery(req);
      const limit = Math.min(Number(req.query.limit) || 10, 50);

      const [currentResponse] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [current],
        dimensions: [{ name: "pageTitle" }, { name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit,
      });

      const currentRows = currentResponse.rows || [];
      const pagePaths = currentRows.map((row) => row.dimensionValues[1].value);

      const previousByPath = {};
      if (pagePaths.length > 0) {
        const [previousResponse] = await client.runReport({
          property: `properties/${propertyId}`,
          dateRanges: [previous],
          dimensions: [{ name: "pageTitle" }, { name: "pagePath" }],
          metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
          dimensionFilter: {
            filter: {
              fieldName: "pagePath",
              inListFilter: { values: pagePaths },
            },
          },
        });

        previousResponse.rows?.forEach((row) => {
          previousByPath[row.dimensionValues[1].value] =
            Number(row.metricValues[0].value) || 0;
        });
      }

      const data = currentRows.map((row) => {
        const pagePath = row.dimensionValues[1].value;
        return {
          pageTitle: row.dimensionValues[0].value,
          pagePath,
          pageViews: row.metricValues[0].value,
          activeUsers: row.metricValues[1].value,
          prevPageViews: previousByPath[pagePath] || 0,
        };
      });

      res.status(200).json({ success: true, data });
    } catch (err) {
      console.error("GA4 TOP-PAGES ERROR:", err);
      if (isUnavailableError(err)) resetClient();
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* ─── 3. Traffic sources ─── */
router.get(
  "/traffic-sources",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const client = await getClient();
      const { current } = parseDateRangesFromQuery(req);
      const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [current],
        dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }, { name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 20,
      });

      const data =
        response.rows?.map((row) => ({
          source: row.dimensionValues[0].value,
          medium: row.dimensionValues[1].value,
          sessions: row.metricValues[0].value,
          activeUsers: row.metricValues[1].value,
        })) || [];

      res.status(200).json({ success: true, data });
    } catch (err) {
      console.error("GA4 TRAFFIC-SOURCES ERROR:", err);
      if (isUnavailableError(err)) resetClient();
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* ─── 4. Devices ─── */
router.get("/devices", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const client = await getClient();
    const { current } = parseDateRangesFromQuery(req);
    const [response] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [current],
      dimensions: [{ name: "deviceCategory" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    });

    const data =
      response.rows?.map((row) => ({
        device: row.dimensionValues[0].value,
        activeUsers: row.metricValues[0].value,
        sessions: row.metricValues[1].value,
      })) || [];

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("GA4 DEVICES ERROR:", err);
    if (isUnavailableError(err)) resetClient();
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─── 5. E-commerce ─── */
router.get(
  "/ecommerce",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const client = await getClient();
      const { current, spanDays } = parseDateRangesFromQuery(req);

      const limit = Math.min(Math.max(spanDays, 30), 366);

      const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [current],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "totalRevenue" },
          { name: "ecommercePurchases" },
          { name: "averagePurchaseRevenue" },
        ],
        orderBys: [{ dimension: { dimensionName: "date" }, desc: true }],
        limit,
      });

      const data =
        response.rows?.map((row) => ({
          date: row.dimensionValues[0].value,
          revenue: row.metricValues[0].value,
          purchases: row.metricValues[1].value,
          avgOrderValue: row.metricValues[2].value,
        })) || [];

      res.status(200).json({ success: true, data });
    } catch (err) {
      console.error("GA4 ECOMMERCE ERROR:", err);
      if (isUnavailableError(err)) resetClient();
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* ─── 6. Real-time active users ─── */
router.get("/realtime", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const client = await getClient();
    const [response] = await client.runRealtimeReport({
      property: `properties/${propertyId}`,
      metrics: [{ name: "activeUsers" }],
      dimensions: [{ name: "minutesAgo" }],
      minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
    });

    const data =
      response.rows?.map((row) => ({
        minutesAgo: row.dimensionValues[0].value,
        activeUsers: row.metricValues[0].value,
      })) || [];

    const users = data.reduce((sum, r) => sum + Number(r.activeUsers), 0);

    res.status(200).json({ success: true, users, data });
  } catch (err) {
    console.error("GA4 REALTIME ERROR:", err);
    if (isUnavailableError(err)) resetClient();
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─── 7. Top events ─── */
router.get("/events", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const client = await getClient();
    const { current } = parseDateRangesFromQuery(req);
    const [response] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [current],
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 20,
    });

    const data =
      response.rows?.map((row) => ({
        eventName: row.dimensionValues[0].value,
        count: row.metricValues[0].value,
        users: row.metricValues[1].value,
      })) || [];

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("GA4 EVENTS ERROR:", err);
    if (isUnavailableError(err)) resetClient();
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─── 8. Funnel ─── */
router.get("/funnel", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const client = await getClient();
    const { current, previous } = parseDateRangesFromQuery(req);

    const eventFilter = {
      filter: {
        fieldName: "eventName",
        inListFilter: {
          values: ["add_to_cart", "begin_checkout", "purchase", "view_item"],
        },
      },
    };

    const [
      currentEventPair,
      previousEventPair,
      currentOverviewPair,
      previousOverviewPair,
    ] = await Promise.all([
      client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [current],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        dimensionFilter: eventFilter,
      }),
      client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [previous],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        dimensionFilter: eventFilter,
      }),
      client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [current],
        metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
      }),
      client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [previous],
        metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
      }),
    ]);

    const toEventMap = (response) => {
      const map = {};
      response.rows?.forEach((row) => {
        map[row.dimensionValues[0].value] =
          Number(row.metricValues[0].value) || 0;
      });
      return map;
    };

    const currentEvents = toEventMap(currentEventPair[0]);
    const previousEvents = toEventMap(previousEventPair[0]);

    const currentVisitors =
      Number(currentOverviewPair[0].rows?.[0]?.metricValues?.[0]?.value) || 0;
    const currentPageViews =
      Number(currentOverviewPair[0].rows?.[0]?.metricValues?.[1]?.value) || 0;
    const previousVisitors =
      Number(previousOverviewPair[0].rows?.[0]?.metricValues?.[0]?.value) || 0;
    const previousPageViews =
      Number(previousOverviewPair[0].rows?.[0]?.metricValues?.[1]?.value) || 0;

    const data = [
      {
        label: "Visitors",
        value: currentVisitors,
        prevValue: previousVisitors,
      },
      {
        label: "Product Views",
        value: currentEvents["view_item"] || 0,
        prevValue: previousEvents["view_item"] || 0,
      },
      {
        label: "Add to Cart",
        value: currentEvents["add_to_cart"] || 0,
        prevValue: previousEvents["add_to_cart"] || 0,
      },
      {
        label: "Begin Checkout",
        value: currentEvents["begin_checkout"] || 0,
        prevValue: previousEvents["begin_checkout"] || 0,
      },
      {
        label: "Purchases",
        value: currentEvents["purchase"] || 0,
        prevValue: previousEvents["purchase"] || 0,
      },
    ];

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("GA4 FUNNEL ERROR:", err);
    if (isUnavailableError(err)) resetClient();
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─── 9. Countries ─── */
router.get(
  "/countries",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const client = await getClient();
      const { current } = parseDateRangesFromQuery(req);
      const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [current],
        dimensions: [{ name: "country" }],
        metrics: [{ name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: 10,
      });

      const data =
        response.rows?.map((row) => ({
          name: row.dimensionValues[0].value,
          count: Number(row.metricValues[0].value) || 0,
        })) || [];

      res.status(200).json({ success: true, data });
    } catch (err) {
      console.error("GA4 COUNTRIES ERROR:", err);
      if (isUnavailableError(err)) resetClient();
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* ─── 10. Towns / Cities ─── */
router.get("/towns", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const client = await getClient();
    const { current } = parseDateRangesFromQuery(req);
    const [response] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [current],
      dimensions: [{ name: "city" }, { name: "country" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 20,
    });

    const data =
      response.rows
        ?.map((row) => ({
          name: row.dimensionValues[0].value,
          country: row.dimensionValues[1].value,
          count: Number(row.metricValues[0].value) || 0,
        }))
        .filter((t) => t.name && t.name !== "(not set)") || [];

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("GA4 TOWNS ERROR:", err);
    if (isUnavailableError(err)) resetClient();
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
