const express = require("express");
const mongoose = require("mongoose");
const NodeCache = require("node-cache");
const Collection = require("../models/collection");
const Product = require("../models/product");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const CACHE_KEYS = {
  LIST: (q) => `collections:list:${JSON.stringify(q)}`,
  ENUMS: "collections:meta:enums",
  SLUG: (s) => `collections:slug:${s}`,
};

function clearCollectionCache() {
  const keys = cache.keys().filter((k) => k.startsWith("collections:"));
  cache.del(keys);
}
const slugify = (str) =>
  str
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-") // spaces → dashes
    .replace(/[^\w\-]+/g, "") // remove non-word chars
    .replace(/\-\-+/g, "-");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function resolveCoverImage(productIds, providedUrl = null) {
  if (providedUrl) return providedUrl;
  if (!productIds || productIds.length === 0) return null;

  const firstProduct = await Product.findById(productIds[0]).lean();
  if (!firstProduct) return null;

  const firstVariant = firstProduct.variants?.[0];
  const firstImage = firstVariant?.images?.[0];
  return firstImage?.url || null;
}

function buildFilter(query) {
  const filter = {};
  if (query.division && Collection.DIVISIONS.includes(query.division)) {
    filter.division = query.division;
  }
  if (query.status && Collection.STATUSES.includes(query.status)) {
    filter.status = query.status;
  }
  if (query.search) {
    filter.$text = { $search: query.search };
  }
  return filter;
}
// ── helper: generate a unique slug ──
const generateUniqueSlug = async (
  baseSlug,
  CollectionModel,
  excludeId = null,
) => {
  let slug = baseSlug;
  let counter = 1;
  const maxAttempts = 100;

  while (counter <= maxAttempts) {
    const query = { slug };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const exists = await CollectionModel.exists(query);
    if (!exists) return slug;

    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  throw new Error("Unable to generate a unique slug after 100 attempts");
};

// ---------------------------------------------------------------------------
// READ routes (cached)
// ---------------------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.LIST(req.query);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;
    const filter = buildFilter(req.query);

    const [collections, total] = await Promise.all([
      Collection.find(filter)
        .populate(
          "products",
          "name slug basePrice originalPrice brand variants",
        )
        .populate("createdBy updatedBy", "name email")
        .sort(req.query.sort || "-createdAt")
        .skip(skip)
        .limit(limit)
        .lean(),
      Collection.countDocuments(filter),
    ]);

    const payload = {
      success: true,
      data: collections,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    };

    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get("/meta/enums", (_req, res) => {
  const cacheKey = CACHE_KEYS.ENUMS;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const payload = {
    success: true,
    data: {
      divisions: Collection.DIVISIONS,
      statuses: Collection.STATUSES,
    },
  };

  cache.set(cacheKey, payload);
  res.json(payload);
});

router.get("/:slug", async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.SLUG(req.params.slug);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const collection = await Collection.findOne({ slug: req.params.slug })
      .populate({
        path: "products",
        select:
          "name slug image brand sex basePrice originalPrice currency sold averageRating reviewCount tag badge tone category subcategory variants availableSizes availableColors material fit sleeve occassion createdAt isActive",
      })
      .populate("createdBy updatedBy", "name email")
      .lean();

    if (!collection) {
      return res
        .status(404)
        .json({ success: false, message: "Collection not found" });
    }

    const payload = { success: true, data: collection };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// ── POST ──
router.post("/", isAuthenticated, isAdmin("admin"), async (req, res, next) => {
  try {
    const { name, division, status, products, coverImage, slug, ...rest } =
      req.body;

    if (!name || !division) {
      return res.status(400).json({
        success: false,
        message: "Name and division are required.",
      });
    }

    let productIds = [];
    if (products && products.length > 0) {
      productIds = products
        .map((id) =>
          mongoose.Types.ObjectId.isValid(id)
            ? new mongoose.Types.ObjectId(id)
            : null,
        )
        .filter(Boolean);
    }

    const resolvedCover = await resolveCoverImage(
      productIds,
      coverImage || null,
    );

    // Build base slug from explicit slug or name, then ensure uniqueness
    const baseSlug = slugify(slug?.trim() ? slug : name);
    const finalSlug = await generateUniqueSlug(baseSlug, Collection);

    const collection = new Collection({
      name,
      division,
      status: status || "draft",
      products: productIds,
      coverImage: resolvedCover,
      slug: finalSlug,
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
      ...rest,
    });

    await collection.save();
    await collection.populate("products");
    await collection.populate("createdBy updatedBy", "name email");

    clearCollectionCache();
    res.status(201).json({ success: true, data: collection });
  } catch (err) {
    console.error("❌ POST /collections error:", err);

    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A collection with this slug already exists.",
      });
    }
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ── PUT ──
router.put(
  "/:id",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid collection ID" });
      }

      const collection = await Collection.findById(id);
      if (!collection) {
        return res
          .status(404)
          .json({ success: false, message: "Collection not found" });
      }

      const {
        name,
        division,
        status,
        products,
        coverImage,
        slug,
        ...otherUpdates
      } = req.body;

      if (name !== undefined) collection.name = name;
      if (division !== undefined) collection.division = division;
      if (status !== undefined) collection.status = status;

      // ── slug handling with collision check ──
      let newSlug = null;
      if (slug !== undefined) {
        newSlug = slugify(slug);
      } else if (name !== undefined) {
        newSlug = slugify(name);
      }

      if (newSlug && newSlug !== collection.slug) {
        collection.slug = await generateUniqueSlug(
          newSlug,
          Collection,
          collection._id,
        );
      }
      // ──────────────────────────────────────

      let productIdsChanged = false;
      if (products !== undefined) {
        const newIds = products
          .map((pid) =>
            mongoose.Types.ObjectId.isValid(pid)
              ? new mongoose.Types.ObjectId(pid)
              : null,
          )
          .filter(Boolean);

        const oldIds = collection.products.map((p) => p.toString());
        const newIdsStr = newIds.map((p) => p.toString());
        if (
          oldIds.length !== newIdsStr.length ||
          !oldIds.every((id, i) => id === newIdsStr[i])
        ) {
          collection.products = newIds;
          productIdsChanged = true;
        }
      }

      if (productIdsChanged && coverImage === undefined) {
        collection.coverImage = await resolveCoverImage(
          collection.products.map((p) => p.toString()),
        );
      } else if (coverImage !== undefined) {
        collection.coverImage =
          coverImage ||
          (await resolveCoverImage(
            collection.products.map((p) => p.toString()),
          ));
      }

      collection.updatedBy = req.user?._id;
      Object.assign(collection, otherUpdates);

      await collection.save();
      await collection.populate("products");
      await collection.populate("createdBy updatedBy", "name email");

      clearCollectionCache();
      res.json({ success: true, data: collection });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "Slug conflict. A collection with this name already exists.",
        });
      }
      next(err);
    }
  },
);
router.patch(
  "/:id/status",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid collection ID" });
      }
      if (!status || !Collection.STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Status must be one of: ${Collection.STATUSES.join(", ")}`,
        });
      }

      const collection = await Collection.findById(id);
      if (!collection) {
        return res
          .status(404)
          .json({ success: false, message: "Collection not found" });
      }

      collection.status = status;
      collection.updatedBy = req.user?._id;
      await collection.save();
      await collection.populate("products");

      clearCollectionCache(); // << FIXED
      res.json({ success: true, data: collection });
    } catch (err) {
      if (
        err.message?.includes("Cannot publish a collection with no products")
      ) {
        return res.status(422).json({ success: false, message: err.message });
      }
      next(err);
    }
  },
);

router.patch(
  "/:id/products",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { add = [], remove = [], reorder = [] } = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid collection ID" });
      }

      const collection = await Collection.findById(id);
      if (!collection) {
        return res
          .status(404)
          .json({ success: false, message: "Collection not found" });
      }

      const toAdd = add
        .filter((pid) => mongoose.Types.ObjectId.isValid(pid))
        .map((pid) => new mongoose.Types.ObjectId(pid));

      for (const pid of toAdd) {
        if (!collection.products.some((p) => p.equals(pid))) {
          collection.products.push(pid);
        }
      }

      const toRemove = remove
        .filter((pid) => mongoose.Types.ObjectId.isValid(pid))
        .map((pid) => pid.toString());

      if (toRemove.length > 0) {
        collection.products = collection.products.filter(
          (p) => !toRemove.includes(p.toString()),
        );
      }

      if (reorder.length > 0) {
        collection.products = reorder
          .filter((pid) => mongoose.Types.ObjectId.isValid(pid))
          .map((pid) => new mongoose.Types.ObjectId(pid));
      }

      const productsChanged =
        add.length > 0 || remove.length > 0 || reorder.length > 0;
      if (productsChanged) {
        collection.coverImage = await resolveCoverImage(
          collection.products.map((p) => p.toString()),
        );
      }

      collection.updatedBy = req.user?._id;
      await collection.save();
      await collection.populate("products");

      clearCollectionCache(); // << FIXED
      res.json({ success: true, data: collection });
    } catch (err) {
      next(err);
    }
  },
);
router.delete(
  "/:id",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const permanent = req.query.permanent === "true";

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid collection ID" });
      }

      if (permanent) {
        const deleted = await Collection.findByIdAndDelete(id);
        if (!deleted) {
          return res
            .status(404)
            .json({ success: false, message: "Collection not found" });
        }
        clearCollectionCache(); // << FIXED
        return res.json({
          success: true,
          message: "Collection permanently deleted",
        });
      }

      const collection = await Collection.findByIdAndUpdate(
        id,
        { status: "archived", updatedBy: req.user?._id },
        { returnDocument: "after" },
      );

      if (!collection) {
        return res
          .status(404)
          .json({ success: false, message: "Collection not found" });
      }

      clearCollectionCache(); // << FIXED
      res.json({
        success: true,
        message: "Collection archived",
        data: collection,
      });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
