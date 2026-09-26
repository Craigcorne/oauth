const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please enter your name!"],
    },
    // Optional: TikTok never returns an email, and Facebook only returns
    // one if the user has a verified email and grants the permission —
    // so no provider can be relied on to supply it.
    email: {
      type: String,
    },
    dateOfBirth: {
      type: Date,
    },

    phoneNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    points: {
      type: Number,
      default: 0,
    },
    enrolled: {
      type: Boolean,
      default: false,
    },
    availableBalance: {
      type: Number,
      default: 0,
    },
    refCode: {
      type: String,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    deactivatedAt: {
      type: Date,
      default: null,
    },

    country: {
      type: String,
      default: "Kenya",
    },
    addresses: [
      {
        country: {
          type: String,
        },
        county: {
          type: String,
        },
        city: {
          type: String,
        },
        addressType: {
          type: String,
          default: "Home",
        },

        isDefault: {
          type: Boolean,
          default: false,
        },
      },
    ],
    wishlist: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    role: {
      type: String,
      default: "user",
    },
    avatar: {
      public_id: {
        type: String,
      },
      url: {
        type: String,
      },
    },

    // --- OAuth-only auth fields (replaces password-based login) ---
    authProvider: {
      type: String,
      enum: ["facebook", "tiktok", "google"],
      required: [true, "Auth provider is required"],
    },
    providerId: {
      type: String,
      required: [true, "Provider account id is required"],
    },

    twoFactorCode: {
      type: String,
      select: false,
    },
    twoFactorCodeExpire: {
      type: Date,
      select: false,
    },
    conversionLock: {
      type: Boolean,
      default: false,
    },
    conversionLockedAt: {
      type: Date,
      default: null,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    optimisticConcurrency: true,
  },
);

// Prevent duplicate accounts for the same provider account
userSchema.index({ authProvider: 1, providerId: 1 }, { unique: true });

// Enforce email uniqueness only for documents that actually have one,
// so multiple users with no email (from any provider) don't collide on `null`
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } },
);

userSchema.pre("save", function () {
  if (this.isModified("isActive")) {
    if (!this.isActive) {
      this.deactivatedAt = new Date();
    } else {
      this.deactivatedAt = null;
    }
  }
});

// jwt token
userSchema.methods.getJwtToken = function () {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET_KEY, {
    expiresIn: process.env.JWT_EXPIRES,
  });
};

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
