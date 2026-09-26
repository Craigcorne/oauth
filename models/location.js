const mongoose = require("mongoose");

// Delivery Method Schema
const DeliveryMethodSchema = new mongoose.Schema(
  {
    available: {
      type: Boolean,
      default: true,
    },
    price: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false },
);

// Delivery Schema
const DeliverySchema = new mongoose.Schema(
  {
    express: {
      type: DeliveryMethodSchema,
      default: () => ({}),
    },
    standard: {
      type: DeliveryMethodSchema,
      default: () => ({}),
    },
  },
  { _id: false },
);

// Town Schema
const TownSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  delivery: {
    type: DeliverySchema,
    default: () => ({}),
  },
});

// County Schema
const CountySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  delivery: {
    type: DeliverySchema,
    default: () => ({}),
  },
  towns: {
    type: [TownSchema],
    default: [],
  },
});

// Country Schema
const LocationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
    },
    counties: {
      type: [CountySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

module.exports =
  mongoose.models.Location || mongoose.model("Location", LocationSchema);
