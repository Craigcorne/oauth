const Invoice = require("../models/invoice");
const mongoose = require("mongoose");

// Types that affect the user's store credit balance
const CREDIT_TYPES = ["conversion", "refund", "adjustment_credit"];
const DEBIT_TYPES = ["store_credit_payment", "adjustment_debit"];
const MAX_RETRIES = 5;

const getLedgerBalance = async (userId, session = null) => {
  const userIdStr = userId.toString?.() || String(userId);

  const userIdMatch = mongoose.Types.ObjectId.isValid(userIdStr)
    ? {
        $or: [
          { userId: userIdStr },
          { userId: new mongoose.Types.ObjectId(userIdStr) },
        ],
      }
    : { userId: userIdStr };

  const creditAggQuery = Invoice.aggregate([
    { $match: { ...userIdMatch, type: { $in: CREDIT_TYPES } } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const debitAggQuery = Invoice.aggregate([
    { $match: { ...userIdMatch, type: { $in: DEBIT_TYPES } } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  if (session) {
    creditAggQuery.session(session);
    debitAggQuery.session(session);
  }

  const [[creditAgg], [debitAgg]] = await Promise.all([
    creditAggQuery,
    debitAggQuery,
  ]);

  const credits = creditAgg?.total || 0;
  const debits = debitAgg?.total || 0;

  return Math.round((credits - debits) * 100) / 100;
};

const verifyLedgerIntegrity = async (user, session = null) => {
  if (!user?._id) return { valid: false, reason: "Invalid user" };

  const expected = await getLedgerBalance(user._id, session);
  const actual = Math.round((user.availableBalance || 0) * 100) / 100;

  console.log(
    `[LEDGER CHECK] User: ${user._id} | Ledger: ${expected} | User Balance: ${actual} | Match: ${expected === actual}`,
  );

  if (expected !== actual) {
    console.error(
      `[LEDGER MISMATCH] User: ${user._id} | Expected: ${expected} | Actual: ${actual} | Discrepancy: ${actual - expected}`,
    );
    return {
      valid: false,
      reason: `Ledger mismatch: expected ${expected}, found ${actual}`,
      expected,
      actual,
      discrepancy: actual - expected,
    };
  }

  return { valid: true, expected };
};

const recordLedgerEntry = async (user, amount, invoiceData) => {
  if (!user?._id) {
    throw new Error("Invalid user");
  }

  const UserModel = user.constructor;
  const { session, ...invoiceFields } = invoiceData;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const freshUser = await UserModel.findById(user._id).session(session);
    if (!freshUser) {
      throw new Error("User not found");
    }

    const check = await verifyLedgerIntegrity(freshUser, session);
    if (!check.valid) {
      freshUser.isActive = false;
      await freshUser.save({ session });
      throw new Error(`Security violation: ${check.reason}. Account frozen.`);
    }

    const newBalance =
      Math.round(((freshUser.availableBalance || 0) + amount) * 100) / 100;
    if (newBalance < 0) {
      throw new Error("Insufficient store credit");
    }

    freshUser.availableBalance = newBalance;

    try {
      await freshUser.save({ session });
    } catch (err) {
      if (err instanceof mongoose.Error.VersionError) {
        continue; // lost the race against another save — retry with a fresh copy
      }
      throw err;
    }

    await Invoice.create(
      [
        {
          ...invoiceFields,
          amount: Math.abs(amount),
          balance: newBalance,
          userId: freshUser._id.toString?.() || freshUser._id,
          paid: { status: true, paidAt: new Date() },
        },
      ],
      { session },
    );

    return { user: freshUser, newBalance };
  }

  throw new Error(
    "Could not update store credit balance after several attempts due to concurrent updates. Please try again.",
  );
};

module.exports = {
  getLedgerBalance,
  verifyLedgerIntegrity,
  recordLedgerEntry,
  CREDIT_TYPES,
  DEBIT_TYPES,
};
