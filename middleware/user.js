const User = require("../models/user"); // adjust path to your User model

// Shared by both the /oauth-login route (Google/Facebook) and the TikTok
// redirect callback — same "verify provider identity, then find-or-create
// by authProvider+providerId" logic either way.

// utils/oauthHelpers.js
const findOrCreateOAuthUser = async (provider, normalizedProfile) => {
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
        // Link provider to existing user
        user.providerId = providerId;
        user.authProvider = provider;
        user.avatar = avatarObj || user.avatar;
        await user.save();
      }
    }

    // Step 3: If still no user, create one
    if (!user) {
      // Check if user already exists with this email (case insensitive)
      if (email) {
        const existingUser = await User.findOne({
          email: { $regex: new RegExp(`^${email}$`, "i") },
        });

        if (existingUser) {
          // Link to existing user
          existingUser.providerId = providerId;
          existingUser.authProvider = provider;
          existingUser.avatar = avatarObj || existingUser.avatar;
          await existingUser.save();

          return existingUser;
        }
      }

      // Create new user - MATCH YOUR SCHEMA
      user = await User.create({
        providerId: providerId,
        authProvider: provider,
        email: email,
        name: name || "User",
        avatar: avatarObj || null,
        isActive: true,
        // Don't include googleId or providers array if your schema doesn't have them
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
