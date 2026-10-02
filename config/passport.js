const passport = require("passport");
require("dotenv").config();
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const { findOrCreateOAuthUser } = require("../middleware/user");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
      passReqToCallback: true, // gives the verify function access to req
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const mode = req.query.state === "signin" ? "signin" : "signup";

        const normalizedProfile = {
          providerId: profile.id,
          name: profile.displayName,
          email: profile.emails?.[0]?.value,
          avatarUrl: profile.photos?.[0]?.value,
        };

        if (!normalizedProfile.providerId) {
          return done(new Error("Google did not return an account id"), null);
        }
        if (!normalizedProfile.email) {
          return done(
            new Error("Google account has no accessible email"),
            null,
          );
        }

        const user = await findOrCreateOAuthUser("google", normalizedProfile, {
          createIfMissing: mode === "signup",
        });

        if (!user) {
          return done(null, false, {
            code: "ACCOUNT_NOT_FOUND",
            message: "No account found. Please sign up first.",
          });
        }

        return done(null, user);
      } catch (error) {
        if (error.code === 11000) {
          return done(
            new Error("An account with this email already exists"),
            null,
          );
        }
        return done(error, null);
      }
    },
  ),
);

// passport.use(
//   new FacebookStrategy(
//     {
//       clientID: process.env.FACEBOOK_APP_ID,
//       clientSecret: process.env.FACEBOOK_APP_SECRET,
//       callbackURL: process.env.FACEBOOK_CALLBACK_URL,
//       profileFields: ["id", "displayName", "photos", "email"], // unlike Google, Facebook sends almost nothing unless you name the fields
//       graphAPIVersion: "v25.0", // Meta retires old versions on a schedule — check developers.facebook.com/docs/graph-api/changelog/versions occasionally
//     },
//     async (accessToken, refreshToken, profile, done) => {
//       try {
//         const normalizedProfile = {
//           providerId: profile.id,
//           name: profile.displayName,
//           email: profile.emails?.[0]?.value,
//           avatarUrl: profile.photos?.[0]?.value,
//         };

//         if (!normalizedProfile.providerId) {
//           return done(new Error("Facebook did not return an account id"), null);
//         }
//         if (!normalizedProfile.email) {
//           // happens if the account has no verified email, or the person
//           // declined the email permission on the consent dialog
//           return done(
//             new Error("Facebook account has no accessible email"),
//             null,
//           );
//         }

//         const user = await findOrCreateOAuthUser("facebook", normalizedProfile);
//         return done(null, user);
//       } catch (error) {
//         if (error.code === 11000) {
//           return done(
//             new Error("An account with this email already exists"),
//             null,
//           );
//         }
//         return done(error, null);
//       }
//     },
//   ),
// );

// No serializeUser/deserializeUser — routes below run with { session: false }
// and hand back a JWT instead of a server session, same as the rest of your auth.

module.exports = passport;
