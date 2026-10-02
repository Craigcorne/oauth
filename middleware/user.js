const jwt = require("jsonwebtoken");
const User = require("../models/user");

const PENDING_COOKIE = "pendingSignup";
const PENDING_TTL_MS = 15 * 60 * 1000;
const CURRENT_TERMS_VERSION = process.env.TERMS_VERSION || "2025-01";

const pendingCookieOpts = {
  httpOnly: true,
  secure: true,
  sameSite: "none", // matches your token cookie (cross-site frontend)
};

/** Find an existing user. Never creates one. Returns user or null. */
const findOAuthUser = async (provider, profile) => {
  const { providerId, email, emailVerified, avatarUrl } = profile;

  let user = await User.findOne({ providerId, authProvider: provider });

  // Link to an existing account by email ONLY if the provider verified it
  if (!user && email && emailVerified === true) {
    user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      user.providerId = providerId;
      user.authProvider = provider;
      if (avatarUrl && !user.avatar?.url) user.avatar = { url: avatarUrl };
      await user.save();
    }
  }

  if (user && !user.isActive) {
    throw new Error("Account is deactivated. Please contact support.");
  }
  return user;
};

/** Create the user. Only call after terms were accepted. */
const createOAuthUser = async (provider, profile, nameOverride) => {
  const { providerId, email, name, avatarUrl } = profile;
  return User.create({
    providerId,
    authProvider: provider,
    email: email?.toLowerCase(),
    name: (nameOverride || name || "User").trim().slice(0, 100),
    avatar: avatarUrl ? { url: avatarUrl } : null,
    isActive: true,
    termsAcceptedAt: new Date(),
    termsVersion: CURRENT_TERMS_VERSION, // server-side value, not client-supplied
  });
};

/** Store the verified profile in a signed, short-lived httpOnly cookie */
const setPendingSignup = (res, provider, profile) => {
  const token = jwt.sign(
    { purpose: "oauth-signup", provider, profile },
    process.env.JWT_SECRET_KEY,
    { expiresIn: "15m" },
  );
  res.cookie(PENDING_COOKIE, token, {
    ...pendingCookieOpts,
    maxAge: PENDING_TTL_MS,
  });
};

const readPendingSignup = (req) => {
  const raw = req.cookies?.[PENDING_COOKIE];
  if (!raw) return null;
  try {
    const p = jwt.verify(raw, process.env.JWT_SECRET_KEY);
    return p.purpose === "oauth-signup" ? p : null;
  } catch {
    return null;
  }
};

const clearPendingSignup = (res) =>
  res.clearCookie(PENDING_COOKIE, pendingCookieOpts);

module.exports = {
  findOAuthUser,
  createOAuthUser,
  setPendingSignup,
  readPendingSignup,
  clearPendingSignup,
  CURRENT_TERMS_VERSION,
};
