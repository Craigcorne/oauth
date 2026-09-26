const mongoose = require("mongoose");

const ReviewImageSchema = new mongoose.Schema(
  {
    public_id: { type: String, required: true },
    url: { type: String, required: true },
  },
  { _id: false },
);

const ReviewSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    images: {
      type: [ReviewImageSchema],
      default: [],
      validate: [(arr) => arr.length <= 2, "Maximum 2 images allowed"],
    },
  },
  { timestamps: true },
);

// One review per user per product per order
ReviewSchema.index({ user: 1, product: 1, order: 1 }, { unique: true });

// For product average rating calculations
ReviewSchema.index({ product: 1, createdAt: -1 });

module.exports = mongoose.model("Review", ReviewSchema);
