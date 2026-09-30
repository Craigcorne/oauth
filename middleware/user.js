const User = require("../models/user"); // adjust path to your User model

// Shared by both the /oauth-login route (Google/Facebook) and the TikTok
// redirect callback — same "verify provider identity, then find-or-create
// by authProvider+providerId" logic either way.

// utils/oauthHelpers.js
const findOrCreateOAuthUser = async (provider, profile) => {
  const { providerId, name, avatarUrl } = profile;
  const email = profile.email?.trim().toLowerCase() || undefined;
  const avatar = avatarUrl ? { url: avatarUrl } : undefined;

  // 1. Returning OAuth user
  let user = await User.findOne({ authProvider: provider, providerId });
  if (user) return { user, created: false };

  // 2. Existing account with same email
  if (email) {
    const existing = await User.findOne({ email });
    if (existing) {
      if (!emailVerified) {
        const err = new Error("Email not verified by provider");
        err.status = 403;
        throw err;
      }
      // Safest: refuse and require login + manual linking instead:
      // const err = new Error("Account exists. Log in and link this provider."); err.status = 409; throw err;
      existing.providerId = providerId;
      existing.authProvider = provider;
      if (!existing.avatar?.url && avatar) existing.avatar = avatar;
      await existing.save();
      return { user: existing, created: false };
    }
  }

  // 3. Create
  try {
    user = await User.create({
      providerId,
      authProvider: provider,
      email,
      name: name || "User",
      avatar,
      isActive: true,
    });
    return { user, created: true };
  } catch (err) {
    if (err.code === 11000) {
      const again = await User.findOne({ authProvider: provider, providerId });
      if (again) return { user: again, created: false };
    }
    throw err;
  }
};
module.exports = { findOrCreateOAuthUser };
