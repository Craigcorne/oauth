// utils/cookieOptions.js
const isProd = process.env.NODE_ENV === "production";

module.exports = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  // A domain cookie can't be set from localhost, so only use it in production
  ...(isProd && { domain: ".ninetyone.co.ke" }),
};
