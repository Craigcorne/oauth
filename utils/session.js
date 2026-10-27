// utils/session.js
const save = (req) =>
  new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );

const regenerate = (req) =>
  new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );

// Fully authenticated
exports.loginSession = async (req, user) => {
  await regenerate(req); // new session ID, prevents fixation
  req.session.userId = user._id.toString();
  await save(req);
};

// Password/OAuth done, 2FA code still outstanding. NOT authenticated.
exports.startPending2FA = async (req, user) => {
  await regenerate(req);
  req.session.pending2fa = {
    userId: user._id.toString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  await save(req);
};
