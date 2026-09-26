const User = require("../models/user"); // adjust path to your User model

// const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// const DEFAULT_AVATAR = {
//   public_id: "qtvdp6aomxmk9feondhr",
//   url: "https://res.cloudinary.com/bramuels/image/upload/v1741541458/do%20not%20delete/qtvdp6aomxmk9feondhr.png",
// };

// // --- Each of these calls the PROVIDER directly to verify the token and
// // pull the profile. Never trust profile data sent from the client without
// // this step, or anyone could claim to be any provider account. ---

// async function verifyFacebookToken(accessToken) {
//   if (!accessToken) throw new Error("Missing Facebook access token");

//   const { data } = await axios.get("https://graph.facebook.com/me", {
//     params: { fields: "id,name,email", access_token: accessToken },
//   });

//   return {
//     providerId: data.id,
//     name: data.name,
//     email: data.email, // Facebook only sends this if verified + granted
//     avatarUrl: `https://graph.facebook.com/${data.id}/picture?type=large`,
//   };
// }

// async function verifyGoogleToken(idToken) {
//   if (!idToken) throw new Error("Missing Google id token");

//   const ticket = await googleClient.verifyIdToken({
//     idToken,
//     audience: process.env.GOOGLE_CLIENT_ID,
//   });
//   const payload = ticket.getPayload();

//   return {
//     providerId: payload.sub,
//     name: payload.name,
//     email: payload.email,
//     avatarUrl: payload.picture,
//   };
// }

// async function verifyTikTokToken(accessToken) {
//   if (!accessToken) throw new Error("Missing TikTok access token");

//   const { data } = await axios.get(
//     "https://open.tiktokapis.com/v2/user/info/",
//     {
//       headers: { Authorization: `Bearer ${accessToken}` },
//       params: { fields: "open_id,display_name,avatar_url" },
//     },
//   );

//   const info = data?.data?.user;
//   if (!info) throw new Error("TikTok did not return user info");

//   return {
//     providerId: info.open_id,
//     name: info.display_name,
//     email: undefined, // TikTok's Login Kit never returns an email
//     avatarUrl: info.avatar_url,
//   };
// }

// Shared by both the /oauth-login route (Google/Facebook) and the TikTok
// redirect callback — same "verify provider identity, then find-or-create
// by authProvider+providerId" logic either way.

// utils/oauthHelpers.js (or wherever this function is)
// utils/oauthHelpers.js
const findOrCreateOAuthUser = async (provider, normalizedProfile) => {
  try {
    const { providerId, email, name, avatarUrl } = normalizedProfile;

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
        user.avatar = avatarUrl || user.avatar;
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
          existingUser.avatar = avatarUrl || existingUser.avatar;
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
        avatar: avatarUrl || null,
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
