const Review = require("../models/review");
const Order = require("../models/order");
const Product = require("../models/product");
const { isAuthenticated } = require("../middleware/auth");
const cloudinary = require("cloudinary").v2;
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const crypto = require("crypto"); // or: import crypto from "crypto";
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

const MAX_ATTEMPTS = 3;

function uploadBufferToCloudinary(
  buffer,
  folder,
  { maxSize = 1600, quality = 80 } = {},
) {
  const publicId = crypto.randomUUID(); // generated once, reused on every retry

  const attemptUpload = (attempt) =>
    new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          overwrite: true, // a retry replaces any earlier copy
          resource_type: "image",
          format: "webp",
          transformation: [
            { width: maxSize, height: maxSize, crop: "limit", quality },
          ],
        },
        (err, result) => {
          if (!err) return resolve(result);

          const isRetryable =
            err.name === "TimeoutError" ||
            err.http_code === 499 ||
            err.code === "ECONNRESET" ||
            err.code === "ETIMEDOUT";

          if (isRetryable && attempt < MAX_ATTEMPTS) {
            const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, then 2s
            setTimeout(
              () => attemptUpload(attempt + 1).then(resolve, reject),
              backoffMs,
            );
            return;
          }

          reject(err);
        },
      );

      stream.end(buffer);
    });

  return attemptUpload(1);
}

const createReview = async (req, res) => {
  const uploadedPublicIds = [];

  try {
    const { orderId, productId, rating, comment } = req.body;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product ID" });
    }

    const order = await Order.findOne({
      _id: orderId,
      status: "Delivered",
    });

    if (!order) {
      return res.status(403).json({
        success: false,
        message: "Order not found or not delivered yet",
      });
    }

    const orderUserId =
      order.user?._id?.toString?.() || order.user?.toString?.() || order.user;

    if (orderUserId !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Order not found or not delivered yet",
      });
    }

    const hasProduct = order.cart.some((item) => {
      const cartProductId =
        (typeof item.product === "string" && item.product) ||
        item.product?._id?.toString?.() ||
        item.product?.toString?.() ||
        item.productId?.toString?.() ||
        item._id?.toString?.();
      return cartProductId === productId;
    });

    if (!hasProduct) {
      return res.status(400).json({
        success: false,
        message: "Product not found in this order",
      });
    }

    const existing = await Review.findOne({
      user: userId,
      product: productId,
      order: orderId,
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You have already reviewed this product",
      });
    }

    let reviewImages = [];
    const files = req.files || [];

    if (files.length > 2) {
      return res.status(400).json({
        success: false,
        message: "Maximum 2 images allowed",
      });
    }

    if (files.length > 0) {
      const uploads = await Promise.all(
        files.map(async (file) => {
          const result = await uploadBufferToCloudinary(
            file.buffer,
            `reviews/${productId}`,
            { maxSize: 1200 }, // review photos don't need 1600px
          );
          uploadedPublicIds.push(result.public_id); // track immediately for rollback
          return result;
        }),
      );

      reviewImages = uploads.map((r) => ({
        public_id: r.public_id,
        url: r.secure_url,
      }));
    }
    const review = await Review.create({
      user: userId,
      product: productId,
      order: orderId,
      rating: Number(rating),
      comment: comment?.trim(),
      images: reviewImages,
    });

    // Non-blocking: the review exists, so don't roll back its images if stats fail
    try {
      const stats = await Review.aggregate([
        { $match: { product: new mongoose.Types.ObjectId(productId) } },
        {
          $group: {
            _id: "$product",
            avgRating: { $avg: "$rating" },
            count: { $sum: 1 },
          },
        },
      ]);

      if (stats.length > 0) {
        await Product.findByIdAndUpdate(productId, {
          averageRating: Math.round(stats[0].avgRating * 10) / 10,
          reviewCount: stats[0].count,
        });
      }
    } catch (statsErr) {
      console.error("⚠️ Review stats update failed:", statsErr.message);
    }

    res.status(201).json({ success: true, review });
  } catch (err) {
    console.error("❌ CREATE REVIEW ERROR:", err);

    if (uploadedPublicIds.length) {
      await Promise.allSettled(
        uploadedPublicIds.map((id) => cloudinary.uploader.destroy(id)),
      );
    }

    if (err.http_code === 400) {
      return res.status(400).json({
        success: false,
        message: "Invalid image file",
      });
    }

    res.status(500).json({ success: false, message: err.message });
  }
};

const checkReviewStatus = async (req, res) => {
  try {
    const { orderId, productId } = req.query;
    const userId = req.user._id;

    const review = await Review.findOne({
      user: userId,
      product: productId,
      order: orderId,
    }).select("_id rating comment images createdAt");

    res.status(200).json({
      success: true,
      hasReviewed: !!review,
      review: review || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    const reviews = await Review.find({ product: productId })
      .populate("user", "name avatar")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, reviews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getRatingStats = async (req, res) => {
  try {
    const [stats] = await Review.aggregate([
      { $match: { rating: { $gt: 0 } } }, // ignore any rating-less docs
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$rating" },
          totalReviews: { $sum: 1 },
          distribution: {
            $push: "$rating", // collected then bucketed below
          },
        },
      },
      {
        $project: {
          _id: 0,
          averageRating: { $round: ["$averageRating", 1] },
          totalReviews: 1,
          distribution: 1,
        },
      },
    ]);

    res.status(200).json({
      success: true,
      stats: stats || { averageRating: 0, totalReviews: 0, distribution: [] },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
const reviewUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2 }, // 5 MB each, max 2 files
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith("image/")
      ? cb(null, true)
      : cb(new Error("Only image files are allowed")),
});

router.post("/reviews", isAuthenticated, reviewUpload.any(), createReview);
router.get("/reviews/check", isAuthenticated, checkReviewStatus);
router.get("/product/:productId", getProductReviews);
router.get("/stats", getRatingStats);

module.exports = router;
