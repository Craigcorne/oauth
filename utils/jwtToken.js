const baseCookieOptions = require("./cookieoptions");

const isProd = process.env.NODE_ENV === "production";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const setAuthCookie = (res, user) => {
  // Wipe the legacy host-only cookie so it can't shadow the new domain-wide one
  if (isProd) {
    res.clearCookie("token", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
    });
  }
  res.cookie("token", user.getJwtToken(), {
    ...baseCookieOptions,
    maxAge: ONE_DAY_MS,
  });
};

const sendToken = (user, statusCode, res) => {
  setAuthCookie(res, user);
  res.status(statusCode).json({ success: true, user });
};

module.exports = sendToken;
module.exports.setAuthCookie = setAuthCookie;
