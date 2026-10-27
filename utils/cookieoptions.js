// utils/cookieOptions.js  (adjust the folder to match your project)
const isProd = process.env.NODE_ENV === "production";

const baseCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  ...(isProd && { domain: ".ninetyone.co.ke" }),
};

module.exports = baseCookieOptions;
