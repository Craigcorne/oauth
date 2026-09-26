const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/product");
const Color = require("../models/Colors");
const multer = require("multer");
const { isAdmin, isAuthenticated } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const upload = multer({ storage: multer.memoryStorage() });
const cloudinary = require("cloudinary").v2;
const NodeCache = require("node-cache");
const QRCodeModel = require("../models/qrCode");
const { syncProductQRCodes } = require("../utils/qrCodeService");

const router = express.Router();

/* ─── Cache Setup ─────────────────────────────────────────────────── */
const productCache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

const CACHE_KEYS = {
  list: (query) => `products:list:${JSON.stringify(query)}`,
  adminAll: () => `products:admin:all`,
  bySlug: (slug) => `products:slug:${slug}`,
  byId: (id) => `products:id:${id}`,
  inventory: (id) => `products:inventory:${id}`,
};

// Flush everything on any mutation
const flushProducts = () => productCache.flushAll();
/* ─────────────────────────────────────────────────────────────────── */

// Middleware: if req.body.data exists (FormData), parse it into req.body
const parseFormData = (req, res, next) => {
  if (req.body && typeof req.body.data === "string") {
    try {
      req.body = JSON.parse(req.body.data);
    } catch (err) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid JSON in form data" });
    }
  }
  next();
};

// ─── Helpers ─────────────────────────────────────────────

const generateSlug = (name) => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const buildUniqueSlug = async (name) => {
  let slug = generateSlug(name);
  let count = 0;
  let uniqueSlug = slug;

  while (await Product.exists({ slug: uniqueSlug })) {
    count++;
    uniqueSlug = `${slug}-${count}`;
  }
  return uniqueSlug;
};

// ─── Helper: find all public_ids that are being discarded ─────────
const getRemovedPublicIds = (oldVariants = [], newVariants = []) => {
  const ids = [];

  const newMap = new Map();
  newVariants.forEach((v) => {
    const key = v._id?.toString?.() || v.color?._id?.toString?.();
    if (key) newMap.set(key, v);
  });

  oldVariants.forEach((oldV) => {
    const key = oldV._id?.toString?.() || oldV.color?._id?.toString?.();
    const newV = key ? newMap.get(key) : null;

    if (!newV) {
      oldV.images?.forEach((img) => {
        if (img.public_id) ids.push(img.public_id);
      });
    } else {
      const keptIds = new Set(
        (newV.images || []).map((i) => i.public_id).filter(Boolean),
      );
      oldV.images?.forEach((img) => {
        if (img.public_id && !keptIds.has(img.public_id)) {
          ids.push(img.public_id);
        }
      });
    }
  });

  return ids;
};

// ─── Validation Middleware ───────────────────────────────

const validateProduct = (req, res, next) => {
  const {
    name,
    brand,
    sex,
    material,
    fit,
    sleeve,
    basePrice,
    category,
    subcategory,
    variants,
  } = req.body;
  const errors = [];

  if (!name || name.trim().length < 2)
    errors.push("Name must be at least 2 characters");
  if (!brand) errors.push("Brand is required");
  if (!sex) errors.push("Sex is required");
  if (!material) errors.push("Material is required");
  if (fit !== undefined && fit !== null && typeof fit !== "string")
    errors.push("Fit must be a string");
  if (sleeve !== undefined && sleeve !== null && typeof sleeve !== "string")
    errors.push("Sleeve must be a string");
  if (basePrice === undefined || basePrice < 0)
    errors.push("Valid basePrice is required");
  if (!category?._id || !category?.name || !category?.slug)
    errors.push("Complete category object required");
  if (!subcategory?._id || !subcategory?.name || !subcategory?.slug)
    errors.push("Complete subcategory object required");
  if (!variants || !Array.isArray(variants) || variants.length === 0) {
    errors.push("At least one variant is required");
  } else {
    variants.forEach((variant, vIdx) => {
      if (!variant.color?._id || !variant.color?.name || !variant.color?.hex) {
        errors.push(`Variant ${vIdx}: complete color object required`);
      }
      if (!variant.sizes || variant.sizes.length === 0) {
        errors.push(`Variant ${vIdx}: at least one size required`);
      } else {
        variant.sizes.forEach((sz, sIdx) => {
          if (!sz.size)
            errors.push(`Variant ${vIdx} Size ${sIdx}: size label required`);
          if (!sz.sku)
            errors.push(`Variant ${vIdx} Size ${sIdx}: SKU required`);
          if (sz.stock === undefined || sz.stock < 0)
            errors.push(`Variant ${vIdx} Size ${sIdx}: valid stock required`);
        });
      }
    });
  }

  if (errors.length > 0)
    return res.status(400).json({ success: false, errors });
  next();
};

// Assumes `cloudinary` (the configured v2 instance) is already required
// in this file, same as your original.

function uploadBufferToCloudinary(buffer, folder, attempt = 1) {
  const MAX_ATTEMPTS = 3;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (err, result) => {
        if (!err) return resolve(result);

        const isTimeout = err.name === "TimeoutError" || err.http_code === 499;

        // Only retry on timeouts — a bad file or auth error will just
        // fail the same way again, so don't waste the delay on those.
        if (isTimeout && attempt < MAX_ATTEMPTS) {
          const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, then 2s
          setTimeout(() => {
            uploadBufferToCloudinary(buffer, folder, attempt + 1).then(
              resolve,
              reject,
            );
          }, backoffMs);
          return;
        }

        reject(err);
      },
    );
    stream.end(buffer);
  });
}

// ─── CRUD Routes ─────────────────────────────────────────

// @desc    Create a new product
router.post(
  "/create-product",
  isAuthenticated,
  isAdmin("admin"),
  upload.any(),
  parseFormData,
  validateProduct,
  catchAsyncErrors(async (req, res, next) => {
    const uploadedPublicIds = [];
    let product;
    try {
      const payload = { ...req.body };

      if (!payload.slug) {
        payload.slug = await buildUniqueSlug(payload.name);
      } else {
        const exists = await Product.exists({
          slug: payload.slug.toLowerCase().trim(),
        });
        if (exists)
          return res
            .status(409)
            .json({ success: false, message: "Slug already exists" });
        payload.slug = payload.slug.toLowerCase().trim();
      }

      if (payload.currency) payload.currency = payload.currency.toUpperCase();

      payload.basePrice = Number(payload.basePrice);
      if (isNaN(payload.basePrice) || payload.basePrice < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid base price" });
      }

      if (payload.originalPrice != null && payload.originalPrice !== "") {
        payload.originalPrice = Number(payload.originalPrice);
        if (isNaN(payload.originalPrice) || payload.originalPrice < 0) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid original price" });
        }
        if (payload.originalPrice < payload.basePrice) {
          return res.status(400).json({
            success: false,
            message:
              "Original price must be greater than or equal to base price",
          });
        }
      } else {
        payload.originalPrice = undefined;
      }

      const filesByVariant = {};
      (req.files || []).forEach((file) => {
        const match = file.fieldname.match(/^variantImages_(\d+)$/);
        if (!match) return;
        const idx = Number(match[1]);
        (filesByVariant[idx] ||= []).push(file);
      });

      for (const [idxStr, files] of Object.entries(filesByVariant)) {
        const variant = payload.variants[Number(idxStr)];
        if (!variant) continue;

        const uploads = await Promise.all(
          files.map((file) =>
            uploadBufferToCloudinary(file.buffer, `products/${payload.slug}`),
          ),
        );

        uploads.forEach((r) => uploadedPublicIds.push(r.public_id));

        variant.images = [
          ...(variant.images || []),
          ...uploads.map((r) => ({
            public_id: r.public_id,
            url: r.secure_url,
          })),
        ];
      }

      const colorIds = [
        ...new Set(
          payload.variants
            .map((v) => v.color?._id?.toString?.())
            .filter(Boolean),
        ),
      ];

      const colorIdToFamily = {};
      if (colorIds.length > 0) {
        const colorDocs = await Color.find({ _id: { $in: colorIds } })
          .select("_id family")
          .lean();
        colorDocs.forEach((c) => {
          colorIdToFamily[c._id.toString()] = c.family;
        });
      }

      const familySet = new Set();
      const sizeSet = new Set();

      payload.variants.forEach((variant) => {
        const colorId = variant.color?._id?.toString?.();
        const family = colorIdToFamily[colorId] || variant.color?.family;
        if (family) familySet.add(family);
        variant.sizes.forEach((s) => sizeSet.add(s.size));
      });

      payload.availableColors = Array.from(familySet);
      payload.availableSizes = Array.from(sizeSet);

      /* ─── CREATE PRODUCT ─── */
      product = await Product.create(payload);
      flushProducts();

      /* ─── GENERATE QR CODES ─── */
      let qrCodes = [];
      try {
        qrCodes = await syncProductQRCodes(
          product,
          [],
          uploadBufferToCloudinary,
          cloudinary,
        );
      } catch (qrErr) {
        console.error("⚠️ QR Code generation failed:", qrErr.message);
        // Non-blocking: product is still created
      }

      res.status(201).json({ success: true, data: product, qrCodes });
    } catch (err) {
      console.error("❌ CREATE PRODUCT ERROR:", err);
      console.error("❌ ERROR NAME:", err.name);
      console.error("❌ ERROR MESSAGE:", err.message);
      console.error("❌ ERROR STACK:", err.stack);

      /* ─── ROLLBACK PRODUCT IMAGES ─── */
      if (uploadedPublicIds.length) {
        await Promise.allSettled(
          uploadedPublicIds.map((id) => cloudinary.uploader.destroy(id)),
        );
      }

      /* ─── ROLLBACK QR CODES ─── */
      try {
        if (product?._id) {
          const orphanQrs = await QRCodeModel.find({
            product: product._id,
          }).lean();
          if (orphanQrs.length) {
            await Promise.allSettled(
              orphanQrs.map((qr) => cloudinary.uploader.destroy(qr.publicId)),
            );
            await QRCodeModel.deleteMany({ product: product._id });
          }
        }
      } catch (_) {
        /* ignore cleanup errors */
      }

      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "Duplicate SKU or slug detected",
          error: err.message,
        });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

/**
 * @route   GET /api/products
 * @desc    Get all products with filtering, sorting, pagination
 */
router.get("/", async (req, res) => {
  try {
    const {
      category,
      subcategory,
      brand,
      sex,
      minPrice,
      maxPrice,
      search,
      color,
      size,
      inStock,
      sort = "-createdAt",
      page = 1,
      limit = 20,
    } = req.query;

    const filter = { isActive: true };

    if (category)
      filter["category._id"] = new mongoose.Types.ObjectId(category);
    if (subcategory)
      filter["subcategory._id"] = new mongoose.Types.ObjectId(subcategory);
    if (brand) filter.brand = new RegExp(brand, "i");
    if (sex) filter.sex = new RegExp(`^${sex}$`, "i");
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.basePrice = {};
      if (minPrice !== undefined) filter.basePrice.$gte = Number(minPrice);
      if (maxPrice !== undefined) filter.basePrice.$lte = Number(maxPrice);
    }
    if (color)
      filter["availableColors._id"] = new mongoose.Types.ObjectId(color);
    if (size) filter.availableSizes = size;
    if (inStock === "true") filter["variants.sizes.stock"] = { $gt: 0 };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { brand: { $regex: search, $options: "i" } },
        { material: { $regex: search, $options: "i" } },
      ];
    }

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = CACHE_KEYS.list({
      category,
      subcategory,
      brand,
      sex,
      minPrice,
      maxPrice,
      search,
      color,
      size,
      inStock,
      sort,
      pageNum,
      limitNum,
    });
    let cached = productCache.get(cacheKey);
    let cacheHit = false;

    if (cached === undefined) {
      const [products, total] = await Promise.all([
        Product.find(filter).sort(sort).skip(skip).limit(limitNum).lean(),
        Product.countDocuments(filter),
      ]);

      cached = { products, total };
      productCache.set(cacheKey, cached);
    } else {
      cacheHit = true;
    }

    res.status(200).json({
      success: true,
      count: cached.products.length,
      total: cached.total,
      page: pageNum,
      pages: Math.ceil(cached.total / limitNum),
      cached: cacheHit,
      data: cached.products,
    });
  } catch (err) {
    console.error("GET PRODUCTS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @route   GET /api/products/admin/all
 * @desc    Get all products including inactive (admin)
 */
router.get(
  "/admin/all",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);
    const search = (req.query.search || "").trim();
    const skip = (page - 1) * limit;

    const filter = search ? { name: { $regex: search, $options: "i" } } : {};

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      count: products.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: products,
    });
  }),
);
/**
 * @route   GET /api/products/slug/:slug
 * @desc    Get single product by slug
 */
router.get("/slug/:slug", async (req, res) => {
  try {
    const cacheKey = CACHE_KEYS.bySlug(req.params.slug);
    let product = productCache.get(cacheKey);
    let cacheHit = false;

    if (product === undefined) {
      product = await Product.findOne({
        slug: req.params.slug,
        isActive: true,
      }).lean();
      if (!product)
        return res
          .status(404)
          .json({ success: false, message: "Product not found" });
      productCache.set(cacheKey, product);
    } else {
      cacheHit = true;
    }

    res.status(200).json({ success: true, cached: cacheHit, data: product });
  } catch (err) {
    console.error("GET PRODUCT BY SLUG ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @route   GET /api/products/:id
 * @desc    Get single product by ID
 */
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product ID" });
    }

    const cacheKey = CACHE_KEYS.byId(req.params.id);
    let product = productCache.get(cacheKey);
    let cacheHit = false;

    if (product === undefined) {
      product = await Product.findById(req.params.id).lean();
      if (!product)
        return res
          .status(404)
          .json({ success: false, message: "Product not found" });
      productCache.set(cacheKey, product);
    } else {
      cacheHit = true;
    }

    res.status(200).json({ success: true, cached: cacheHit, data: product });
  } catch (err) {
    console.error("GET PRODUCT BY ID ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────── */
/* UPDATE                                                             */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * @route   PUT /api/products/:id
 * @desc    Full update of a product
 */
router.put(
  "/:id",
  isAuthenticated,
  isAdmin("admin"),
  upload.any(),
  parseFormData,
  catchAsyncErrors(async (req, res) => {
    let product;
    const uploadedPublicIds = [];

    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid product ID" });
      }

      const existing = await Product.findById(req.params.id);
      if (!existing) {
        return res
          .status(404)
          .json({ success: false, message: "Product not found" });
      }

      const payload = { ...req.body };

      // Trim optional string fields
      if (payload.fit != null) payload.fit = payload.fit.trim();
      if (payload.sleeve != null) payload.sleeve = payload.sleeve.trim();

      // ═══════════════════════════════════════════════════════════════
      // 1️⃣ DETECT NEW / INCREASED INVENTORY (diff before we overwrite)
      // ═══════════════════════════════════════════════════════════════
      const qrCodeTasks = [];

      if (payload.variants) {
        // Build map of existing SKU → stock
        const existingSkuMap = new Map();
        if (existing.variants) {
          existing.variants.forEach((variant) => {
            variant.sizes?.forEach((size) => {
              if (size.sku) {
                existingSkuMap.set(size.sku, Number(size.stock) || 0);
              }
            });
          });
        }

        payload.variants.forEach((variant, vIdx) => {
          variant.sizes?.forEach((size, sIdx) => {
            if (!size.sku) return;

            const newStock = Number(size.stock) || 0;
            const oldStock = existingSkuMap.get(size.sku) ?? 0;
            let qrCount = 0;

            if (!existingSkuMap.has(size.sku)) {
              // 🆕 Brand new SKU — QR for every unit
              qrCount = newStock;
            } else if (newStock > oldStock) {
              // 📈 Restock — QR only for the ADDED units
              qrCount = newStock - oldStock;
            }

            if (qrCount > 0) {
              qrCodeTasks.push({
                sku: size.sku,
                size: size.size,
                color: variant.color,
                productName: payload.name || existing.name,
                productSlug: payload.slug || existing.slug,
                variantIndex: vIdx,
                sizeIndex: sIdx,
                qrCount,
                oldStock,
                newStock,
              });
            }
          });
        });
      }

      // ─── slug validation ───
      if (payload.slug) {
        const slugExists = await Product.findOne({
          slug: payload.slug.toLowerCase().trim(),
          _id: { $ne: req.params.id },
        });
        if (slugExists)
          return res
            .status(409)
            .json({ success: false, message: "Slug already in use" });
        payload.slug = payload.slug.toLowerCase().trim();
      }

      if (payload.currency) payload.currency = payload.currency.toUpperCase();

      if (payload.basePrice != null) {
        payload.basePrice = Number(payload.basePrice);
        if (isNaN(payload.basePrice) || payload.basePrice < 0) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid base price" });
        }
      }

      if (payload.originalPrice != null && payload.originalPrice !== "") {
        payload.originalPrice = Number(payload.originalPrice);
        if (isNaN(payload.originalPrice) || payload.originalPrice < 0) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid original price" });
        }
        const base = payload.basePrice ?? existing.basePrice;
        if (payload.originalPrice < base) {
          return res.status(400).json({
            success: false,
            message:
              "Original price must be greater than or equal to base price",
          });
        }
      } else if (
        payload.originalPrice === "" ||
        payload.originalPrice === null
      ) {
        payload.originalPrice = undefined;
      }

      // ═══════════════════════════════════════════════════════════════
      // 2️⃣ HANDLE VARIANT IMAGES (track public_ids for rollback)
      // ═══════════════════════════════════════════════════════════════
      if (payload.variants) {
        // Delete removed images
        const toDelete = getRemovedPublicIds(
          existing.variants || [],
          payload.variants,
        );
        if (toDelete.length) {
          await Promise.allSettled(
            toDelete.map((id) => cloudinary.uploader.destroy(id)),
          );
        }

        // Upload new variant images
        const filesByVariant = {};
        (req.files || []).forEach((file) => {
          const match = file.fieldname.match(/^variantImages_(\d+)$/);
          if (match) {
            const idx = Number(match[1]);
            (filesByVariant[idx] ||= []).push(file);
          }
        });

        for (const [idxStr, files] of Object.entries(filesByVariant)) {
          const idx = Number(idxStr);
          const variant = payload.variants[idx];
          if (!variant) continue;

          const uploads = await Promise.all(
            files.map((file) =>
              uploadBufferToCloudinary(
                file.buffer,
                `products/${payload.slug || existing.slug}`,
              ),
            ),
          );

          uploads.forEach((r) => uploadedPublicIds.push(r.public_id));

          variant.images = [
            ...(variant.images || []),
            ...uploads.map((r) => ({
              public_id: r.public_id,
              url: r.secure_url,
            })),
          ];
        }

        // Derive availableColors / availableSizes
        const colorIds = [
          ...new Set(
            payload.variants
              .map((v) => v.color?._id?.toString?.())
              .filter(Boolean),
          ),
        ];

        const colorIdToFamily = {};
        if (colorIds.length > 0) {
          const colorDocs = await Color.find({ _id: { $in: colorIds } })
            .select("_id family")
            .lean();
          colorDocs.forEach((c) => {
            colorIdToFamily[c._id.toString()] = c.family;
          });
        }

        const familySet = new Set();
        const sizeSet = new Set();

        payload.variants.forEach((variant) => {
          const colorId = variant.color?._id?.toString?.();
          const family = colorIdToFamily[colorId] || variant.color?.family;
          if (family) familySet.add(family);
          variant.sizes?.forEach((s) => sizeSet.add(s.size));
        });

        payload.availableColors = Array.from(familySet);
        payload.availableSizes = Array.from(sizeSet);
      }

      // ═══════════════════════════════════════════════════════════════
      // 3️⃣ UPDATE PRODUCT
      // ═══════════════════════════════════════════════════════════════
      product = await Product.findByIdAndUpdate(req.params.id, payload, {
        returnDocument: "after",
        runValidators: true,
      });

      flushProducts();

      // ═══════════════════════════════════════════════════════════════
      // 4️⃣ GENERATE QR CODES (diff-aware, same pattern as create)
      // ═══════════════════════════════════════════════════════════════
      let qrCodes = [];
      if (qrCodeTasks.length > 0) {
        try {
          // Fetch current QR docs so sync can reuse images & know what to delete
          const existingQRCodes = await QRCodeModel.find({
            product: req.params.id,
          }).lean();

          // Map: sku -> delta (2 for 7→9, 5 for 0→5, etc.)
          const skuDiffs = new Map(qrCodeTasks.map((t) => [t.sku, t.qrCount]));

          qrCodes = await syncProductQRCodes(
            product,
            existingQRCodes,
            uploadBufferToCloudinary,
            cloudinary,
            skuDiffs, // ← tells sync to use delta, not total stock
          );
        } catch (qrErr) {
          console.error("⚠️ QR Code generation failed:", qrErr.message);
          // Non-blocking: product update is still persisted
        }
      }

      res.status(200).json({ success: true, data: product, qrCodes });
    } catch (err) {
      console.error("PUT PRODUCT ERROR:", err);
      console.error("❌ ERROR NAME:", err.name);
      console.error("❌ ERROR MESSAGE:", err.message);
      console.error("❌ ERROR STACK:", err.stack);

      // ─── ROLLBACK NEWLY UPLOADED IMAGES ───
      if (uploadedPublicIds.length) {
        await Promise.allSettled(
          uploadedPublicIds.map((id) => cloudinary.uploader.destroy(id)),
        );
      }

      // ─── ROLLBACK ORPHAN QR CODES (if any were created before crash) ───
      try {
        if (product?._id) {
          const orphanQrs = await QRCodeModel.find({
            product: product._id,
          }).lean();
          if (orphanQrs.length) {
            await Promise.allSettled(
              orphanQrs.map((qr) => cloudinary.uploader.destroy(qr.publicId)),
            );
            await QRCodeModel.deleteMany({ product: product._id });
          }
        }
      } catch (_) {
        /* ignore cleanup errors */
      }

      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "Duplicate SKU or slug detected",
          error: err.message,
        });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

/**
 * @route   PATCH /api/products/:id
 * @desc    Partial update of a product
 */
router.patch(
  "/:id",
  isAuthenticated,
  isAdmin("admin"),
  upload.any(),
  parseFormData,
  catchAsyncErrors(async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid product ID" });
      }

      const existing = await Product.findById(req.params.id);
      if (!existing) {
        return res
          .status(404)
          .json({ success: false, message: "Product not found" });
      }

      const allowedUpdates = [
        "name",
        "brand",
        "sex",
        "occassion",
        "material",
        "fit",
        "sleeve",
        "basePrice",
        "originalPrice",
        "currency",
        "category",
        "subcategory",
        "variants",
        "isActive",
      ];
      const updates = {};
      Object.keys(req.body).forEach((key) => {
        if (allowedUpdates.includes(key)) updates[key] = req.body[key];
      });

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          success: false,
          message: "No valid fields provided for update",
        });
      }

      // Trim optional string fields
      if (updates.fit != null) updates.fit = updates.fit.trim();
      if (updates.sleeve != null) updates.sleeve = updates.sleeve.trim();

      if (updates.currency) updates.currency = updates.currency.toUpperCase();

      if (updates.basePrice != null) {
        updates.basePrice = Number(updates.basePrice);
        if (isNaN(updates.basePrice) || updates.basePrice < 0) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid base price" });
        }
      }

      if (updates.originalPrice != null && updates.originalPrice !== "") {
        updates.originalPrice = Number(updates.originalPrice);
        if (isNaN(updates.originalPrice) || updates.originalPrice < 0) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid original price" });
        }
        const base = updates.basePrice ?? existing.basePrice;
        if (updates.originalPrice < base) {
          return res.status(400).json({
            success: false,
            message:
              "Original price must be greater than or equal to base price",
          });
        }
      } else if (
        updates.originalPrice === "" ||
        updates.originalPrice === null
      ) {
        updates.originalPrice = undefined;
      }

      if (updates.variants) {
        const toDelete = getRemovedPublicIds(
          existing.variants || [],
          updates.variants,
        );
        if (toDelete.length) {
          await Promise.allSettled(
            toDelete.map((id) => cloudinary.uploader.destroy(id)),
          );
        }

        const filesByVariant = {};
        (req.files || []).forEach((file) => {
          const match = file.fieldname.match(/^variantImages_(\d+)$/);
          if (match) {
            const idx = Number(match[1]);
            (filesByVariant[idx] ||= []).push(file);
          }
        });

        for (const [idxStr, files] of Object.entries(filesByVariant)) {
          const idx = Number(idxStr);
          const variant = updates.variants[idx];
          if (!variant) continue;

          const uploads = await Promise.all(
            files.map((file) =>
              uploadBufferToCloudinary(
                file.buffer,
                `products/${existing.slug}`,
              ),
            ),
          );

          variant.images = [
            ...(variant.images || []),
            ...uploads.map((r) => ({
              public_id: r.public_id,
              url: r.secure_url,
            })),
          ];
        }

        const colorIds = [
          ...new Set(
            updates.variants
              .map((v) => v.color?._id?.toString?.())
              .filter(Boolean),
          ),
        ];

        const colorIdToFamily = {};
        if (colorIds.length > 0) {
          const colorDocs = await Color.find({ _id: { $in: colorIds } })
            .select("_id family")
            .lean();
          colorDocs.forEach((c) => {
            colorIdToFamily[c._id.toString()] = c.family;
          });
        }

        const familySet = new Set();
        const sizeSet = new Set();

        updates.variants.forEach((variant) => {
          const colorId = variant.color?._id?.toString?.();
          const family = colorIdToFamily[colorId] || variant.color?.family;
          if (family) familySet.add(family);
          variant.sizes?.forEach((s) => sizeSet.add(s.size));
        });

        updates.availableColors = Array.from(familySet);
        updates.availableSizes = Array.from(sizeSet);
      }

      const product = await Product.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { returnDocument: "after", runValidators: true },
      );

      flushProducts(); // ← invalidate cache

      res.status(200).json({ success: true, data: product });
    } catch (err) {
      console.error("PATCH PRODUCT ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);
/**
 * @route   DELETE /api/products/:id
 * @desc    Delete a product and its images from Cloudinary
 */
router.delete(
  "/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid product ID" });
      }

      const product = await Product.findById(req.params.id);
      if (!product) {
        return res
          .status(404)
          .json({ success: false, message: "Product not found" });
      }

      const publicIds = [];
      product.variants?.forEach((variant) => {
        variant.images?.forEach((img) => {
          if (img.public_id) publicIds.push(img.public_id);
        });
      });

      if (publicIds.length > 0) {
        const results = await Promise.allSettled(
          publicIds.map((id) => cloudinary.uploader.destroy(id)),
        );

        results.forEach((result, i) => {
          if (result.status === "rejected") {
            console.error(`Failed to delete ${publicIds[i]}:`, result.reason);
          }
        });
      }

      await Product.findByIdAndDelete(req.params.id);
      flushProducts(); // ← invalidate cache

      res.status(200).json({
        success: true,
        message: "Product and associated images deleted successfully",
      });
    } catch (err) {
      console.error("DELETE PRODUCT ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

// ─── Variant & Stock Management ──────────────────────────

/**
 * @route   PATCH /api/products/:id/variants/:colorId/stock
 * @desc    Update stock for a specific size within a color variant
 */
router.patch(
  "/:id/variants/:colorId/stock",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    try {
      const { id, colorId } = req.params;
      const { size, stock } = req.body;

      if (
        !mongoose.Types.ObjectId.isValid(id) ||
        !mongoose.Types.ObjectId.isValid(colorId)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid ID format" });
      }
      if (!size || stock === undefined || stock < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Valid size and stock required" });
      }

      const product = await Product.findOneAndUpdate(
        {
          _id: id,
          "variants.color._id": new mongoose.Types.ObjectId(colorId),
          "variants.sizes.size": size,
        },
        { $set: { "variants.$[v].sizes.$[s].stock": stock } },
        {
          new: true,
          arrayFilters: [
            { "v.color._id": new mongoose.Types.ObjectId(colorId) },
            { "s.size": size },
          ],
        },
      );

      if (!product)
        return res.status(404).json({
          success: false,
          message: "Product, color, or size not found",
        });

      flushProducts(); // ← invalidate cache
      res.status(200).json({ success: true, data: product });
    } catch (err) {
      console.error("PATCH STOCK ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

/**
 * @route   POST /api/products/:id/variants
 * @desc    Add a new variant to existing product
 */
router.post(
  "/:id/variants",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    try {
      const { id } = req.params;
      const newVariant = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid product ID" });
      }
      if (
        !newVariant.color ||
        !newVariant.sizes ||
        newVariant.sizes.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Complete variant with color and sizes required",
        });
      }

      const product = await Product.findById(id);
      if (!product)
        return res
          .status(404)
          .json({ success: false, message: "Product not found" });

      const colorExists = product.variants.some(
        (v) => v.color._id.toString() === newVariant.color._id,
      );
      if (colorExists) {
        return res.status(409).json({
          success: false,
          message: "Variant with this color already exists",
        });
      }

      product.variants.push(newVariant);

      const colorMap = new Map();
      const sizeSet = new Set();
      product.variants.forEach((variant) => {
        colorMap.set(variant.color._id.toString(), variant.color);
        variant.sizes.forEach((s) => sizeSet.add(s.size));
      });
      product.availableColors = Array.from(colorMap.values());
      product.availableSizes = Array.from(sizeSet);

      await product.save();
      flushProducts(); // ← invalidate cache
      res.status(200).json({ success: true, data: product });
    } catch (err) {
      console.error("ADD VARIANT ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

/**
 * @route   DELETE /api/products/:id/variants/:colorId
 * @desc    Remove a variant by color ID
 */
router.delete(
  "/:id/variants/:colorId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    try {
      const { id, colorId } = req.params;
      if (
        !mongoose.Types.ObjectId.isValid(id) ||
        !mongoose.Types.ObjectId.isValid(colorId)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid ID format" });
      }

      const product = await Product.findById(id);
      if (!product)
        return res
          .status(404)
          .json({ success: false, message: "Product not found" });

      if (product.variants.length <= 1) {
        return res.status(400).json({
          success: false,
          message: "Cannot remove the only remaining variant",
        });
      }

      product.variants = product.variants.filter(
        (v) => v.color._id.toString() !== colorId,
      );

      const colorMap = new Map();
      const sizeSet = new Set();
      product.variants.forEach((variant) => {
        colorMap.set(variant.color._id.toString(), variant.color);
        variant.sizes.forEach((s) => sizeSet.add(s.size));
      });
      product.availableColors = Array.from(colorMap.values());
      product.availableSizes = Array.from(sizeSet);

      await product.save();
      flushProducts(); // ← invalidate cache
      res.status(200).json({ success: true, data: product });
    } catch (err) {
      console.error("DELETE VARIANT ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

// ─── Inventory Summary ───────────────────────────────────

/**
 * @route   GET /api/products/:id/inventory
 * @desc    Get inventory summary for a product
 */
router.get(
  "/:id/inventory",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid product ID" });
      }

      const cacheKey = CACHE_KEYS.inventory(req.params.id);
      let cached = productCache.get(cacheKey);
      let cacheHit = false;

      if (cached === undefined) {
        const product = await Product.findById(req.params.id).lean();
        if (!product)
          return res
            .status(404)
            .json({ success: false, message: "Product not found" });

        const summary = product.variants.map((variant) => ({
          color: variant.color,
          images: variant.images.length,
          sizes: variant.sizes.map((s) => ({
            size: s.size,
            sku: s.sku,
            stock: s.stock,
            status:
              s.stock === 0
                ? "OUT_OF_STOCK"
                : s.stock < 5
                  ? "LOW_STOCK"
                  : "IN_STOCK",
          })),
          totalStock: variant.sizes.reduce((sum, s) => sum + s.stock, 0),
        }));

        const grandTotal = summary.reduce((sum, v) => sum + v.totalStock, 0);

        cached = {
          productId: product._id,
          name: product.name,
          totalInventory: grandTotal,
          variants: summary,
        };
        productCache.set(cacheKey, cached);
      } else {
        cacheHit = true;
      }

      res.status(200).json({
        success: true,
        cached: cacheHit,
        data: cached,
      });
    } catch (err) {
      console.error("GET INVENTORY ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }),
);

module.exports = router;
