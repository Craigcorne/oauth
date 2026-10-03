const User = require("../models/user");

class UserNotFoundError extends Error {
  constructor() {
    super("User not found. Please create an account.");
    this.name = "UserNotFoundError";
    this.code = "USER_NOT_FOUND";
  }
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findOrCreateOAuthUser = async (
  provider,
  normalizedProfile,
  { allowCreate = true } = {},
) => {
  const { providerId, email, name, avatarUrl } = normalizedProfile;
  const avatarObj = avatarUrl ? { url: avatarUrl } : undefined;

  // 1. Already linked to this provider
  let user = await User.findOne({ providerId, authProvider: provider });

  // 2. Existing account with the same email -> link it
  if (!user && email) {
    user = await User.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") },
    });
    if (user) {
      if (!user.isActive) {
        throw new Error("Account is deactivated. Please contact support.");
      }
      user.providerId = providerId;
      user.authProvider = provider;
      user.avatar = avatarObj || user.avatar;
      await user.save();
    }
  }

  // 3. Nobody found: only create when this is a sign-UP
  if (!user) {
    if (!allowCreate) throw new UserNotFoundError();

    user = await User.create({
      providerId,
      authProvider: provider,
      email,
      name: name || "User",
      avatar: avatarObj || null,
      isActive: true,
    });
  }

  if (!user.isActive) {
    throw new Error("Account is deactivated. Please contact support.");
  }

  return user;
};

module.exports = { findOrCreateOAuthUser, UserNotFoundError };
