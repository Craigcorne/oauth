// create token and saving that in cookies
const sendToken = (user, statusCode, res) => {
  const token = user.getJwtToken();
  const TWO_DAYS_MS = 1 * 24 * 60 * 60 * 1000; // 172,800,000 ms

  // Options for cookies
  const options = {
    expires: new Date(Date.now() + TWO_DAYS_MS),
    maxAge: TWO_DAYS_MS,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  };

  res.status(statusCode).cookie("token", token, options).json({
    success: true,
    user,
    token,
  });
};

module.exports = sendToken;
