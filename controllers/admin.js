const express = require("express");
const { getCache, setCache, delCache } = require("../utils/cache");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const QRCodeModel = require("../models/qrCode");
const cloudinary = require("cloudinary").v2;
const mongoose = require("mongoose");
/**
 * @route   GET /api/products/admin/qrcodes/printable
 * @desc    Get all QR codes with printCount >= 1 (for physical printing / social upload tracking)
 * @access  Admin only
 */
router.get(
  "/qrcodes/printable",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const CACHE_KEY = "admin:qrcodes:printable";
    const CACHE_TTL = 300; // 5 minutes

    // 1. Try cache first
    const cached = getCache(CACHE_KEY);
    if (cached) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        count: cached.length,
        data: cached,
      });
    }

    // 2. Fetch from DB with product populated
    const qrCodes = await QRCodeModel.find({ printCount: { $gte: 1 } })
      .populate({
        path: "product",
        select: "name slug basePrice originalPrice currency isActive",
      })
      .sort({ createdAt: -1 })
      .lean();

    // 3. Store in cache
    setCache(CACHE_KEY, qrCodes, CACHE_TTL);

    res.status(200).json({
      success: true,
      fromCache: false,
      count: qrCodes.length,
      data: qrCodes,
    });
  }),
);

/**
 * @route   DELETE /api/products/admin/qrcodes/:id
 * @desc    Delete a QR code doc + its Cloudinary image
 * @access  Admin only
 */

router.delete(
  "/qrcodes/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid QR code ID" });
      }

      const qr = await QRCodeModel.findById(req.params.id);
      if (!qr) {
        return res
          .status(404)
          .json({ success: false, message: "QR code not found" });
      }

      // ─── Delete Cloudinary image (same pattern as product delete) ───
      if (qr.publicId) {
        const result = await cloudinary.uploader.destroy(qr.publicId);

        if (result.result !== "ok" && result.result !== "not found") {
          console.error(`Failed to delete QR image ${qr.publicId}:`, result);
        }
      }

      // ─── Delete from DB ───
      await QRCodeModel.findByIdAndDelete(req.params.id);

      // ─── Bust cache ───
      delCache("admin:qrcodes:printable");

      res.status(200).json({
        success: true,
        message: "QR code deleted successfully",
      });
    } catch (err) {
      console.error("DELETE QR CODE ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

module.exports = router;
