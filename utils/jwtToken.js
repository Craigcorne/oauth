// // create token and saving that in cookies
// const sendToken = (user, statusCode, res) => {
//   const token = user.getJwtToken();
//   const TWO_DAYS_MS = 1 * 24 * 60 * 60 * 1000; // 172,800,000 ms

//   // Options for cookies
//   const options = {
//     expires: new Date(Date.now() + TWO_DAYS_MS),
//     maxAge: TWO_DAYS_MS,
//     httpOnly: true,
//     secure: process.env.NODE_ENV === "production",
//     sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
//   };

//   res.status(statusCode).cookie("token", token, options).json({
//     success: true,
//     user,
//     token,
//   });
// };

// module.exports = sendToken;
const isProd = process.env.NODE_ENV === "production";

const SESSION_MS = 24 * 60 * 60 * 1000; // 1 day. Use 2 * ... for 2 days

// Exported so logout can clear the cookie with the exact same options
const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? "none" : "lax", // switch to "lax" once the API is on api.ninetyone.co.ke
  path: "/",
};

const sendToken = (user, statusCode, res) => {
  const token = user.getJwtToken();

  // Never send secrets to the browser
  const safeUser = user.toObject ? user.toObject() : { ...user };
  delete safeUser.password;
  delete safeUser.twoFactorCode;
  delete safeUser.twoFactorCodeExpire;
  delete safeUser.twoFactorAttempts;
  delete safeUser.tokenVersion;

  res
    .status(statusCode)
    .cookie("token", token, { ...cookieOptions, maxAge: SESSION_MS })
    .json({
      success: true,
      user: safeUser,
      // no `token` here: the browser only gets the httpOnly cookie
    });
};

module.exports = sendToken;
module.exports.cookieOptions = cookieOptions;
module.exports.SESSION_MS = SESSION_MS;
