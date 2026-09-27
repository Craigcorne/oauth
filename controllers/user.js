const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/user");
const Invoice = require("../models/invoice"); // adjust path to your User model
const catchAsyncErrors = require("../middleware/catchAsyncErrors"); // adjust to your actual path
const sendToken = require("../utils/jwtToken"); // the same helper used in /login-user
const ErrorHandler = require("../utils/ErrorHandler");
const passport = require("../config/passport");
const express = require("express");
const router = express.Router();
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { recordLedgerEntry } = require("../utils/hy");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { createRateLimiter } = require("../middleware/rateLimiter");
const {
  generateAndSendTwoFactorCode,
  verifyCode,
  clearCode,
} = require("../middleware/2fa");

const { recordPointsLedgerEntry } = require("../utils/pointsLedger");
const { findOrCreateOAuthUser } = require("../middleware/user");
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

function closePopupWithMessage(res, source) {
  res.status(200).type("html").send(`
      <script>
        window.opener && window.opener.postMessage(
          { source: ${JSON.stringify(source)}, success: true },
          ${JSON.stringify(FRONTEND_URL)}
        );
        window.close();
      </script>
    `);
}

const generateReceiptNo = (prefix = "INV") =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const twoFALimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxAttempts: 5,
  keyGenerator: (req) => `2fa:${req.body.userId || req.ip}`,
  message: "Too many verification attempts. Please request a new code.",
});

const resend2FALimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxAttempts: 3, // fewer than verify — each attempt sends a real code
  keyGenerator: (req) => `resend-2fa:${req.body.userId || req.ip}`,
  message:
    "Too many code requests. Please wait before requesting another code.",
});

function assertActive(user) {
  if (!user) {
    throw new ErrorHandler("Authentication failed: no user found", 401);
  }
  if (user.isActive === false) {
    throw new ErrorHandler(
      "Your account has been deactivated. Contact support.",
      403,
    );
  }
}
const VALID_ROLES = [
  "user",
  "admin",
  "super admin",
  "manager",
  "editor",
  "support",
  "viewer",
];

const tiktokAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) =>
    res
      .status(options.statusCode)
      .json({ error: "Too many login attempts. Please try again later." }),
});

const tiktokCallbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json({
      error: "Too many login attempts. Please try again later.",
    });
  },
});

const googleCallbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json({
      error: "Too many failed login attempts. Please try again later.",
    });
  },
});

/* ─── Stateless CSRF state for TikTok's OAuth redirect ───────────────────
   Cookie-based state (SameSite/Secure) kept failing across the cross-site
   redirect → POST /tiktok/exchange hop, so instead of storing the state
   server-side, we sign it with an HMAC. Verifying it just means
   recomputing the signature — no cookie, no storage, no cross-site
   anything for the browser to potentially block. ─── */
const TIKTOK_STATE_SECRET =
  process.env.TIKTOK_STATE_SECRET || process.env.JWT_SECRET_KEY;

function createSignedState() {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = Date.now().toString();
  const payload = `${nonce}.${timestamp}`;
  const signature = crypto
    .createHmac("sha256", TIKTOK_STATE_SECRET)
    .update(payload)
    .digest("hex");
  return `${payload}.${signature}`;
}

function verifySignedState(state) {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;

  const [nonce, timestamp, signature] = parts;
  const payload = `${nonce}.${timestamp}`;
  const expectedSignature = crypto
    .createHmac("sha256", TIKTOK_STATE_SECRET)
    .update(payload)
    .digest("hex");

  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  if (sigBuffer.length !== expectedBuffer.length) return false;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return false;

  // Reject if older than 10 minutes (prevents replay of a captured URL)
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age > 10 * 60 * 1000) return false;

  return true;
}

/* ─── Step 1: redirect the user to TikTok's consent screen ─── */
router.get("/tiktok", tiktokAuthLimiter, (req, res) => {
  const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
  const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;

  const state = createSignedState(); // was: crypto.randomBytes(...) + res.cookie(...)

  const url =
    "https://www.tiktok.com/v2/auth/authorize/" +
    "?client_key=" +
    TIKTOK_CLIENT_KEY +
    "&scope=user.info.basic" +
    "&response_type=code" +
    "&redirect_uri=" +
    encodeURIComponent(TIKTOK_REDIRECT_URI) +
    "&state=" +
    state;
  res.redirect(url);
});

/* ─── Step 2: frontend POSTs the code (and state) here ─── */
router.post(
  "/tiktok/exchange",
  catchAsyncErrors(async (req, res, next) => {
    const { code, state } = req.body;
    const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
    const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;
    const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;

    if (!code) return next(new ErrorHandler("Authorization code missing", 400));
    if (!verifySignedState(state)) {
      return next(new ErrorHandler("Invalid OAuth state (possible CSRF)", 403));
    }

    /* NOTE: frontend already decoded the query param — do NOT decodeURIComponent again.
       URLSearchParams will re-encode it correctly for TikTok. */
    const tokenRes = await axios.post(
      "https://open.tiktokapis.com/v2/oauth/token/",
      new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TIKTOK_REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );

    const { access_token } = tokenRes.data;
    if (!access_token)
      throw new ErrorHandler("TikTok did not return an access token", 401);

    const userRes = await axios.get(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,avatar_url",
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    const ttk = userRes.data?.data?.user;
    if (!ttk?.open_id)
      throw new ErrorHandler("Could not fetch TikTok profile", 400);

    const result = await findOrCreateOAuthUser("tiktok", {
      providerId: ttk.union_id || ttk.open_id,
      name: ttk.display_name,
      email: `${ttk.union_id || ttk.open_id}@tiktok.oauth.local`,
      avatarUrl: ttk.avatar_url,
    });
    const user = result.user || result;
    const isNew = result.isNew ?? false;

    assertActive(user);

    /* 2FA for elevated users — returned as JSON, frontend opens the modal */
    if (!isNew && user.role !== "user") {
      const channel = await generateAndSendTwoFactorCode(user);
      return res.status(200).json({
        source: "tiktok-oauth",
        success: true,
        require2FA: true,
        userId: user._id,
        channel,
      });
    }

    const token = user.getJwtToken();
    res.cookie("token", token, {
      expires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      httpOnly: true,
      sameSite: "none",
      secure: true,
    });

    return res
      .status(200)
      .json({ source: "tiktok-oauth", success: true, token });
  }),
);
// facebook
router.get(
  "/facebook/callback",
  passport.authenticate("facebook", {
    session: false,
    failureRedirect: `${FRONTEND_URL}/login?error=oauth_failed`,
  }),
  catchAsyncErrors((req, res) => {
    const user = req.user;
    /* ── BLOCK INACTIVE USERS ── */
    assertActive(user);
    const token = user.getJwtToken();
    res.cookie("token", token, {
      expires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      httpOnly: true,
      sameSite: "none",
      secure: true,
    });
    return closePopupWithMessage(res, "facebook-oauth");
  }),
);

router.get(
  "/google",
  googleAuthLimiter,
  (req, res, next) => {
    next();
  },
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  }),
);
// Step 2: Google redirects back here after the user approves/denies
router.get(
  "/google/callback",
  googleCallbackLimiter,
  passport.authenticate("google", {
    session: false,
    failureRedirect: `${FRONTEND_URL}/login?error=oauth_failed`,
  }),
  async (req, res) => {
    try {
      const user = req.user;
      const isNew = req.authInfo?.isNew ?? false; // depends on your strategy setup

      assertActive(user);

      if (!isNew && user.role !== "user") {
        const channel = await generateAndSendTwoFactorCode(user);
        return res.redirect(
          `${FRONTEND_URL}/oauth/result?provider=google&require2FA=true&userId=${user._id}&channel=${channel}`,
        );
      }

      const token = user.getJwtToken();

      res.cookie("token", token, {
        expires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        httpOnly: true,
        sameSite: "none",
        secure: true,
      });

      //return closePopupWithMessage(res, "google-oauth");

      return res.redirect(
        `${FRONTEND_URL}/oauth/result?provider=google&success=true&token=${token}`,
      );
    } catch (err) {
      return res.redirect(
        `${FRONTEND_URL}/oauth/result?provider=google&success=false&message=${encodeURIComponent(err.message)}`,
      );
    }
    //   catch (err) {return res.send(`
    //     <!doctype html>
    //     <script>
    //       window.opener.postMessage({
    //         source: "google-oauth",
    //         success: false,
    //         message: ${JSON.stringify(err.message)}
    //       }, "${FRONTEND_URL}");

    //       window.close();
    //     </script>
    //   `);
    // }
  },
);

// oauth
router.post(
  "/oauth-login",
  catchAsyncErrors(async (req, res, next) => {
    const { provider } = req.body;
    const verify = providerVerifiers[provider];

    if (!verify) {
      return next(new ErrorHandler("Invalid or missing OAuth provider", 400));
    }

    let profile;
    try {
      profile = await verify(req.body);
    } catch {
      return next(new ErrorHandler("Could not verify OAuth token", 401));
    }

    const { providerId, name, email, avatarUrl } = profile;
    if (!providerId) {
      return next(
        new ErrorHandler("Provider did not return an account id", 400),
      );
    }

    let user, isNew;
    try {
      const result = await findOrCreateOAuthUser(provider, profile);
      user = result.user || result;
      isNew = result.isNew ?? false;
    } catch (error) {
      if (error.code === 11000) {
        return next(
          new ErrorHandler("An account with this email already exists", 400),
        );
      }
      return next(new ErrorHandler(error.message, error.status || 500));
    }

    /* Block inactive users */
    assertActive(user, next);

    /* 2FA for existing elevated users */
    if (!isNew && user.role !== "user") {
      const channel = await generateAndSendTwoFactorCode(user);

      return res.status(200).json({
        source: "google-outh",
        success: true,
        require2FA: true,
        message: "Two-factor authentication required",
        userId: user._id,
        channel,
      });
    }

    /* New users & standard users log in directly */
    sendToken(user, 201, res);
  }),
);

/* ── Verify 2FA Code ── */
router.post(
  "/verify-2fa",
  twoFALimiter,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { userId, code } = req.body;

      if (!userId || !code) {
        return next(new ErrorHandler("User ID and code are required", 400));
      }

      const user = await User.findById(userId).select(
        "+twoFactorCode +twoFactorCodeExpire",
      );

      if (!user) {
        return next(new ErrorHandler("Invalid request", 400));
      }

      const result = verifyCode(user, code);

      if (!result.valid) {
        if (result.reason === "expired") {
          await user.save({ validateBeforeSave: false });
          return next(new ErrorHandler("Verification code has expired", 400));
        }

        return next(new ErrorHandler("Invalid verification code", 400));
      }

      clearCode(user);
      await user.save({ validateBeforeSave: false });

      sendToken(user, 200, res);
    } catch (error) {
      console.error("💥 Error in verify-2fa:", error);
      console.error("Stack trace:", error.stack);
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// routes/auth.js  — add alongside your other routes
router.post(
  "/resend-2fa",
  resend2FALimiter,
  catchAsyncErrors(async (req, res, next) => {
    const { userId } = req.body;
    const user = await User.findById(userId);
    if (!user) {
      return next(new ErrorHandler("Invalid request", 400));
    }
    const channel = await generateAndSendTwoFactorCode(user);
    res.status(200).json({ success: true, channel });
  }),
);
// user self delete route
router.delete(
  "/delete-account",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const user = await User.findById(req.user.id);

    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    user.isActive = !user.isActive;
    await user.save();

    res.clearCookie("token");

    res.status(200).json({
      success: true,
      message: "Account deleted successfully",
    });
  }),
);

//get a user
router.get(
  "/getuser",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const user = await User.findById(req.user.id);

    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }
    if (user.isActive === false) {
      res.cookie("token", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
        sameSite: "none",
        secure: true,
      });
      return next(new ErrorHandler("Your account has been deactivated.", 403));
    }

    res.status(200).json({
      success: true,
      user,
    });
  }),
);

// ── Add Address ──
// POST /add-user-address
router.post("/add-user-address", isAuthenticated, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    let { addressType = "Home", city, county, country, isDefault } = req.body;

    // Check if Home or Work already exist
    const hasHome = user.addresses.some((addr) => addr.addressType === "Home");
    const hasWork = user.addresses.some((addr) => addr.addressType === "Work");

    // Prevent duplicate Home or Work
    if (addressType === "Home" && hasHome) {
      return next(new ErrorHandler("A Home address already exists", 400));
    }
    if (addressType === "Work" && hasWork) {
      return next(new ErrorHandler("A Work address already exists", 400));
    }

    // If both Home and Work exist and user selects Home/Work, fallback or assign "Other"
    if (
      hasHome &&
      hasWork &&
      (addressType === "Home" || addressType === "Work")
    ) {
      addressType = "Other";
    }

    const newAddress = {
      addressType,
      city,
      county: county?.trim() || "",
      country,
      isDefault: isDefault ?? false,
    };

    if (user.addresses.length === 0) {
      newAddress.isDefault = true;
    }

    if (newAddress.isDefault) {
      user.addresses.forEach((addr) => {
        addr.isDefault = false;
      });
    }

    user.addresses.push(newAddress);
    await user.save();

    res.status(201).json({
      success: true,
      user,
    });
  } catch (err) {
    next(err);
  }
});

// update user addresses
router.put(
  "/update-user-addresses/:id",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);
      const address = user.addresses.id(req.params.id);

      if (!address) {
        return next(new ErrorHandler("Address not found", 404));
      }

      const { addressType, city, county, country, isDefault } = req.body;

      const normalizedType = addressType?.trim();

      // Only process if a type was provided and it's actually changing
      if (
        normalizedType &&
        normalizedType.toLowerCase() !==
          (address.addressType || "").toLowerCase()
      ) {
        // If switching TO "Home" or "Work", demote any existing one to "Other"
        if (normalizedType === "Home" || normalizedType === "Work") {
          const existing = user.addresses.find(
            (addr) =>
              addr.addressType === normalizedType &&
              addr._id.toString() !== address._id.toString(),
          );

          if (existing) {
            existing.addressType = "Other";
          }
        }

        address.addressType = normalizedType;
      }

      // Update remaining fields safely
      if (city !== undefined) address.city = city;
      if (county !== undefined) address.county = county;
      if (country !== undefined) address.country = country;

      // Handle default status toggle
      if (isDefault !== undefined) {
        if (isDefault) {
          user.addresses.forEach((addr) => {
            addr.isDefault = addr._id.toString() === address._id.toString();
          });
        } else {
          address.isDefault = false;
        }
      }

      await user.save();

      res.status(200).json({
        success: true,
        user,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// Convert points to cash

router.put(
  "/convert-points-to-cash",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const CONVERSION_RATE = 10; // 10 points = KSh 1
    const LOCK_STALE_MS = 30 * 1000; // treat locks older than 30s as abandoned

    const staleThreshold = new Date(Date.now() - LOCK_STALE_MS);

    // ── ATOMIC LOCK CLAIM: only one conversion in flight per user.
    //    A lock counts as claimable if it's not set, OR it's set but stale
    //    (left behind by a crashed request). ──
    const lockedUser = await User.findOneAndUpdate(
      {
        _id: req.user.id,
        $or: [
          { conversionLock: { $ne: true } },
          { conversionLockedAt: { $lt: staleThreshold } },
        ],
      },
      {
        $set: { conversionLock: true, conversionLockedAt: new Date() },
      },
      { returnDocument: "after" },
    );

    if (!lockedUser) {
      const exists = await User.exists({ _id: req.user.id });
      if (!exists) return next(new ErrorHandler("User not found", 404));
      return next(
        new ErrorHandler(
          "A conversion is already in progress. Please wait a moment and try again.",
          409,
        ),
      );
    }

    try {
      const user = lockedUser;

      if (!user.enrolled) {
        return next(
          new ErrorHandler(
            "You must be enrolled in the loyalty program to convert points",
            400,
          ),
        );
      }

      if (user.isActive === false) {
        return next(
          new ErrorHandler(
            "This account is frozen. Please contact support.",
            403,
          ),
        );
      }

      const { pointsToConvert } = req.body;
      const pts = parseInt(pointsToConvert, 10);

      if (!Number.isInteger(pts) || pts <= 0 || pts % CONVERSION_RATE !== 0) {
        return next(
          new ErrorHandler(
            `Points must be a positive multiple of ${CONVERSION_RATE}`,
            400,
          ),
        );
      }

      if (pts > (user.points || 0)) {
        return next(
          new ErrorHandler(
            "You don't have enough points for this conversion",
            400,
          ),
        );
      }

      const cashValue = pts / CONVERSION_RATE;
      const receiptSuffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      // ── STEP 1: Deduct points via points ledger ──
      try {
        await recordPointsLedgerEntry(user, -pts, {
          receiptNo: `CNV-PTS-${receiptSuffix}`,
          purpose: `Points to Cash Conversion (${pts} pts)`,
          type: "redeemed",
        });
      } catch (err) {
        if (err.message === "Insufficient points balance") {
          return next(
            new ErrorHandler(
              "You don't have enough points for this conversion",
              400,
            ),
          );
        }
        if (err.message?.includes("Security violation")) {
          return next(
            new ErrorHandler(
              "Points ledger mismatch detected. Account frozen — contact support.",
              422,
            ),
          );
        }
        throw err;
      }

      // ── STEP 2: Credit cash via store-credit ledger ──
      try {
        await recordLedgerEntry(user, cashValue, {
          receiptNo: `CNV-CSH-${receiptSuffix}`,
          purpose: `Points to Cash Conversion (${pts} pts → KSh ${cashValue.toFixed(2)})`,
          type: "conversion",
        });
      } catch (err) {
        console.error(
          `[CONVERSION ROLLBACK] Cash credit failed for user ${user._id}, reversing points:`,
          err.message,
        );
        try {
          const userReloaded = await User.findById(user._id);
          await recordPointsLedgerEntry(userReloaded, pts, {
            receiptNo: `CNV-REV-${receiptSuffix}`,
            purpose: "Reversal of failed points-to-cash conversion",
            type: "adjustment_credit",
          });
        } catch (rollbackErr) {
          console.error(
            "[CONVERSION ROLLBACK] Points rollback failed — manual review needed:",
            rollbackErr.message,
          );
        }

        if (err.message?.includes("Security violation")) {
          return next(
            new ErrorHandler(
              "Store credit ledger mismatch detected. Account frozen — contact support.",
              422,
            ),
          );
        }
        throw err;
      }

      const finalUser = await User.findById(user._id);

      if (!finalUser.transactions) finalUser.transactions = [];
      finalUser.transactions.unshift({
        type: "Points Conversion",
        description: `Converted ${pts} points to KSh ${cashValue.toFixed(2)}`,
        amountCredited: cashValue,
        amountDebited: 0,
        timestamp: new Date(),
      });
      await finalUser.save();

      res.status(200).json({
        success: true,
        message: `Successfully converted ${pts} points to KSh ${cashValue.toFixed(2)}!`,
        user: finalUser,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    } finally {
      // ── ALWAYS release the lock, success or failure ──
      await User.updateOne(
        { _id: req.user.id },
        { $set: { conversionLock: false, conversionLockedAt: null } },
      ).catch((e) =>
        console.error(
          `Failed to release conversion lock for ${req.user.id}:`,
          e.message,
        ),
      );
    }
  }),
);

// delete user address
router.delete(
  "/delete-user-address/:id",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const userId = req.user._id;
      const addressId = req.params.id;

      await User.updateOne(
        {
          _id: userId,
        },
        { $pull: { addresses: { _id: addressId } } },
      );

      const user = await User.findById(userId);

      res.status(200).json({ success: true, user });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// update user info
router.put(
  "/update-user-info",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { name, email, phoneNumber, dateOfBirth, country } = req.body;

      const userId = req.user?._id || req.body.userId;

      const user = await User.findById(userId);
      const sanitizeLocalPhone = (raw) =>
        (raw || "").replace(/[^0-9]/g, "").slice(0, 10);
      let cleanPhone = undefined;

      if (phoneNumber) {
        cleanPhone = sanitizeLocalPhone(phoneNumber);

        // must be 10 digits, starting with 0, then 1 or 7 (Kenyan mobile format)
        if (!/^0[17]\d{8}$/.test(cleanPhone)) {
          return res.status(400).json({
            message: "Enter a valid phone number, e.g. 0712345678",
          });
        }
      }

      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      // -------------------------
      // EMAIL
      // -------------------------
      if (email && email !== user.email) {
        const emailExists = await User.findOne({
          email: email.trim().toLowerCase(),
          _id: { $ne: user._id },
        });

        if (emailExists) {
          return next(
            new ErrorHandler(
              "Email is already registered to another account",
              400,
            ),
          );
        }

        user.email = email.trim().toLowerCase();
      }

      // -------------------------
      // PHONE NUMBER
      // -------------------------
      if (cleanPhone && cleanPhone !== user.phoneNumber) {
        const normalizedPhone = cleanPhone;

        const phoneExists = await User.findOne({
          phoneNumber: normalizedPhone,
          _id: { $ne: user._id },
        });

        if (phoneExists) {
          return next(
            new ErrorHandler(
              "Phone number is already registered to another account",
              400,
            ),
          );
        }

        user.phoneNumber = normalizedPhone;
      }

      // -------------------------
      // DATE OF BIRTH
      // -------------------------
      if (!user.dateOfBirth && dateOfBirth) {
        user.dateOfBirth = dateOfBirth;
      }

      // -------------------------
      // BASIC FIELDS
      // -------------------------
      if (name) {
        user.name = name.trim();
      }

      if (country) {
        user.country = country;
      }

      await user.save();

      res.status(200).json({
        success: true,
        user,
      });
    } catch (error) {
      // MongoDB duplicate key error
      if (error.code === 11000) {
        if (error.keyPattern?.phoneNumber) {
          return next(
            new ErrorHandler(
              "Phone number is already registered to another account",
              400,
            ),
          );
        }

        if (error.keyPattern?.email) {
          return next(
            new ErrorHandler(
              "Email is already registered to another account",
              400,
            ),
          );
        }
      }

      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// user logout
router.get(
  "/logout",
  catchAsyncErrors(async (req, res, next) => {
    try {
      res.cookie("token", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
        sameSite: "none",
        secure: true,
      });
      res.status(201).json({
        success: true,
        message: "Log out successful!",
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// user enrollment
router.put(
  "/enroll-loyalty",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const user = await User.findById(req.user.id);

    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    if (user.enrolled) {
      return res.status(200).json({
        success: true,
        message: "You are already enrolled in the loyalty program.",
        user,
      });
    }

    user.enrolled = true;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Successfully enrolled in the loyalty program.",
      user,
    });
  }),
);

// unEnroll from loyalty program
router.put(
  "/unenroll-loyalty",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!user.enrolled) {
      return res.status(400).json({
        success: false,
        message: "User is not enrolled in the loyalty program",
      });
    }

    // Update enrollment status
    user.enrolled = false;

    await user.save();

    res.status(200).json({
      success: true,
      message: "Successfully unenrolled from the loyalty program!",
      user,
    });
  }),
);

// admin get users
router.get(
  "/admin-all-users",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    try {
      const users = await User.find().sort({
        createdAt: -1,
      });
      res.status(201).json({
        success: true,
        users,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// hjk
router.put(
  "/admin-update-role/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { role } = req.body;

      if (!role || !VALID_ROLES.includes(role.toLowerCase())) {
        return next(new ErrorHandler("Invalid or missing role", 400));
      }

      const normalizedRole = role.toLowerCase();

      // Fetch the existing user document
      const targetUser = await User.findById(req.params.id);

      if (!targetUser) {
        return next(new ErrorHandler("User not found", 404));
      }

      // Only enforce rules when promoting ABOVE 'user'
      if (normalizedRole !== "user") {
        // 🔥 NEW: Check authProvider is "google"
        if (targetUser.authProvider !== "google") {
          return next(
            new ErrorHandler(
              "User must be authenticated with Google before being assigned this role. Only Google-authenticated users can have elevated privileges.",
              400,
            ),
          );
        }

        // Check email exists
        const hasEmail =
          targetUser.email !== undefined &&
          targetUser.email !== null &&
          String(targetUser.email).trim().length > 0;

        if (!hasEmail) {
          return next(
            new ErrorHandler(
              "User must have an email address before being assigned this role",
              400,
            ),
          );
        }

        // Check phone exists
        const hasPhone =
          targetUser.phoneNumber !== undefined &&
          targetUser.phoneNumber !== null &&
          String(targetUser.phoneNumber).trim().length > 0;

        if (!hasPhone) {
          return next(
            new ErrorHandler(
              "User must have a phone number before being assigned this role",
              400,
            ),
          );
        }
      }

      // Perform the update
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { role: normalizedRole },
        { new: true, runValidators: true },
      );

      res.status(200).json({
        success: true,
        message: "Role updated successfully",
        user,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);
/* ------------------------------------------------------------------ */
/* Toggle user active status (admin)                                    */
/* ------------------------------------------------------------------ */

router.put(
  "/admin-toggle-status/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    try {
      const user = await User.findById(req.params.id);

      if (!user) {
        return next(new ErrorHandler("User not found", 404));
      }

      user.isActive = !user.isActive;
      await user.save();

      res.status(200).json({
        success: true,
        message: `User ${user.isActive ? "activated" : "deactivated"} successfully`,
        user,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

module.exports = router;
