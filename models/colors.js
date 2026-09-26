const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    name: { type: String, unique: true, required: true },
    hex: { type: String, required: true },
    family: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

// Reuse compiled model if it already exists
const Color = mongoose.models.Color || mongoose.model("Color", schema);

module.exports = Color;
