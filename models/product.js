const mongoose = require("mongoose");

// Size Schema
const SizeSchema = new mongoose.Schema(
  {
    size: {
      type: String,
      required: true,
      trim: true,
    },
    sku: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    stock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  { _id: false },
);

// Color Reference Schema
const ColorSchema = new mongoose.Schema(
  {
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Color",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    hex: {
      type: String,
      required: true,
    },
  },
  { _id: false },
);

// Variant Schema
const VariantSchema = new mongoose.Schema(
  {
    color: {
      type: ColorSchema,
      required: true,
    },

    images: [
      {
        public_id: {
          type: String,
          required: true,
        },
        url: {
          type: String,
          required: true,
        },
      },
    ],

    sizes: {
      type: [SizeSchema],
      required: true,
      validate: [(arr) => arr.length > 0, "At least one size is required"],
    },
  },
  { _id: false },
);

// Product Schema
const ProductSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    averageRating: {
      type: Number,
      default: 5,
      min: 0,
      max: 5,
    },
    reviewCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    brand: {
      type: String,
      required: true,
      trim: true,
    },
    sex: {
      type: String,
      required: true,
      trim: true,
    },
    occassion: {
      type: String,
    },
    material: {
      type: String,
      required: true,
    },
    fit: {
      type: String,
      trim: true,
    },
    sleeve: {
      type: String,
      trim: true,
    },

    basePrice: {
      type: Number,
      required: true,
      min: 0,
    },
    originalPrice: {
      type: Number,
      min: 0,
    },
    currency: {
      type: String,
      default: "KES",
      uppercase: true,
    },
    sold: {
      type: Number,
      default: 0,
    },

    category: {
      _id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Category",
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
      slug: {
        type: String,
        required: true,
      },
    },
    subcategory: {
      _id: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
      slug: {
        type: String,
        required: true,
      },
    },

    variants: {
      type: [VariantSchema],
      required: true,
      validate: [(arr) => arr.length > 0, "At least one variant is required"],
    },

    availableColors: [{ type: String }],

    availableSizes: [
      {
        type: String,
        trim: true,
      },
    ],

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports =
  mongoose.models.Product || mongoose.model("Product", ProductSchema);
