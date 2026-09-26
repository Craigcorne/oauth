const mongoose = require("mongoose");
const { Schema } = mongoose;

// ---------------------------------------------------------------------------
// Collection: a curated group of products scoped to one division (Men,
// Women, Kids, Accessories, ...). Mirrors the admin UI 1:1 — status maps to
// the Publish/Unpublish action, productIds maps to the product picker.
// ---------------------------------------------------------------------------

const DIVISIONS = ["Men", "Women", "Kids", "Unisex", "Accessories"];
const STATUSES = ["draft", "active", "archived"];

const CollectionSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    division: {
      type: String,
      required: true,
      enum: DIVISIONS,
      index: true,
    },

    status: {
      type: String,
      enum: STATUSES,
      default: "draft",
      index: true,
    },

    products: [
      {
        type: Schema.Types.ObjectId,
        ref: "Product",
        required: true,
      },
    ],

    coverImage: {
      type: String,
      default: null,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    publishedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// ✅ FIXED: removed next() callback, use throw for errors
CollectionSchema.pre("validate", function () {
  if (
    this.status === "active" &&
    (!this.products || this.products.length === 0)
  ) {
    throw new Error("Cannot publish a collection with no products.");
  }
});

// ✅ FIXED: removed next() callback
CollectionSchema.pre("save", function () {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  if (this.isModified("status")) {
    if (this.status === "active" && !this.publishedAt) {
      this.publishedAt = new Date();
    }
    if (this.status !== "active") {
      this.publishedAt = null;
    }
  }
});

CollectionSchema.index({ division: 1, status: 1 });
CollectionSchema.index({ name: "text" });

CollectionSchema.virtual("productCount").get(function () {
  return this.products ? this.products.length : 0;
});

CollectionSchema.set("toJSON", { virtuals: true });
CollectionSchema.set("toObject", { virtuals: true });

CollectionSchema.statics.DIVISIONS = DIVISIONS;
CollectionSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model("Collection", CollectionSchema);
