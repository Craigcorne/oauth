const mongoose = require("mongoose");

const returnItemSchema = new mongoose.Schema(
  {
    productId: String,
    name: String,
    quantity: Number,
    reason: String,
    refundAmount: Number,
    pointsDeducted: Number,
    returnedAt: Date,
  },
  { _id: false },
);

const returnBatchSchema = new mongoose.Schema(
  {
    returnId: String,
    returnedAt: Date,
    items: [returnItemSchema],
    totalRefund: Number,
    totalPointsDeducted: Number,
    status: { type: String, default: "Approved" },
    initiatedBy: String, // admin user ID
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema({
  orderNo: {
    type: String,
    required: true,
  },
  referee: {
    type: String,
  },
  cart: {
    type: Array,
    required: true,
  },
  shippingAddress: {
    type: Object,
    required: true,
  },
  user: {
    type: Object,
    required: true,
  },
  totalPrice: {
    type: Number,
    required: true,
  },
  shippingPrice: {
    type: Number,
    required: true,
  },
  discount: {
    type: Number,
  },
  balance: {
    type: Number,
    default: 0,
  },
  promoCode: {
    type: String,
  },
  status: {
    type: String,
    default: "Processing",
  },
  phoneNumber: {
    type: String,
  },
  paymentMethod: {
    type: String,
    required: true,
  },
  paidAt: {
    type: Date,
    default: null,
  },
  deliveredAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },

  returns: {
    type: [returnBatchSchema],
    default: [],
  },
  pointsAwardedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
});

module.exports = mongoose.models.Order || mongoose.model("Order", orderSchema);
