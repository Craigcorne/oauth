const mongoose = require("mongoose");

const pointsLedgerSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, unique: true },
    points: { type: Number, required: true }, // always stored positive; type implies direction
    balance: { type: Number, required: true }, // resulting points balance after this entry
    type: {
      type: String,
      required: true,
      enum: [
        "earned", // credit — from a purchase
        "instore_award", // credit — manually awarded by staff
        "adjustment_credit", // credit — manual correction
        "redeemed", // debit — spent on something
        "adjustment_debit", // debit — manual correction
        "expired",
        "returned", // debit — points expiry
      ],
    },
    purpose: { type: String, required: true },
    userId: { type: String, required: true },
    orderId: { type: String },
  },
  { timestamps: true },
);

pointsLedgerSchema.index({ userId: 1 });

module.exports = mongoose.model("PointsLedger", pointsLedgerSchema);
