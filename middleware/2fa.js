// utils/twoFactorUtils.js
const crypto = require("crypto");
const sendEmail = require("./sendMail");
// const sendSms = require("./sendSms");

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;

function generateNumericCode(length = CODE_LENGTH) {
  const max = 10 ** length; // 1_000_000 for 6 digits
  return crypto.randomInt(0, max).toString().padStart(length, "0");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Generates a 2FA code, stores its hash + expiry on the user, and sends the
 * plaintext code by email (preferred) or SMS.
 * @returns {"email" | "phone"}
 */
async function generateAndSendTwoFactorCode(user) {
  if (!user.email && !user.phoneNumber) {
    throw new Error("User has no email or phone number to verify against");
  }

  const code = generateNumericCode();

  // Store hash + expiry (never store plaintext)
  user.twoFactorCode = hashCode(code);
  user.twoFactorCodeExpire = Date.now() + CODE_TTL_MINUTES * 60 * 1000;
  await user.save({ validateBeforeSave: false });

  const message = `Your verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`;

  if (user.email) {
    await sendEmail({
      email: user.email,
      subject: "Your verification code",
      html: `<p>${message}</p>`,
    });
    return "email";
  }

  // await sendSms(user.phoneNumber, message);
  // return "phone";
}

/**
 * Verifies a 2FA code using constant-time comparison.
 * Clears expired codes immediately to prevent replay.
 * @returns {{ valid: boolean, reason: "no_code" | "expired" | "invalid" | null }}
 */
function verifyCode(user, inputCode) {
  // 1. No code on file
  if (!user.twoFactorCode || !user.twoFactorCodeExpire) {
    return { valid: false, reason: "no_code" };
  }

  // 2. Expired → clear immediately so it cannot be replayed
  if (Date.now() > user.twoFactorCodeExpire) {
    clearCode(user); // fire-and-forget; caller should await save
    return { valid: false, reason: "expired" };
  }

  // 3. Hash the input and compare in constant time
  const hashedInput = hashCode(inputCode);
  const storedHash = user.twoFactorCode;

  try {
    // timingSafeEqual requires equal-length buffers
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(storedHash, "hex"),
      Buffer.from(hashedInput, "hex"),
    );

    if (!isMatch) {
      return { valid: false, reason: "invalid" };
    }

    return { valid: true, reason: null };
  } catch {
    // Buffer length mismatch (shouldn't happen with same algo, but defensively)
    return { valid: false, reason: "invalid" };
  }
}

/**
 * Removes the 2FA code from the user document.
 * Call `await user.save({ validateBeforeSave: false })` after this.
 */
function clearCode(user) {
  user.twoFactorCode = undefined;
  user.twoFactorCodeExpire = undefined;
}

module.exports = {
  generateAndSendTwoFactorCode,
  verifyCode,
  clearCode,
  hashCode,
};
