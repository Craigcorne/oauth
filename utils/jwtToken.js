// // sendToken.js

// const baseCookieOptions = require("./cookieoptions");

// const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// const sendToken = (user, statusCode, res) => {
//   const token = user.getJwtToken();
//   res
//     .status(statusCode)
//     .cookie("token", token, { ...baseCookieOptions, maxAge: ONE_DAY_MS })
//     .json({ success: true, user, token });
// };
// module.exports = sendToken;
// utils/jwtToken.js
const baseCookieOptions = require("./cookieoptions");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const setAuthCookie = (res, user) => {
  const token = user.getJwtToken();
  res.cookie("token", token, { ...baseCookieOptions, maxAge: ONE_DAY_MS });
};

const sendToken = (user, statusCode, res) => {
  setAuthCookie(res, user);
  res.status(statusCode).json({ success: true, user });
};

module.exports = sendToken;
module.exports.setAuthCookie = setAuthCookie;
