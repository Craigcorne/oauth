const express = require("express");
const router = express.Router();
const Order = require("../models/order");
const User = require("../models/user");
const Invoice = require("../models/invoice");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const crypto = require("crypto");
const NodeCache = require("node-cache");
const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");
const Product = require("../models/Product");
const PromoCode = require("../models/coupon");
const Location = require("../models/Location");
const { verifyLedgerIntegrity, recordLedgerEntry } = require("../utils/hy");
const { recordPointsLedgerEntry } = require("../utils/pointsLedger");

// In-memory cache (5 min TTL)
const orderCache = new NodeCache({ stdTTL: 300, checkperiod: 320 });

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const POINTS_RATE = 0.1;
const DAILY_CREDIT_LIMIT = 50000; // max store credit spend per day
const CREDIT_TX_LIMIT = 3; // max credit transactions per 5 min
const CREDIT_TX_WINDOW_MS = 5 * 60 * 1000;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const getUserId = (user) => {
  if (!user) return null;
  return user._id?.toString?.() || user.toString();
};

const clearOrderCache = (keys) => {
  keys.forEach((key) => orderCache.del(key));
};

const generateReceiptNo = (prefix = "INV") =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const buildUserFilter = (userId, role) => {
  const idStr = userId.toString?.() || String(userId);

  // Admins can see all; regular users see only their own
  if (role === "admin") return {};

  return { "user._id": idStr };
};

// ─── 1. INVENTORY VALIDATION (runs FIRST) ────────────────────────────────────

const validateCartInventory = async (cartItems) => {
  const errors = [];
  const orderItems = [];
  let subtotal = 0;

  const productIds = [...new Set(cartItems.map((i) => i.productId))];
  const products = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  for (const item of cartItems) {
    const pid = item.productId?.toString?.() || item.productId;
    const product = productMap.get(pid);

    if (!product) {
      errors.push({
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        requestedQuantity: item.quantity,
        reason: "Product no longer available",
      });
      continue;
    }

    // ── FIX: Navigate nested variant.sizes[] ──
    let matchedVariant = null;
    let matchedSize = null;

    for (const variant of product.variants || []) {
      const vColorId =
        variant.color?._id?.toString?.() || variant.color?.toString?.();
      const iColor = item.color?._id?.toString?.() || item.color?.toString?.(); // ← FIXED

      if (vColorId !== iColor) continue;

      const sizeEntry = variant.sizes?.find(
        (s) => s.sku === item.sku && s.size === item.size,
      );

      if (sizeEntry) {
        matchedVariant = variant;
        matchedSize = sizeEntry;
        break;
      }
    }

    if (!matchedSize) {
      errors.push({
        productId: item.productId,
        sku: item.sku,
        name: product.name,
        requestedQuantity: item.quantity,
        reason: "Selected variant (color/size) no longer available",
      });
      continue;
    }

    if (matchedSize.stock < item.quantity) {
      errors.push({
        productId: item.productId,
        sku: item.sku,
        name: product.name,
        requestedQuantity: item.quantity,
        availableStock: matchedSize.stock,
        reason: `Only ${matchedSize.stock} left in stock`,
      });
      continue;
    }

    // ── USE SERVER-SIDE PRICE ──
    // Check size-level price first, then variant-level, then product basePrice
    const unitPrice =
      matchedSize.price ?? matchedVariant.price ?? product.basePrice ?? 0;
    const lineTotal = unitPrice * item.quantity;
    subtotal += lineTotal;

    orderItems.push({
      productId: product._id,
      sku: matchedSize.sku,
      name: product.name,
      color: matchedVariant.color,
      size: matchedSize.size,
      quantity: item.quantity,
      basePrice: unitPrice,
      image: item.image || matchedVariant.images?.[0] || product.images?.[0],
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    orderItems,
    subtotal,
  };
};

// ─── 2. SERVER-SIDE PROMO VALIDATION ─────────────────────────────────────────
const validatePromoCode = async (
  code,
  subtotal,
  shippingCost = 0,
  shippingMethod = "",
  userId = null,
) => {
  if (!code || typeof code !== "string") return { discount: 0, promoDoc: null };

  const now = new Date();

  const promo = await PromoCode.findOne({
    code: code.trim().toUpperCase(),
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gt: now },
  });

  if (!promo) throw new Error("Invalid or expired promo code");

  // ── Whitelist check ──
  if (promo.customerIds?.length > 0) {
    const isAllowed = promo.customerIds.some((id) => id.toString() === userId);
    if (!isAllowed)
      throw new Error("This promo code is not valid for your account");
  }

  // ── Global usage limit ──
  if (promo.usageLimit > 0 && promo.usedCount >= promo.usageLimit) {
    throw new Error("Promo code usage limit reached");
  }

  // ── Per-customer usage limit ──
  if (userId && promo.usagePerCustomer > 0) {
    const customerUsage = await Order.countDocuments({
      promoCode: promo.code,
      "user._id": userId,
      status: { $nin: ["Cancelled", "Refunded"] },
    });

    if (customerUsage >= promo.usagePerCustomer) {
      throw new Error(
        `You can only use this code ${promo.usagePerCustomer} time(s)`,
      );
    }
  }

  if (subtotal < (promo.minimumSpend || 0)) {
    throw new Error(
      `Minimum order amount for this code is KES ${promo.minimumSpend}`,
    );
  }

  let discount = 0;

  if (promo.type === "percentage") {
    discount = Math.round((subtotal * promo.value) / 100);
    if (promo.maxDiscount && discount > promo.maxDiscount) {
      discount = promo.maxDiscount;
    }
  } else if (promo.type === "fixed") {
    discount = Math.min(promo.value, subtotal);
  } else if (promo.type === "free_shipping") {
    if (shippingMethod === "standard") {
      discount = shippingCost || 0;
    } else {
      throw new Error("This promo code only applies to standard shipping");
    }
  }

  discount = Math.min(discount, subtotal + shippingCost);

  return { discount, promoDoc: promo };
};

// ─── 3. SERVER-SIDE SHIPPING CALCULATION ─────────────────────────────────────

const calculateShipping = async (
  countryName,
  countyName,
  cityName,
  shippingType,
) => {
  const location = await Location.findOne({
    name: new RegExp(`^${countryName}$`, "i"),
  }).lean();

  if (!location) return 0;

  const county = location.counties.find(
    (c) => c.name.toLowerCase() === countyName.toLowerCase(),
  );

  if (!county) return 0;

  const isNairobi = county.name.toLowerCase() === "nairobi";

  // ── Nairobi: check town-level delivery ──
  if (isNairobi && cityName) {
    const town = county.towns.find(
      (t) => t.name.toLowerCase() === cityName.toLowerCase(),
    );

    if (town?.delivery?.[shippingType]?.available) {
      return town.delivery[shippingType].price;
    }
    return 0;
  }

  // ── Other counties: county-level standard only ──
  if (county.delivery?.[shippingType]?.available) {
    return county.delivery[shippingType].price;
  }

  return 0;
};

// ─── 4. STORE-CREDIT SECURITY CHECK ──────────────────────────────────────────
const runStoreCreditSecurityCheck = async (user, orderAmount) => {
  const errors = [];

  if (!user || !user._id) {
    errors.push("Invalid user account");
    return { passed: false, errors };
  }

  if (user.isActive === false) {
    errors.push("Account is inactive. Cannot use store credit.");
  }

  if (!orderAmount || orderAmount <= 0) {
    errors.push("Invalid order amount");
  }

  // ── CRITICAL: Verify ledger integrity ──
  const ledgerCheck = await verifyLedgerIntegrity(user);
  if (!ledgerCheck.valid) {
    user.isActive = false;
    await user.save();
    errors.push(`Security violation: ${ledgerCheck.reason}. Account frozen.`);
    return { passed: false, errors };
  }

  if ((user.availableBalance || 0) < orderAmount) {
    errors.push(
      `Insufficient store credit. Available: ${user.availableBalance || 0}, Required: ${orderAmount}`,
    );
  }

  // Rate limiting (keep existing logic)
  const fiveMinutesAgo = new Date(Date.now() - CREDIT_TX_WINDOW_MS);
  const recentInvoices = await Invoice.find({
    userId: user._id.toString?.() || user._id,
    type: { $in: ["conversion", "store_credit_payment"] },
    "paid.paidAt": { $gte: fiveMinutesAgo },
  });
  if (recentInvoices.length >= CREDIT_TX_LIMIT) {
    errors.push("Too many credit transactions. Please wait a few minutes.");
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dailyInvoices = await Invoice.find({
    userId: user._id.toString?.() || user._id,
    type: { $in: ["conversion", "store_credit_payment"] },
    "paid.paidAt": { $gte: startOfDay },
  });
  const dailyTotal = dailyInvoices.reduce(
    (sum, inv) => sum + (inv.amount || 0),
    0,
  );
  if (dailyTotal + orderAmount > DAILY_CREDIT_LIMIT) {
    errors.push("Daily store credit limit exceeded.");
  }

  return { passed: errors.length === 0, errors };
};

// ─── 5. STOCK DEDUCTION (atomic inside transaction) ──────────────────────────
const deductStock = async (orderItems) => {
  for (const item of orderItems) {
    const result = await Product.updateOne(
      {
        _id: item.productId,
        "variants.sizes.sku": item.sku,
      },
      {
        $inc: { "variants.$[variant].sizes.$[size].stock": -item.quantity },
      },
      {
        arrayFilters: [
          { "variant.sizes.sku": item.sku },
          { "size.sku": item.sku, "size.stock": { $gte: item.quantity } },
        ],
      },
    );

    if (result.modifiedCount === 0) {
      throw new Error(
        `Stock deduction failed for ${item.sku}. It may have just gone out of stock.`,
      );
    }
  }
};

// check stock
router.post("/check-stock", async (req, res) => {
  try {
    const { cartItems } = req.body;

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: "cartItems array is required",
      });
    }

    const result = await validateCartInventory(cartItems);

    if (!result.ok) {
      // ── FIX: return 200, not 400 ──
      return res.status(200).json({
        success: false,
        errors: result.errors,
      });
    }

    return res.status(200).json({
      success: true,
      orderItems: result.orderItems,
      subtotal: result.subtotal,
    });
  } catch (err) {
    console.error("check-stock error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── CREATE ORDER ───────────────────────────────────────────────────────────
router.post(
  "/create-order",
  isAuthenticated,
  catchAsyncErrors(async (req, res) => {
    const {
      name,
      phone,
      country,
      county,
      city,
      shipping,
      payment,
      referralName,
      promoCode: rawPromoCode,
      cartItems,
    } = req.body;

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }

    const userIdStr = getUserId(req.user);
    const user = await User.findById(userIdStr);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: INVENTORY CHECK
    // ═══════════════════════════════════════════════════════════════════════
    const inventory = await validateCartInventory(cartItems);
    if (!inventory.ok) {
      return res.status(400).json({
        success: false,
        message: "Some items in your cart are unavailable or out of stock",
        errors: inventory.errors,
      });
    }
    const { orderItems, subtotal } = inventory;

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: SERVER-SIDE CALCULATIONS
    // ═══════════════════════════════════════════════════════════════════════
    const shippingPrice = await calculateShipping(
      country,
      county,
      city,
      shipping,
    );

    let discount = 0;
    let promoDoc = null;

    if (rawPromoCode) {
      try {
        const promoResult = await validatePromoCode(
          rawPromoCode,
          subtotal,
          shippingPrice,
          shipping,
          userIdStr,
        );
        discount = promoResult.discount;
        promoDoc = promoResult.promoDoc;
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
    }

    const total = Math.max(0, subtotal + shippingPrice - discount);

    // ── Store credit validation (read-only) ──
    const isLoyaltyPayment =
      payment === "loyalty_points" || payment === "store-credit";

    const isMpesaPayment = payment === "mpesa";
    const isCodPayment = payment === "cod";
    const isPickup = shipping?.toLowerCase() === "pickup";
    let balance = 0;
    let paidAt;
    let status;
    let deliveredAt;

    if (isPickup) {
      // In-store pickup orders are immediately completed
      status = "Delivered";
      paidAt = new Date();
      deliveredAt = new Date();

      balance = 0;
    } else if (isLoyaltyPayment) {
      const security = await runStoreCreditSecurityCheck(user, total);
      if (!security.passed) {
        return res.status(400).json({
          success: false,
          message: "Store credit security check failed",
          errors: security.errors,
        });
      }
      status = "Processing";
      paidAt = new Date();
    } else if (isMpesaPayment) {
      status = "Processing";
      paidAt = new Date();
    } else if (isCodPayment) {
      status = "Processing";
      paidAt = new Date();
      balance = subtotal;
    } else {
      status = "Processing";
      paidAt = new Date();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: EXECUTE WITHOUT TRANSACTIONS (M0 compatible)
    // ═══════════════════════════════════════════════════════════════════════
    let order;
    let pointsEarned = 0;
    let balanceDeducted = false;
    let stockDeducted = false;
    let promoIncremented = false;

    try {
      // 3a. Deduct stock first (most likely to fail — do it first)
      await deductStock(orderItems);
      stockDeducted = true;
      try {
        const soldBulkOps = cartItems
          .filter((item) => item.productId && Number(item.quantity) > 0)
          .map((item) => ({
            updateOne: {
              filter: { _id: item.productId },
              update: { $inc: { sold: Number(item.quantity) } },
            },
          }));

        if (soldBulkOps.length > 0) {
          await Product.bulkWrite(soldBulkOps);
        }
      } catch (soldErr) {
        console.error(
          "Sold count increment failed (non-critical):",
          soldErr.message,
        );
      }
      // 3c. Build user payload
      const userPayload = {
        avatar: user.avatar,
        _id: user._id.toString?.() || user._id,
        name: user.name,
        email: user.email,
        points: user.points,
        enrolled: user.enrolled,
        availableBalance: user.availableBalance,
        isActive: user.isActive,
        country: user.country,
        wishlist: user.wishlist,
        role: user.role,
        authProvider: user.authProvider,
        providerId: user.providerId,
        addresses: user.addresses,
        phoneNumber: user.phoneNumber,
        dateOfBirth: user.dateOfBirth,
      };

      // 3d. Create order (the critical write — everything after this is "best effort")
      order = await Order.create({
        orderNo: `ORD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        referee: referralName || "",
        cart: orderItems,
        shippingAddress: {
          name,
          phone,
          country,
          county,
          city,
          shippingType: shipping,
        },
        user: userPayload,
        totalPrice: total,
        shippingPrice,
        phoneNumber: phone,
        discount,
        balance,
        promoCode: promoDoc?.code || rawPromoCode || "",
        paymentMethod: payment,
        status: status,
        paidAt: paidAt,
        deliveredAt: deliveredAt,
      });

      // 3e. Points (skip for loyalty payment)
      if (isLoyaltyPayment) {
        await recordLedgerEntry(user, -total, {
          receiptNo: generateReceiptNo("PMT"),
          purpose: `Store Credit Payment - Order ${order.orderNo}`,
          type: "store_credit_payment",
          orderId: order._id.toString(),
        });
      }
      const isPickupOrder = order.shippingAddress?.shippingType === "pickup";
      if (!isLoyaltyPayment && !isPickupOrder) {
        pointsEarned = Math.floor(subtotal * POINTS_RATE);
        if (pointsEarned > 0) {
          await recordPointsLedgerEntry(user, pointsEarned, {
            receiptNo: generateReceiptNo("PTS"),
            purpose: `Points earned - Order ${order.orderNo}`,
            type: "earned",
            orderId: order._id.toString(),
          });
        }
      }

      // 3f. Increment promo usage (best effort — if it fails, order still stands)
      if (promoDoc) {
        try {
          const incResult = await PromoCode.updateOne(
            { _id: promoDoc._id, "usedBy.user": user._id },
            {
              $inc: { usedCount: 1, "usedBy.$.count": 1 },
              $set: { "usedBy.$.lastUsedAt": new Date() },
            },
          );

          if (incResult.matchedCount === 0) {
            await PromoCode.updateOne(
              { _id: promoDoc._id },
              {
                $inc: { usedCount: 1 },
                $push: {
                  usedBy: { user: user._id, count: 1, lastUsedAt: new Date() },
                },
              },
            );
          }
          promoIncremented = true;
        } catch (promoErr) {
          console.error(
            "Promo increment failed (non-critical):",
            promoErr.message,
          );
        }
      }

      // 3g. Invoices (best effort — log failures but don't fail the order)
      const invoicePromises = [];

      if (subtotal > 0) {
        invoicePromises.push(
          Invoice.create({
            receiptNo: generateReceiptNo("INC"),
            amount: subtotal,
            purpose: "Order Subtotal Income",
            paid: { status: true, paidAt: new Date() },
            userId: user._id.toString?.() || user._id,
            balance: user.availableBalance,
            type: "income",
            orderId: order._id.toString(),
          }),
        );
      }

      if (discount > 0) {
        invoicePromises.push(
          Invoice.create({
            receiptNo: generateReceiptNo("EXP"),
            amount: discount,
            purpose:
              promoDoc?.type === "free_shipping"
                ? "Free Shipping Discount"
                : "Order Discount Expense",
            paid: { status: true, paidAt: new Date() },
            userId: user._id.toString?.() || user._id,
            balance: user.availableBalance,
            type: "expense",
            orderId: order._id.toString(),
          }),
        );
      }

      if (shippingPrice > 0) {
        invoicePromises.push(
          Invoice.create({
            receiptNo: generateReceiptNo("INC"),
            amount: shippingPrice,
            purpose: "Delivery Price Income",
            paid: { status: true, paidAt: new Date() },
            userId: user._id.toString?.() || user._id,
            balance: user.availableBalance,
            type: "income",
            orderId: order._id.toString(),
          }),
        );
      }

      // Fire and forget invoices — log errors but don't fail the order
      Promise.all(invoicePromises).catch((invErr) => {
        console.error(
          "Invoice creation failed (non-critical):",
          invErr.message,
        );
      });
    } catch (err) {
      // ═════════════════════════════════════════════════════════════════════
      // COMPENSATION: Undo balance deduction if order wasn't created
      // ═════════════════════════════════════════════════════════════════════
      if (balanceDeducted && !order) {
        console.error(
          "Order creation failed after balance deduction — REFUNDING",
        );
        user.availableBalance += total;
        await user.save();
      }

      // Restore stock if it was deducted but order failed
      if (stockDeducted && !order) {
        console.error("Restoring stock after failed order");
        // await restoreStock(orderItems); // implement if you have this function
      }

      console.error("ORDER CREATION ERROR:", err.message);
      console.error(err.stack);

      if (err.message?.includes("Stock deduction failed")) {
        return res.status(409).json({
          success: false,
          message:
            "An item in your cart just went out of stock. Please review your cart.",
        });
      }

      return res.status(500).json({
        success: false,
        message: "Failed to place order. Please try again.",
      });
    }

    // ── CLEAR CACHE ──
    clearOrderCache([`my_orders_${userIdStr}`, "all_orders"]);

    res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order,
      pointsEarned,
      remainingBalance: user.availableBalance,
      balance,
      calculated: {
        subtotal,
        shippingPrice,
        discount,
        total,
      },
    });
  }),
);

// loyalty points instore
router.post(
  "/loyalty/award-instore-points",
  isAuthenticated,
  catchAsyncErrors(async (req, res) => {
    // Restrict to staff — this grants points to arbitrary phone numbers,
    // so it shouldn't be callable by a regular customer.
    if (!["admin", "manager"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to perform this action",
      });
    }

    const { phone, orderNumber } = req.body;

    if (!phone || !orderNumber) {
      return res.status(400).json({
        success: false,
        message: "Phone number and order number are required",
      });
    }

    const cleanPhone = String(phone).replace(/\D/g, "").slice(0, 15);
    const phoneRegex = /^0(7|1)\d{8}$/;
    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 10-digit Kenyan phone number",
      });
    }

    const order = await Order.findOne({ orderNo: orderNumber });
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (order.shippingAddress?.city !== "In-store") {
      return res.status(400).json({
        success: false,
        message: "Points can only be manually awarded for in-store orders",
      });
    }

    // Prevent awarding points twice for the same order
    if (order.pointsAwardedTo) {
      return res.status(400).json({
        success: false,
        message: "Points have already been added for this order",
      });
    }

    const customer = await User.findOne({ phoneNumber: cleanPhone });
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "No account found with that phone number",
      });
    }

    if (!customer.enrolled) {
      return res.status(400).json({
        success: false,
        message: "This customer is not enrolled in the loyalty program",
      });
    }

    // totalPrice already excludes shipping for in-store orders (shippingPrice = 0),
    // matching the same POINTS_RATE logic used in create-order
    const pointsEarned = Math.floor(order.totalPrice * POINTS_RATE);
    if (pointsEarned > 0) {
      await recordPointsLedgerEntry(customer, pointsEarned, {
        receiptNo: generateReceiptNo("PTS"),
        purpose: `In-store points award - Order ${order.orderNo}`,
        type: "instore_award",
        orderId: order._id.toString(),
      });
    }

    order.pointsAwardedTo = customer._id;
    await order.save();

    res.status(200).json({
      success: true,
      message: `${pointsEarned} points added to ${customer.name}'s account`,
      pointsEarned,
    });
  }),
);

// ─── GET ALL ORDERS (ADMIN) ───────────────────────────────────
router.get(
  "/get-all-orders",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const orders = await Order.find().sort({ createdAt: -1 }).lean();

    res.status(200).json({ success: true, orders });
  }),
);

// ─── GET LOGGED-IN USER'S ORDERS ──────────────────────────────
router.get(
  "/my-orders",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const userId = getUserId(req.user);

    const cacheKey = `my_orders_${userId}`;
    let orders = orderCache.get(cacheKey);

    if (!orders) {
      orders = await Order.find(buildUserFilter(userId))
        .sort({ createdAt: -1 })
        .lean();

      orderCache.set(cacheKey, orders);
    }

    res.status(200).json({ success: true, orders });
  }),
);

// ─── GET SINGLE ORDER BY ID ───────────────────────────────────
router.get(
  "/get-order/:id",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const cacheKey = `order_${req.params.id}`;
    let order = orderCache.get(cacheKey);

    if (!order) {
      order = await Order.findById(req.params.id).lean();
      if (order) orderCache.set(cacheKey, order);
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found with this ID",
      });
    }

    res.status(200).json({ success: true, order });
  }),
);

// ─── UPDATE ORDER STATUS ──────────────────────────────────────
// router.put(
//   "/update-order-status/:id",
//   isAuthenticated,
//   isAdmin,
//   catchAsyncErrors(async (req, res, next) => {
//     const updateData = { status: req.body.status };
//     if (req.body.status === "Delivered") {
//       updateData.deliveredAt = Date.now();
//     }

//     const order = await Order.findByIdAndUpdate(req.params.id, updateData, {
//       new: true,
//       runValidators: false,
//     }).lean();

//     if (!order) {
//       return res.status(404).json({
//         success: false,
//         message: "Order not found with this ID",
//       });
//     }

//     clearOrderCache([
//       "all_orders",
//       `order_${req.params.id}`,
//       `my_orders_${getUserId(order.user)}`,
//     ]);

//     res.status(200).json({
//       success: true,
//       message: "Order status updated successfully",
//       order,
//     });
//   }),
// );

// ─── UPDATE ORDER (GENERAL) ───────────────────────────────────
router.put(
  "/update-order-status/:id",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      if (!req.body.status) {
        return res
          .status(400)
          .json({ success: false, message: "Status required" });
      }

      const updateData = { status: req.body.status };

      if (req.body.status === "Delivered") {
        updateData.deliveredAt = Date.now();
        updateData.paidAt = Date.now();
      }

      const order = await Order.findByIdAndUpdate(req.params.id, updateData, {
        returnDocument: "after", // ← changed from new: true
        runValidators: false,
      }).lean();

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      try {
        const userIdStr =
          order.user?._id?.toString?.() ||
          order.user?.toString?.() ||
          "unknown";
        clearOrderCache([
          "all_orders",
          `order_${req.params.id}`,
          `my_orders_${userIdStr}`,
        ]);
      } catch (cacheErr) {
        console.error("Cache clear failed (non-fatal):", cacheErr.message);
      }

      res.status(200).json({
        success: true,
        message: "Order status updated successfully",
        order,
      });
    } catch (err) {
      console.error(">>> PUT ERROR:", err.message);
      console.error(err.stack);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ─── GET SINGLE ORDER BY ORDER NO ─────────────────────────────
router.get(
  "/get-order-by-no/:orderNo",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { orderNo } = req.params;
    const cacheKey = `order_no_${orderNo}`;
    let order = orderCache.get(cacheKey);

    if (!order) {
      order = await Order.findOne({ orderNo }).lean();
      if (order) orderCache.set(cacheKey, order);
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found with this number",
      });
    }

    res.status(200).json({ success: true, order });
  }),
);

// ─── DELETE ORDER ─────────────────────────────────────────────
router.delete(
  "/delete-order/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const order = await Order.findById(req.params.id).lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found with this ID",
      });
    }

    await Order.findByIdAndDelete(req.params.id);

    clearOrderCache([
      "all_orders",
      `order_${req.params.id}`,
      `my_orders_${getUserId(order.user)}`,
    ]);

    res.status(200).json({
      success: true,
      message: "Order deleted successfully",
    });
  }),
);

// get receipt
router.get(
  "/receipt/:orderNo",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const order = await Order.findOne({ orderNo: req.params.orderNo }).lean();
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // Security: non-admins can only download their own receipts
    const requesterId = getUserId(req.user);
    const orderUserId = getUserId(order.user);
    if (req.user.role !== "admin" && requesterId !== orderUserId) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    /* ---------- design tokens ---------- */
    const INK = "#0A0A0A";
    const MUTED = "#6B6B6B";
    const LINE = "#E6E6E6";
    const SOFT = "#F6F6F6";
    const M = 48; // page margin
    const W = 595.28 - M * 2; // A4 content width
    const R = M + W; // right edge

    const money = (n = 0) => `KSh ${Number(n || 0).toLocaleString("en-US")}`;
    const rule = (y, color = LINE) =>
      doc
        .save()
        .moveTo(M, y)
        .lineTo(R, y)
        .lineWidth(1)
        .strokeColor(color)
        .stroke()
        .restore();

    const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=receipt-${order.orderNo}.pdf`,
    );
    doc.pipe(res);

    /* ---------- header band ---------- */
    doc.rect(0, 0, 595.28, 132).fill(INK);
    doc
      .fillColor("#FFFFFF")
      .font("Helvetica-Bold")
      .fontSize(24)
      .text("Ninety One", M, 40, {
        characterSpacing: 4,
      });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#B8B8B8")
      .text("OFFICIAL RECEIPT", M, 70, { characterSpacing: 2 });

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#FFFFFF")
      .text(order.orderNo, M, 40, { width: W, align: "right" });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#B8B8B8")
      .text(
        `Issued ${new Date(order.createdAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })}`,
        M,
        58,
        { width: W, align: "right" },
      )
      .text(
        `${String(order.paymentMethod || "").toUpperCase()}${order.paidAt ? " · PAID" : ""}`,
        M,
        72,
        { width: W, align: "right" },
      );

    /* status pill */
    const status = String(order.status || "Pending");
    const pillW =
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .widthOfString(status.toUpperCase()) + 22;
    doc.roundedRect(R - pillW, 92, pillW, 20, 10).fill("#FFFFFF");
    doc.fillColor(INK).text(status.toUpperCase(), R - pillW, 98, {
      width: pillW,
      align: "center",
      characterSpacing: 1,
    });

    /* ---------- parties ---------- */
    const ship = order.shippingAddress || {};
    let y = 168;
    const colW = (W - 24) / 2;

    const block = (x, title, lines) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor(MUTED)
        .text(title, x, y, { characterSpacing: 1.5 });
      let ly = y + 18;
      lines.filter(Boolean).forEach((l, i) => {
        doc
          .font(i === 0 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(i === 0 ? 11 : 10)
          .fillColor(i === 0 ? INK : MUTED)
          .text(l, x, ly, { width: colW });
        ly += i === 0 ? 16 : 14;
      });
      return ly;
    };

    const y1 = block(M, "BILLED TO", [
      order.user?.name || "Guest",
      order.user?.email,
      order.user?.phoneNumber,
    ]);
    const y2 = block(M + colW + 24, "SHIPPED TO", [
      ship.name || order.user?.name || "",
      [ship.city, ship.county].filter(Boolean).join(", "),
      ship.country,
      ship.shippingType ? `${ship.shippingType} delivery` : null,
    ]);

    y = Math.max(y1, y2) + 18;
    rule(y);
    y += 26;

    /* ---------- items table ---------- */
    const cQty = M + 268;
    const cUnit = M + 330;
    const cTot = R - 90;

    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    doc.text("ITEM", M, y, { characterSpacing: 1 });
    doc.text("QTY", cQty, y, {
      width: 40,
      align: "center",
      characterSpacing: 1,
    });
    doc.text("UNIT", cUnit, y, {
      width: 90,
      align: "right",
      characterSpacing: 1,
    });
    doc.text("TOTAL", cTot, y, {
      width: 90,
      align: "right",
      characterSpacing: 1,
    });
    y += 14;
    rule(y);
    y += 8;

    const items = order.cart || [];
    items.forEach((item, i) => {
      const qty = item.quantity || item.qty || 1;
      const price = item.basePrice || item.price || 0;
      const meta = [item.sku, item.size ? `Size ${item.size}` : null]
        .filter(Boolean)
        .join("  ·  ");
      const rowH = meta ? 38 : 26;

      if (i % 2 === 0) doc.rect(M - 8, y - 4, W + 16, rowH).fill(SOFT);

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor(INK)
        .text(item.name || "Item", M, y, {
          width: 250,
          lineBreak: false,
          ellipsis: true,
        });
      if (meta) {
        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor(MUTED)
          .text(meta, M, y + 14, { width: 250 });
      }
      doc.font("Helvetica").fontSize(10).fillColor(INK);
      doc.text(String(qty), cQty, y, { width: 40, align: "center" });
      doc.text(money(price), cUnit, y, { width: 90, align: "right" });
      doc
        .font("Helvetica-Bold")
        .text(money(price * qty), cTot, y, { width: 90, align: "right" });

      y += rowH;

      if (y > 640) {
        doc.addPage();
        y = M;
      }
    });

    /* ---------- totals card ---------- */
    y += 18;
    const subtotal = items.reduce(
      (s, i) => s + (i.basePrice || i.price || 0) * (i.quantity || i.qty || 1),
      0,
    );
    const rows = [
      ["Subtotal", money(subtotal)],
      ["Shipping", money(order.shippingPrice)],
    ];
    if (order.discount) rows.push(["Discount", `- ${money(order.discount)}`]);

    const cardX = R - 240;
    const cardH = rows.length * 20 + 58;
    doc.roundedRect(cardX, y, 240, cardH, 10).fill(SOFT);

    let ry = y + 18;
    rows.forEach(([label, val]) => {
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor(MUTED)
        .text(label, cardX + 18, ry);
      doc
        .font("Helvetica")
        .fillColor(INK)
        .text(val, cardX + 18, ry, { width: 204, align: "right" });
      ry += 20;
    });

    doc
      .save()
      .moveTo(cardX + 18, ry + 2)
      .lineTo(cardX + 222, ry + 2)
      .strokeColor("#D9D9D9")
      .stroke()
      .restore();
    ry += 14;
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(INK)
      .text("Total", cardX + 18, ry);
    doc.text(money(order.totalPrice), cardX + 18, ry, {
      width: 204,
      align: "right",
    });

    y += cardH + 28;

    /* ---------- notes ---------- */
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(MUTED)
      .text("PAYMENT", M, y, { characterSpacing: 1.5 });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `${String(order.paymentMethod || "—").toUpperCase()}${
          order.paidAt
            ? ` · received ${new Date(order.paidAt).toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}`
            : " · pending"
        }${order.promoCode ? ` · promo ${order.promoCode}` : ""}`,
        M,
        y + 16,
        { width: W - 260 },
      );

    /* ---------- footer on every page ---------- */
    // Add footers
    const range = doc.bufferedPageRange();

    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);

      const bottomMargin = doc.page.margins.bottom;

      doc.page.margins.bottom = 0;

      doc.save().rect(0, 782, 595.28, 60).fill(INK).restore();

      doc

        .font("Helvetica-Bold")

        .fontSize(9)

        .fillColor("#FFFFFF")

        .text("Thank you for shopping with Ninety One", M, 802, {
          width: W / 2,

          characterSpacing: 1,

          lineBreak: false,
        });

      doc

        .font("Helvetica")

        .fontSize(8)

        .fillColor("#9A9A9A")

        .text(
          `${order.orderNo}  ·  Page ${p - range.start + 1} of ${range.count}`,

          M + W / 2,

          802,

          { width: W / 2, align: "right", lineBreak: false },
        );

      doc.page.margins.bottom = bottomMargin; // restore
    }
    doc.end();
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// GET /order/admin/returnable-orders
// ═══════════════════════════════════════════════════════════════════════════════

router.get(
  "/returnable-orders",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const orders = await Order.find({
      // 🚫 Never include in-store / pickup purchases
      "shippingAddress.shippingType": { $ne: "pickup" },

      $or: [
        {
          deliveredAt: { $gte: oneWeekAgo, $ne: null },
          status: { $nin: ["Pending Payment", "Cancelled"] },
        },
        {
          returns: { $exists: true, $ne: [] },
        },
      ],
    })
      .sort({ deliveredAt: -1 })
      .select(
        "orderNo user totalPrice deliveredAt status cart returns shippingAddress",
      );

    res.status(200).json({
      success: true,
      count: orders.length,
      orders,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// POST /order/admin/return-product
// Body: { orderId, returns: [{ sku, quantity, reason }] }
// ═══════════════════════════════════════════════════════════════════════════════

router.post(
  "/return-product",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const { orderId, returns } = req.body;

    // Validation
    if (!orderId || !Array.isArray(returns) || returns.length === 0) {
      return res.status(400).json({
        success: false,
        message: "orderId and a non-empty returns array are required",
      });
    }

    // Find order
    const order = await Order.findById(orderId);
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // Check if delivered
    if (!order.deliveredAt) {
      return res.status(400).json({
        success: false,
        message: "Order has not been delivered yet",
      });
    }

    // Check return window (7 days)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    if (order.deliveredAt < oneWeekAgo) {
      return res.status(400).json({
        success: false,
        message:
          "Return window expired. Returns must be within 7 days of delivery.",
      });
    }

    // Check if already returned
    if (order.status === "Returned") {
      return res.status(400).json({
        success: false,
        message: "Order has already been fully returned",
      });
    }

    // Get user
    const userIdStr = order.user?._id?.toString?.() || order.user?.toString?.();
    let user = await User.findById(userIdStr);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Order user not found" });
    }

    // ── DEFENSIVE: snapshot points so NOTHING can add them during return ──
    let userBeforePoints = user.points || 0;

    // Determine payment type
    const isCOD = order.paymentMethod === "cod";
    const isLoyaltyPayment =
      order.paymentMethod === "loyalty_points" ||
      order.paymentMethod === "store-credit";

    // ── FIX: merge duplicate SKUs in the request body before validating ──
    const mergedReturnsMap = new Map();
    for (const ret of returns || []) {
      if (!ret || !ret.sku) continue;
      const qty = Number(ret.quantity) || 0;
      const existing = mergedReturnsMap.get(ret.sku);
      if (existing) {
        existing.quantity += qty;
      } else {
        mergedReturnsMap.set(ret.sku, {
          sku: ret.sku,
          quantity: qty,
          reason: ret.reason,
        });
      }
    }
    const mergedReturns = Array.from(mergedReturnsMap.values());

    const returnRecords = [];
    const stockRestores = [];
    let totalRefundAmount = 0;
    let totalPointsEarned = 0;
    let totalCashDeduction = 0;
    let totalPointsToReverse = 0;
    let totalCODBonusPoints = 0;

    const errors = [];

    // Process each return item
    for (const ret of mergedReturns) {
      const { sku, quantity, reason } = ret;

      if (!sku || !quantity || quantity < 1) {
        errors.push({ sku, message: "Invalid sku or quantity" });
        continue;
      }

      const orderItem = order.cart.find((item) => item.sku === sku);
      if (!orderItem) {
        errors.push({ sku, message: "Product SKU not found in this order" });
        continue;
      }

      const alreadyReturned = orderItem.returnedQuantity || 0;
      const returnable = (orderItem.quantity || 1) - alreadyReturned;

      if (quantity > returnable) {
        errors.push({
          sku,
          message: `Only ${returnable} unit(s) can be returned. Already returned: ${alreadyReturned}`,
        });
        continue;
      }

      // Calculate unit price
      const unitPrice =
        orderItem.basePrice ??
        orderItem.price ??
        (orderItem.quantity ? orderItem.totalPrice / orderItem.quantity : 0) ??
        0;
      const itemTotal = unitPrice * quantity;

      // ── POINTS CALCULATION FIX ──
      let itemRefund = itemTotal;
      let pointsEarned = 0;
      let cashDeductionForItem = 0;
      let pointsReversed = 0;

      if (isCOD) {
        // COD: No cash refund, claw back points earned at purchase
        itemRefund = 0;
        if (user.enrolled) {
          // Calculate points earned at purchase time (1% of item value)
          pointsReversed = Math.floor(itemTotal * POINTS_RATE);
          totalPointsToReverse += pointsReversed;
        }
      } else if (isLoyaltyPayment) {
        // Loyalty/store-credit payment: No points earned, no clawback
        // Full amount goes back as store credit
        pointsEarned = 0;
        cashDeductionForItem = 0;
      } else {
        if (user.enrolled) {
          pointsEarned = Math.floor(itemTotal * POINTS_RATE);
          // FIX: convert points to their cash equivalent (1 point = 0.1 cash)
          cashDeductionForItem = Math.round(pointsEarned * 0.1 * 100) / 100;
        } else {
          pointsEarned = 0;
          cashDeductionForItem = 0;
        }
      }

      returnRecords.push({
        sku,
        productId:
          orderItem.productId?.toString?.() ||
          orderItem.product?.toString?.() ||
          orderItem._id?.toString?.(),
        name: orderItem.name || "Unknown Product",
        quantity,
        reason: reason || "No reason provided",
        refundAmount: Math.round(itemRefund * 100) / 100,
        pointsEarned,
        pointsReversed,
        cashDeduction: cashDeductionForItem,
        returnedAt: new Date(),
      });

      stockRestores.push({
        productId: orderItem.productId || orderItem.product || orderItem._id,
        sku,
        quantity,
      });

      totalRefundAmount =
        Math.round((totalRefundAmount + itemRefund) * 100) / 100;
      totalPointsEarned += pointsEarned;
      totalCashDeduction =
        Math.round((totalCashDeduction + cashDeductionForItem) * 100) / 100;
    }

    // Check for errors
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some return items could not be processed",
        errors,
      });
    }

    if (returnRecords.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid items to return",
      });
    }

    const claimedReturns = [];
    let stockRestored = false;
    let balanceCredited = false;
    let cashDeducted = 0;
    let pointsReversedActual = 0;
    let codPointsReversed = false; // NEW: tracks whether the COD points ledger deduction actually happened

    try {
      // ── ATOMIC CLAIM: Update order with pipeline ──
      for (const ret of returnRecords) {
        const claimResult = await Order.updateOne(
          { _id: order._id, "cart.sku": ret.sku },
          [
            {
              $set: {
                cart: {
                  $map: {
                    input: "$cart",
                    as: "item",
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ["$$item.sku", ret.sku] },
                            {
                              $lte: [
                                {
                                  $add: [
                                    { $ifNull: ["$$item.returnedQuantity", 0] },
                                    ret.quantity,
                                  ],
                                },
                                "$$item.quantity",
                              ],
                            },
                          ],
                        },
                        {
                          $mergeObjects: [
                            "$$item",
                            {
                              returnedQuantity: {
                                $add: [
                                  { $ifNull: ["$$item.returnedQuantity", 0] },
                                  ret.quantity,
                                ],
                              },
                            },
                          ],
                        },
                        "$$item",
                      ],
                    },
                  },
                },
              },
            },
          ],
          { updatePipeline: true },
        );

        if (claimResult.modifiedCount === 0) {
          throw Object.assign(
            new Error(
              `${ret.sku} can't be returned — it's already reached its returnable quantity. Refresh the order and try again.`,
            ),
            { isClaimConflict: true },
          );
        }
        claimedReturns.push(ret);
      }

      // ── RESTORE STOCK ──
      for (const restore of stockRestores) {
        const result = await Product.updateOne(
          { _id: restore.productId, "variants.sizes.sku": restore.sku },
          {
            $inc: {
              "variants.$[v].sizes.$[s].stock": restore.quantity,
            },
          },
          {
            arrayFilters: [
              { "v.sizes.sku": restore.sku },
              { "s.sku": restore.sku },
            ],
          },
        );
        if (result.matchedCount === 0) {
          console.warn(
            `Stock restore warning: SKU ${restore.sku} not found in product ${restore.productId}`,
          );
        }
      }
      stockRestored = true;

      // ── CASH DEDUCTION (points clawback) for non-COD, non-loyalty ──
      if (
        totalCashDeduction > 0 &&
        user.enrolled &&
        !isLoyaltyPayment &&
        !isCOD
      ) {
        const finalDeduction = Math.min(
          totalCashDeduction,
          totalRefundAmount,
          user.availableBalance || 0,
        );
        const roundedDeduction = Math.round(finalDeduction * 100) / 100;

        if (roundedDeduction > 0) {
          await recordLedgerEntry(user, -roundedDeduction, {
            receiptNo: generateReceiptNo("EXP"),
            purpose: `Points Reversal Cash Deduction - Order ${order.orderNo}`,
            type: "adjustment_debit",
            orderId: order._id.toString(),
            metadata: {
              pointsEarned: totalPointsEarned,
              cashEquivalent: totalCashDeduction,
              actualCashDeduction: roundedDeduction,
            },
          });
          cashDeducted = roundedDeduction;
        }
      }

      // Refresh user
      user = await User.findById(user._id);

      // ── STORE CREDIT REFUND ──
      const netRefundAmount =
        Math.round((totalRefundAmount - cashDeducted) * 100) / 100;

      // FIX: Credit the GROSS refund amount so the separate -20 deduction
      // results in a net +1980, not +1960.
      if (totalRefundAmount > 0 && !isCOD) {
        await recordLedgerEntry(user, totalRefundAmount, {
          receiptNo: generateReceiptNo("RFD"),
          purpose: `Admin Return Refund - Order ${order.orderNo}`,
          type: "refund",
          orderId: order._id.toString(),
          metadata: {
            returnedItems: returnRecords.map((r) => ({
              sku: r.sku,
              quantity: r.quantity,
              refund: r.refundAmount,
              pointsEarned: r.pointsEarned,
              cashDeduction: r.cashDeduction,
            })),
            grossRefund: totalRefundAmount,
            cashDeductedForPoints: cashDeducted,
            netRefund: netRefundAmount,
            pointsEarnedTotal: totalPointsEarned,
          },
        });
        balanceCredited = true;
      }

      // ── COD POINTS REVERSAL (via ledger, so it stays in sync with PointsLedger) ──
      // FIXED: was previously a direct `user.points = ...; user.save()` mutation
      // that never touched PointsLedger, causing a permanent drift that would
      // freeze the account on the user's next points-related action.
      if (isCOD && user.enrolled && totalPointsToReverse > 0) {
        const { newBalance } = await recordPointsLedgerEntry(
          user,
          -totalPointsToReverse,
          {
            receiptNo: generateReceiptNo("PTS"),
            purpose: `Points reversed - Return for Order ${order.orderNo}`,
            type: "returned",
            orderId: order._id.toString(),
          },
        );
        userBeforePoints = newBalance;
        pointsReversedActual = totalPointsToReverse;
        codPointsReversed = true;
      }

      // ── UPDATE ORDER WITH RETURN BATCH ──
      const updatedOrder = await Order.findById(order._id);
      const returnBatch = {
        returnId: `RET-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        returnedAt: new Date(),
        items: returnRecords,
        totalRefund: totalRefundAmount,
        totalPointsEarned: totalPointsEarned,
        totalCashDeducted: cashDeducted,
        netRefundAmount: netRefundAmount,
        status: "Approved",
        initiatedBy: getUserId(req.user),
      };

      if (!updatedOrder.returns) updatedOrder.returns = [];
      updatedOrder.returns.push(returnBatch);

      // Check if all items returned
      const allReturned = updatedOrder.cart.every(
        (item) => (item.returnedQuantity || 0) >= (item.quantity || 1),
      );
      if (allReturned) {
        updatedOrder.status = "Returned";
      }
      await updatedOrder.save();

      // ── POINTS GUARD (ledger-aware) ──
      user = await User.findById(user._id);
      if ((user.points || 0) !== userBeforePoints) {
        const drift = userBeforePoints - (user.points || 0);
        console.error(
          `[RETURN POINTS GUARD] Concurrent points drift detected for user ${user._id}: ${user.points} -> ${userBeforePoints} (drift: ${drift})`,
        );
        try {
          await recordPointsLedgerEntry(user, drift, {
            receiptNo: generateReceiptNo("ADJ"),
            purpose: `Points guard correction - concurrent mutation during return for Order ${order.orderNo}`,
            type: drift > 0 ? "adjustment_credit" : "adjustment_debit",
            orderId: order._id.toString(),
          });
        } catch (guardErr) {
          console.error(
            "[RETURN POINTS GUARD] Correction failed — flag for manual review:",
            guardErr.message,
          );
        }
      }

      // ── CLEAR CACHE ──
      clearOrderCache([
        `my_orders_${userIdStr}`,
        "all_orders",
        `order_${orderId}`,
      ]);

      // ── RESPONSE ──
      res.status(200).json({
        success: true,
        message: "Return processed successfully",
        returnId: returnBatch.returnId,
        order: {
          _id: order._id,
          orderNo: order.orderNo,
          status: updatedOrder.status,
        },
        refund: {
          grossAmount: totalRefundAmount,
          pointsEarned: totalPointsEarned,
          cashDeductedForPoints: cashDeducted,
          netAmount: netRefundAmount,
          creditedTo: isCOD ? "n/a (COD – no prepaid balance)" : "store_credit",
          newBalance: user.availableBalance,
          ...(isCOD && {
            pointsReversed: totalPointsToReverse,
            codBonusPoints: totalCODBonusPoints,
          }),
        },
        returnedItems: returnRecords,
      });
    } catch (err) {
      console.error("RETURN PROCESSING ERROR:", err.message);
      console.error(err.stack);

      // ── ROLLBACK: Claimed returns ──
      if (claimedReturns.length > 0) {
        console.error("Rolling back claimed return quantities after failure");
        for (const done of claimedReturns) {
          await Order.updateOne(
            { _id: order._id },
            { $inc: { "cart.$[c].returnedQuantity": -done.quantity } },
            { arrayFilters: [{ "c.sku": done.sku }] },
          ).catch((e) => console.error("Claim rollback failed:", e.message));
        }
      }

      // ── ROLLBACK: Stock ──
      if (stockRestored) {
        console.error("Rolling back stock restoration after return failure");
        for (const restore of stockRestores) {
          await Product.updateOne(
            { _id: restore.productId, "variants.sizes.sku": restore.sku },
            {
              $inc: {
                "variants.$[v].sizes.$[s].stock": -restore.quantity,
              },
            },
            {
              arrayFilters: [
                { "v.sizes.sku": restore.sku },
                { "s.sku": restore.sku },
              ],
            },
          ).catch((e) => console.error("Stock rollback failed:", e.message));
        }
      }

      // ── ROLLBACK: Store credit ──
      if (balanceCredited) {
        console.error("Rolling back store credit refund after return failure");
        try {
          const userReloaded = await User.findById(user._id);
          // FIX: Reverse the GROSS amount that was credited
          const reversalAmount = Math.round(totalRefundAmount * 100) / 100;
          if (reversalAmount > 0) {
            await recordLedgerEntry(userReloaded, -reversalAmount, {
              receiptNo: generateReceiptNo("REV"),
              purpose: `Reversal of failed return refund - Order ${order.orderNo}`,
              type: "adjustment_debit",
              orderId: order._id.toString(),
            });
          }
        } catch (ledgerErr) {
          console.error("Ledger reversal failed:", ledgerErr.message);
        }
      }

      // ── ROLLBACK: Cash deduction ──
      if (cashDeducted > 0) {
        console.error("Rolling back cash deduction after return failure");
        try {
          const userReloaded = await User.findById(user._id);
          await recordLedgerEntry(userReloaded, cashDeducted, {
            receiptNo: generateReceiptNo("REV"),
            purpose: `Reversal of failed points-cash deduction - Order ${order.orderNo}`,
            type: "adjustment_credit",
            orderId: order._id.toString(),
          });
        } catch (ledgerErr) {
          console.error("Cash deduction rollback failed:", ledgerErr.message);
        }
      }

      // ── ROLLBACK: COD points ──
      // FIXED: this used to re-run the *deduction* (recordPointsLedgerEntry with
      // a negative amount), so if the try block deducted points successfully and
      // THEN failed later on, the catch block deducted the same points a second
      // time. Now it only fires if the deduction actually happened (codPointsReversed)
      // and it credits the points back, i.e. a true rollback, not a repeat.
      if (codPointsReversed) {
        console.error("Rolling back COD points reversal after return failure");
        try {
          const userReloaded = await User.findById(user._id);
          await recordPointsLedgerEntry(userReloaded, pointsReversedActual, {
            receiptNo: generateReceiptNo("REV"),
            purpose: `Reversal of failed points return-reversal - Order ${order.orderNo}`,
            type: "adjustment_credit",
            orderId: order._id.toString(),
          });
        } catch (rollbackErr) {
          console.error("COD points rollback failed:", rollbackErr.message);
        }
      }

      // ── ERROR RESPONSE ──
      if (err.isClaimConflict) {
        return res.status(409).json({
          success: false,
          message: err.message,
        });
      }

      // FIX: was matching "Ledger mismatch" (capital L), but the thrown message
      // is "Points ledger mismatch" (lowercase l) — so this branch never fired
      // and genuine integrity freezes fell through to the generic 500 below.
      if (err.message && /ledger mismatch/i.test(err.message)) {
        return res.status(422).json({
          success: false,
          message: "Ledger balance mismatch detected. Please contact support.",
          details: err.message,
        });
      }

      return res.status(500).json({
        success: false,
        message: "Failed to process return. All changes have been rolled back.",
        error: process.env.NODE_ENV === "development" ? err.message : undefined,
      });
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// GET /order/admin/return-details/:orderId
// ═══════════════════════════════════════════════════════════════════════════════
router.get(
  "/return-details/:orderId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const { orderId } = req.params;

    const order = await Order.findById(orderId).select(
      "orderNo status returns cart deliveredAt totalPrice shippingPrice discount",
    );

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    res.status(200).json({
      success: true,
      orderNo: order.orderNo,
      status: order.status,
      deliveredAt: order.deliveredAt,
      returns: order.returns || [],
      cart: order.cart.map((item) => ({
        sku: item.sku,
        productId:
          item.productId?.toString?.() ||
          item.product?.toString?.() ||
          item._id?.toString?.(),
        name: item.name,
        quantity: item.quantity,
        returnedQuantity: item.returnedQuantity || 0,
        price: item.basePrice || item.price,
        size: item.size,
        color: item.color?.name || item.color,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// GET /order/my-returns  (user)
// ═══════════════════════════════════════════════════════════════════════════════
router.get(
  "/my-returns",
  isAuthenticated,
  catchAsyncErrors(async (req, res) => {
    const userIdStr = getUserId(req.user);

    const orders = await Order.find({
      "user._id": userIdStr,
      returns: { $exists: true, $not: { $size: 0 } },
    })
      .sort({ "returns.returnedAt": -1 })
      .select("orderNo status totalPrice returns deliveredAt createdAt");

    const allReturns = [];
    orders.forEach((order) => {
      (order.returns || []).forEach((ret) => {
        allReturns.push({
          orderId: order._id,
          orderNo: order.orderNo,
          orderStatus: order.status,
          deliveredAt: order.deliveredAt,
          ...ret.toObject?.(),
        });
      });
    });

    res.status(200).json({
      success: true,
      count: allReturns.length,
      returns: allReturns,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// GET /order/my-returns/:orderId  (user)
// ═══════════════════════════════════════════════════════════════════════════════
router.get(
  "/my-returns/:orderId",
  isAuthenticated,
  catchAsyncErrors(async (req, res) => {
    const { orderId } = req.params;
    const userIdStr = getUserId(req.user);

    const order = await Order.findById(orderId).select(
      "orderNo status cart returns deliveredAt totalPrice shippingPrice discount",
    );

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const orderUserId =
      order.user?._id?.toString?.() || order.user?.toString?.();
    if (orderUserId !== userIdStr) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const itemsWithReturnStatus = order.cart.map((item) => {
      const totalReturned =
        order.returns?.reduce((sum, retBatch) => {
          const match = retBatch.items.find((r) => r.sku === item.sku);
          return sum + (match?.quantity || 0);
        }, 0) || 0;

      return {
        sku: item.sku,
        productId:
          item.productId?.toString?.() ||
          item.product?.toString?.() ||
          item._id?.toString?.(),
        name: item.name,
        orderedQuantity: item.quantity,
        returnedQuantity: totalReturned,
        remainingQuantity: (item.quantity || 1) - totalReturned,
        unitPrice: item.basePrice || item.price || 0,
        size: item.size,
        color: item.color?.name || item.color,
        canStillReturn: (item.quantity || 1) - totalReturned > 0,
      };
    });

    res.status(200).json({
      success: true,
      order: {
        _id: order._id,
        orderNo: order.orderNo,
        status: order.status,
        deliveredAt: order.deliveredAt,
        totalPrice: order.totalPrice,
        shippingPrice: order.shippingPrice,
        discount: order.discount,
      },
      items: itemsWithReturnStatus,
      returns: order.returns || [],
      isFullyReturned: order.status === "Returned",
      isReturnWindowOpen: order.deliveredAt
        ? new Date(order.deliveredAt) >
          new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        : false,
    });
  }),
);

module.exports = router;
