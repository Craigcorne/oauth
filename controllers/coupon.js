const Coupon = require("../models/coupon");
const Order = require("../models/order");
const router = require("express").Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeCode(code) {
  return code.toString().toUpperCase().trim().replace(/\s+/g, "");
}

/* ------------------------------------------------------------------ */
/* Create Coupon                                                      */
/* ------------------------------------------------------------------ */

router.post(
  "/create-coupon",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const {
      code,
      name,
      description,
      type,
      value,
      maxDiscount,
      minimumSpend,
      usageLimit,
      usagePerCustomer,
      startDate,
      endDate,
      isActive,
      applicableCategories,
      customerIds,
    } = req.body;

    // Required fields
    if (
      !code ||
      !name ||
      !type ||
      value === undefined ||
      !startDate ||
      !endDate
    ) {
      return next(
        new ErrorHandler(
          "Code, name, type, value, startDate and endDate are required",
          400,
        ),
      );
    }

    // Validate type
    const validTypes = ["percentage", "fixed", "free_shipping"];
    if (!validTypes.includes(type)) {
      return next(
        new ErrorHandler(
          "Type must be percentage, fixed, or free_shipping",
          400,
        ),
      );
    }

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return next(new ErrorHandler("Invalid date format", 400));
    }
    if (end <= start) {
      return next(new ErrorHandler("End date must be after start date", 400));
    }

    // Validate value
    if (type === "percentage" && (value < 0 || value > 100)) {
      return next(
        new ErrorHandler("Percentage value must be between 0 and 100", 400),
      );
    }
    if ((type === "fixed" || type === "free_shipping") && value < 0) {
      return next(new ErrorHandler("Value cannot be negative", 400));
    }

    const coupon = await Coupon.create({
      code: normalizeCode(code),
      name: name.trim(),
      description: description?.trim() || "",
      type,
      value: Number(value),
      maxDiscount: maxDiscount ? Number(maxDiscount) : null,
      minimumSpend: minimumSpend ? Number(minimumSpend) : 0,
      usageLimit: usageLimit ? Number(usageLimit) : 0,
      usagePerCustomer: usagePerCustomer ? Number(usagePerCustomer) : 1,
      startDate: start,
      endDate: end,
      isActive: isActive !== undefined ? isActive : true,
      applicableCategories: applicableCategories || [],
      customerIds: customerIds || [],
      createdBy: req.user?._id || null,
    });

    res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      coupon,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Get All Coupons                                                    */
/* ------------------------------------------------------------------ */

router.get(
  "/get-all-coupons",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const {
      isActive,
      type,
      search,
      page = 1,
      limit = 20,
      sort = "-createdAt",
    } = req.query;

    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (type) filter.type = type;
    if (search) {
      filter.$or = [
        { code: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [coupons, total] = await Promise.all([
      Coupon.find(filter)
        .populate("applicableCategories", "name slug")
        .populate("customerIds", "name email")
        .populate("createdBy", "name email")
        .sort(sort)
        .skip(skip)
        .limit(Number(limit)),
      Coupon.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      coupons,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Get Single Coupon                                                  */
/* ------------------------------------------------------------------ */

router.get(
  "/get-coupon/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const coupon = await Coupon.findById(req.params.id)
      .populate("applicableCategories", "name slug")
      .populate("customerIds", "name email")
      .populate("createdBy", "name email");

    if (!coupon) {
      return next(new ErrorHandler("Coupon not found", 404));
    }

    res.status(200).json({
      success: true,
      coupon,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Update Coupon                                                      */
/* ------------------------------------------------------------------ */
router.put(
  "/update-coupon/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    let coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return next(new ErrorHandler("Coupon not found", 404));
    }

    const {
      code,
      name,
      description,
      type,
      value,
      maxDiscount,
      minimumSpend,
      usageLimit,
      usagePerCustomer,
      startDate,
      endDate,
      isActive,
      applicableCategories,
      customerIds,
    } = req.body;

    const update = {};

    if (code !== undefined) update.code = normalizeCode(code);
    if (name !== undefined) update.name = name.trim();
    if (description !== undefined) update.description = description.trim();
    if (type !== undefined) {
      const validTypes = ["percentage", "fixed", "free_shipping"];
      if (!validTypes.includes(type)) {
        return next(new ErrorHandler("Invalid coupon type", 400));
      }
      update.type = type;
    }
    if (value !== undefined) update.value = Number(value);
    if (maxDiscount !== undefined)
      update.maxDiscount = maxDiscount ? Number(maxDiscount) : null;
    if (minimumSpend !== undefined) update.minimumSpend = Number(minimumSpend);
    if (usageLimit !== undefined) update.usageLimit = Number(usageLimit);
    if (usagePerCustomer !== undefined)
      update.usagePerCustomer = Number(usagePerCustomer);
    if (isActive !== undefined) update.isActive = isActive;
    if (applicableCategories !== undefined)
      update.applicableCategories = applicableCategories;
    if (customerIds !== undefined) update.customerIds = customerIds;

    // Date validation
    const newStart = startDate ? new Date(startDate) : coupon.startDate;
    const newEnd = endDate ? new Date(endDate) : coupon.endDate;
    if (startDate || endDate) {
      if (newEnd <= newStart) {
        return next(new ErrorHandler("End date must be after start date", 400));
      }
      update.startDate = newStart;
      update.endDate = newEnd;
    }

    // Value validation after type/value updates
    const finalType = update.type || coupon.type;
    const finalValue = update.value !== undefined ? update.value : coupon.value;
    if (finalType === "percentage" && (finalValue < 0 || finalValue > 100)) {
      return next(
        new ErrorHandler("Percentage value must be between 0 and 100", 400),
      );
    }

    coupon = await Coupon.findByIdAndUpdate(req.params.id, update, {
      returnDocument: "after",
      runValidators: true,
    });

    res.status(200).json({
      success: true,
      message: "Coupon updated successfully",
      coupon,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Delete Coupon                                                      */
/* ------------------------------------------------------------------ */
router.delete(
  "/delete-coupon/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return next(new ErrorHandler("Coupon not found", 404));
    }

    await coupon.deleteOne();

    res.status(200).json({
      success: true,
      message: "Coupon deleted successfully",
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Validate Coupon (customer-facing)                                  */
/* ------------------------------------------------------------------ */
// Customer-facing (optional — can be public or auth-protected)
router.post(
  "/validate",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { code, cartTotal, userId, shippingMethod } = req.body;

    if (!code) {
      return next(new ErrorHandler("Coupon code is required", 400));
    }

    const coupon = await Coupon.findOne({ code: normalizeCode(code) });
    if (!coupon) {
      return next(new ErrorHandler("Invalid coupon code", 404));
    }

    if (!coupon.isActive) {
      return next(new ErrorHandler("This coupon is no longer active", 400));
    }

    const now = new Date();
    if (now < coupon.startDate || now > coupon.endDate) {
      return next(
        new ErrorHandler("This coupon has expired or is not yet valid", 400),
      );
    }

    if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
      return next(
        new ErrorHandler("This coupon has reached its usage limit", 400),
      );
    }

    if (userId && coupon.customerIds.length > 0) {
      const isEligible = coupon.customerIds.some(
        (id) => id.toString() === userId,
      );
      if (!isEligible) {
        return next(
          new ErrorHandler("You are not eligible for this coupon", 403),
        );
      }
    }

    // ── Per-customer usage limit ──
    if (userId && coupon.usagePerCustomer > 0) {
      const customerUsage = await Order.countDocuments({
        promoCode: coupon.code,
        "user._id": userId,
        status: { $nin: ["Cancelled", "Refunded"] },
      });

      if (customerUsage >= coupon.usagePerCustomer) {
        return next(
          new ErrorHandler(
            `You've already used this code the maximum ${coupon.usagePerCustomer} time(s)`,
            400,
          ),
        );
      }
    }

    if (cartTotal !== undefined && cartTotal < coupon.minimumSpend) {
      return next(
        new ErrorHandler(
          `Minimum spend of KES ${coupon.minimumSpend} required`,
          400,
        ),
      );
    }

    let discount = 0;

    if (coupon.type === "percentage") {
      discount = (cartTotal * coupon.value) / 100;
      // Cap at maxDiscount when it is explicitly set (including 0)
      if (coupon.maxDiscount != null && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount;
      }
    } else if (coupon.type === "fixed") {
      discount = Math.min(coupon.value, cartTotal); // never exceed cart value
    } else if (coupon.type === "free_shipping") {
      if (shippingMethod && shippingMethod !== "standard") {
        return next(
          new ErrorHandler(
            "This coupon only applies to standard shipping",
            400,
          ),
        );
      }
      discount = 0;
    }

    res.status(200).json({
      success: true,
      valid: true,
      coupon: {
        code: coupon.code,
        name: coupon.name,
        type: coupon.type,
        value: coupon.value,
        discount: Math.round(discount * 100) / 100,
        minimumSpend: coupon.minimumSpend,
        maxDiscount: coupon.maxDiscount,
      },
    });
  }),
);
module.exports = router;
