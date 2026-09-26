const mongoose = require("mongoose");

const InvoiceSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    purpose: { type: String, required: true },
    paid: {
      status: { type: Boolean, default: false },
      paidAt: { type: Date },
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    balance: { type: Number, required: true },
    type: {
      type: String,
      default: "invoice",
      enum: [
        "invoice",
        "purchase",
        "conversion",
        "refund",
        "adjustment_debit",
        "adjustment_credit",
        "store_credit_payment",
        "income",
        "expense",
      ],
    },
    orderId: { type: String, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

// ═══════════════════════════════════════════════════════════════════════
// PRE-SAVE: snapshot user points before writing a return-type invoice
// ═══════════════════════════════════════════════════════════════════════
InvoiceSchema.pre("save", function () {
  if (
    this.isNew &&
    ["refund", "adjustment_debit", "adjustment_credit"].includes(this.type)
  ) {
    // Store on the document instance for the post hook to read
    this._pointsSnapshot = undefined;
  }
});

// Async pre-save to fetch the actual points value
InvoiceSchema.pre("save", async function () {
  if (
    this.isNew &&
    ["refund", "adjustment_debit", "adjustment_credit"].includes(this.type)
  ) {
    try {
      const User = mongoose.model("User");
      const user = await User.findById(this.userId).lean();
      this._pointsSnapshot = user?.points || 0;
    } catch (e) {
      this._pointsSnapshot = undefined;
    }
  }
});

InvoiceSchema.post("save", async function (doc) {
  const GUARDED_TYPES = ["refund", "adjustment_debit", "adjustment_credit"];
  if (!GUARDED_TYPES.includes(doc.type)) return;
  if (!doc.paid?.status) return;

  const expected = doc._pointsSnapshot;
  if (expected === undefined) return;

  try {
    const User = mongoose.model("User");
    const user = await User.findById(doc.userId);
    if (!user) return;

    if ((user.points || 0) !== expected) {
      console.error(
        `[INVOICE GUARD] ${doc.type} invoice ${doc.receiptNo} caused points drift: ${expected} → ${user.points}. Reverting.`,
      );
      user.points = expected;
      await user.save();
    }
  } catch (err) {
    console.error("[INVOICE GUARD] Failed to revert points:", err.message);
  }
});

module.exports = mongoose.model("Invoice", InvoiceSchema);
