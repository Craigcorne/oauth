const PointsLedger = require("../models/points");
const mongoose = require("mongoose");

const POINTS_CREDIT_TYPES = ["earned", "instore_award", "adjustment_credit"];
const POINTS_DEBIT_TYPES = [
  "redeemed",
  "returned",
  "adjustment_debit",
  "expired",
];

const getPointsLedgerBalance = async (userId, session = null) => {
  const userIdStr = userId.toString?.() || String(userId);

  const userIdMatch = mongoose.Types.ObjectId.isValid(userIdStr)
    ? {
        $or: [
          { userId: userIdStr },
          { userId: new mongoose.Types.ObjectId(userIdStr) },
        ],
      }
    : {
        userId: userIdStr,
      };

  const aggregation = PointsLedger.aggregate([
    {
      $match: userIdMatch,
    },
    {
      $group: {
        _id: null,

        credits: {
          $sum: {
            $cond: [{ $in: ["$type", POINTS_CREDIT_TYPES] }, "$points", 0],
          },
        },

        debits: {
          $sum: {
            $cond: [{ $in: ["$type", POINTS_DEBIT_TYPES] }, "$points", 0],
          },
        },
      },
    },
  ]);

  if (session) {
    aggregation.session(session);
  }

  const [result] = await aggregation;

  const credits = result?.credits || 0;
  const debits = result?.debits || 0;

  return credits - debits;
};

/**
 * Verify that user.points matches the ledger.
 * If not, freeze the account immediately.
 */
const verifyPointsLedgerIntegrity = async (user, session = null) => {
  if (!user?._id) {
    return {
      valid: false,
      reason: "Invalid user",
    };
  }

  const expected = await getPointsLedgerBalance(user._id, session);
  const actual = Number(user.points || 0);

  console.log(
    `[POINTS LEDGER CHECK] User: ${user._id} | ` +
      `Ledger: ${expected} | ` +
      `User Points: ${actual} | ` +
      `Match: ${expected === actual}`,
  );

  if (expected !== actual) {
    console.error(
      `[POINTS LEDGER MISMATCH] User: ${user._id} | ` +
        `Expected: ${expected} | ` +
        `Actual: ${actual} | ` +
        `Discrepancy: ${actual - expected}`,
    );

    return {
      valid: false,
      reason: `Points ledger mismatch: expected ${expected}, found ${actual}`,
      expected,
      actual,
      discrepancy: actual - expected,
    };
  }

  return {
    valid: true,
    expected,
  };
};

/**
 * Strict points mutation: re-fetches the user inside a transaction,
 * verifies ledger, updates user, creates ledger entry — all atomically.
 * points: positive = credit, negative = debit
 */
const MAX_RETRIES = 5;

const recordPointsLedgerEntry = async (user, points, entryData) => {
  if (!user?._id) {
    throw new Error("Invalid user");
  }

  const UserModel = user.constructor;
  const { session, ...ledgerFields } = entryData;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const freshUser = await UserModel.findById(user._id).session(session);
    if (!freshUser) {
      throw new Error("User not found");
    }

    const check = await verifyPointsLedgerIntegrity(freshUser, session);

    if (!check.valid) {
      freshUser.isActive = false;
      await freshUser.save({ session });
      throw new Error(`Security violation: ${check.reason}. Account frozen.`);
    }

    const currentPoints = Number(freshUser.points || 0);
    const mutation = Number(points);
    const newBalance = currentPoints + mutation;

    if (newBalance < 0) {
      throw new Error("Insufficient points balance");
    }

    freshUser.points = newBalance;

    try {
      await freshUser.save({ session });
    } catch (err) {
      if (err instanceof mongoose.Error.VersionError) {
        continue;
      }
      throw err;
    }

    await PointsLedger.create(
      [
        {
          ...ledgerFields,
          points: Math.abs(mutation),
          balance: newBalance,
          userId: freshUser._id,
        },
      ],
      { session },
    );

    return { user: freshUser, newBalance };
  }

  throw new Error(
    "Could not update points balance after several attempts due to concurrent updates. Please try again.",
  );
};

module.exports = {
  getPointsLedgerBalance,
  verifyPointsLedgerIntegrity,
  recordPointsLedgerEntry,
  POINTS_CREDIT_TYPES,
  POINTS_DEBIT_TYPES,
};
