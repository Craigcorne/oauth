const Review = require("../models/Review");
const Order = require("../models/Order");
const Product = require("../models/Product");
const { isAuthenticated } = require("../middleware/auth");
const cloudinary = require("cloudinary").v2;
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

const uploadBufferToCloudinary = (buffer, folder) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder, resource_type: "image" }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      })
      .end(buffer);
  });
};

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
        files.map((file) =>
          uploadBufferToCloudinary(file.buffer, `reviews/${productId}`),
        ),
      );

      uploads.forEach((r) => {
        uploadedPublicIds.push(r.public_id);
        reviewImages.push({
          public_id: r.public_id,
          url: r.secure_url,
        });
      });
    }

    const review = await Review.create({
      user: userId,
      product: productId,
      order: orderId,
      rating: Number(rating),
      comment: comment?.trim(),
      images: reviewImages,
    });

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

    res.status(201).json({ success: true, review });
  } catch (err) {
    console.error("❌ CREATE REVIEW ERROR:", err);

    if (uploadedPublicIds.length) {
      await Promise.allSettled(
        uploadedPublicIds.map((id) => cloudinary.uploader.destroy(id)),
      );
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

router.post("/reviews", isAuthenticated, upload.any(), createReview);
router.get("/reviews/check", isAuthenticated, checkReviewStatus);
router.get("/product/:productId", getProductReviews);
router.get("/stats", getRatingStats);

module.exports = router;
