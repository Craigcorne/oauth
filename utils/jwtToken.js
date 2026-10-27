// sendToken.js

const baseCookieOptions = require("./cookieoptions");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const sendToken = (user, statusCode, res) => {
  const token = user.getJwtToken();
  res
    .status(statusCode)
    .cookie("token", token, { ...baseCookieOptions, maxAge: ONE_DAY_MS })
    .json({ success: true, user, token });
};
module.exports = sendToken;
