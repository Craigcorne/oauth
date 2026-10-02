const User = require("../models/user");

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findOrCreateOAuthUser = async (
  provider,
  normalizedProfile,
  { createIfMissing = true } = {},
) => {
  try {
    const { providerId, email, name, avatarUrl } = normalizedProfile;

    const avatarObj = avatarUrl ? { url: avatarUrl } : undefined;

    // Step 1: Try to find user by providerId and authProvider
    let user = await User.findOne({
      providerId: providerId,
      authProvider: provider,
    });

    // Step 2: If not found, try by email
    if (!user && email) {
      user = await User.findOne({ email });

      if (user) {
        user.providerId = providerId;
        user.authProvider = provider;
        user.avatar = avatarObj || user.avatar;
        await user.save();
      }
    }

    // Step 3: If still no user, try a case-insensitive email match, then create
    if (!user) {
      if (email) {
        const existingUser = await User.findOne({
          email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") },
        });

        if (existingUser) {
          existingUser.providerId = providerId;
          existingUser.authProvider = provider;
          existingUser.avatar = avatarObj || existingUser.avatar;
          await existingUser.save();

          return existingUser;
        }
      }

      // Sign-in mode: no account exists, so don't create one
      if (!createIfMissing) return null;

      user = await User.create({
        providerId: providerId,
        authProvider: provider,
        email: email,
        name: name || "User",
        avatar: avatarObj || null,
        isActive: true,
      });
    }

    // Step 4: Check if user is active
    if (!user.isActive) {
      throw new Error("Account is deactivated. Please contact support.");
    }

    return user;
  } catch (error) {
    console.error("Error in findOrCreateOAuthUser:", error);
    throw error;
  }
};

module.exports = { findOrCreateOAuthUser };
