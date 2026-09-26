const mongoose = require("mongoose");

const qrCodeSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    sku: {
      type: String,
      required: true,
      index: true,
    },
    slug: {
      type: String,
      required: true,
    },
    data: {
      // JSON string: {"sku":"...","slug":"..."}
      type: String,
      required: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
    publicId: {
      type: String,
      required: true,
    },
    uploaded: {
      type: Boolean,
      default: false,
    },
    printCount: {
      type: Number,
      default: 1,
      min: 0,
    },
  },
  { timestamps: true },
);

// One QR code per product-size
qrCodeSchema.index({ product: 1, sku: 1 }, { unique: true });

module.exports = mongoose.model("QRCode", qrCodeSchema);
