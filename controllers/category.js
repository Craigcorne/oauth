const router = require("express").Router();
const mongoose = require("mongoose");
const Category = require("../models/category");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const NodeCache = require("node-cache");

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const generateSlug = (text) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");

/* Cache Setup                                                        */
const categoryCache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

const CACHE_KEYS = {
  list: (filter) => `categories:list:${JSON.stringify(filter)}`,
  single: (id) => `categories:single:${id}`,
  subcategories: (id) => `categories:${id}:subcategories`,
  allSubs: () => `categories:subcategories:all`,
};

// Flush everything (use after category create/update/delete)
const flushCategories = () => categoryCache.flushAll();

// Invalidate only subcategory-related caches
const invalidateSubcategoryCaches = (categoryId) => {
  categoryCache.del(CACHE_KEYS.single(categoryId));
  categoryCache.del(CACHE_KEYS.subcategories(categoryId));
  categoryCache.del(CACHE_KEYS.allSubs());
};

/* Categories                                                         */

// @desc    Get all categories
// @route   GET /api/categories
router.get("/", async (req, res) => {
  try {
    const filter = {};
    if (req.query.isActive !== undefined)
      filter.isActive = req.query.isActive === "true";

    const cacheKey = CACHE_KEYS.list(filter);
    let categories = categoryCache.get(cacheKey);
    let cacheHit = false;

    if (categories === undefined) {
      categories = await Category.find(filter).sort({ createdAt: -1 }).lean(); // ← .lean()
      categoryCache.set(cacheKey, categories);
    } else {
      cacheHit = true;
    }

    res.status(200).json({
      success: true,
      count: categories.length,
      cached: cacheHit,
      categories,
    });
  } catch (err) {
    console.error("GET CATEGORIES ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Get single category by ID
// @route   GET /api/categories/:id
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid category ID" });

    const cacheKey = CACHE_KEYS.single(id);
    let category = categoryCache.get(cacheKey);
    let cacheHit = false;

    if (category === undefined) {
      category = await Category.findById(id).lean(); // ← .lean()
      if (!category)
        return res
          .status(404)
          .json({ success: false, message: "Category not found" });
      categoryCache.set(cacheKey, category);
    } else {
      cacheHit = true;
    }

    res.status(200).json({ success: true, cached: cacheHit, category });
  } catch (err) {
    console.error("GET SINGLE CATEGORY ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Create a new category
// @route   POST /api/categories
router.post("/", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const { name, image, isActive } = req.body;
    if (!name)
      return res
        .status(400)
        .json({ success: false, message: "Category name is required" });

    const slug = generateSlug(name);

    const exists = await Category.findOne({ $or: [{ name }, { slug }] });
    if (exists)
      return res.status(409).json({
        success: false,
        message: "Category name or slug already exists",
      });

    const category = await Category.create({
      name,
      slug,
      image: image || { url: "", public_id: "" },
      isActive: isActive !== undefined ? isActive : true,
    });

    flushCategories();

    res.status(201).json({ success: true, category });
  } catch (err) {
    console.error("CREATE CATEGORY ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Update a category
// @route   PUT /api/categories/:id
router.put("/:id", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid category ID" });

    const { name, image, isActive, productCount } = req.body;
    const update = {};

    if (name !== undefined) {
      update.name = name.trim();
      update.slug = generateSlug(name);
      const duplicate = await Category.findOne({
        $or: [{ name: update.name }, { slug: update.slug }],
        _id: { $ne: id },
      });
      if (duplicate)
        return res.status(409).json({
          success: false,
          message: "Category name or slug already in use",
        });
    }

    if (image !== undefined) update.image = image;
    if (isActive !== undefined) update.isActive = isActive;
    if (productCount !== undefined) update.productCount = productCount;

    const category = await Category.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });
    if (!category)
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });

    flushCategories();

    res.status(200).json({ success: true, category });
  } catch (err) {
    console.error("UPDATE CATEGORY ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Delete a category (and all its embedded subcategories)
// @route   DELETE /api/categories/:id
router.delete("/:id", isAuthenticated, isAdmin("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid category ID" });

    const category = await Category.findByIdAndDelete(id);
    if (!category)
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });

    flushCategories();

    res
      .status(200)
      .json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    console.error("DELETE CATEGORY ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* SubCategories (nested inside Category)                             */
/* ------------------------------------------------------------------ */

// @desc    Get all subcategories for a specific category
// @route   GET /api/categories/:id/subcategories
router.get(
  "/:id/subcategories",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id))
        return res
          .status(400)
          .json({ success: false, message: "Invalid category ID" });

      const cacheKey = CACHE_KEYS.subcategories(id);
      let category = categoryCache.get(cacheKey);
      let cacheHit = false;

      if (category === undefined) {
        category = await Category.findById(id)
          .select("subcategories name")
          .lean(); // ← .lean()
        if (!category)
          return res
            .status(404)
            .json({ success: false, message: "Category not found" });
        categoryCache.set(cacheKey, category);
      } else {
        cacheHit = true;
      }

      res.status(200).json({
        success: true,
        count: category.subcategories.length,
        cached: cacheHit,
        subcategories: category.subcategories,
      });
    } catch (err) {
      console.error("GET SUBCATEGORIES ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// @desc    Add a subcategory to a category
// @route   POST /api/categories/:id/subcategories
router.post(
  "/:id/subcategories",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id))
        return res
          .status(400)
          .json({ success: false, message: "Invalid category ID" });

      const { name, isActive } = req.body;
      if (!name)
        return res
          .status(400)
          .json({ success: false, message: "Subcategory name is required" });

      const category = await Category.findById(id);
      if (!category)
        return res
          .status(404)
          .json({ success: false, message: "Category not found" });

      const slug = generateSlug(name);

      const nameExists = category.subcategories.some(
        (sub) => sub.name.toLowerCase() === name.toLowerCase(),
      );
      if (nameExists)
        return res.status(409).json({
          success: false,
          message: "Subcategory name already exists in this category",
        });

      category.subcategories.push({
        name: name.trim(),
        slug,
        isActive: isActive !== undefined ? isActive : true,
      });

      await category.save();
      invalidateSubcategoryCaches(id);

      res.status(201).json({ success: true, category });
    } catch (err) {
      console.error("CREATE SUBCATEGORY ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// @desc    Update a subcategory
// @route   PUT /api/categories/:id/subcategories/:subId
router.put(
  "/:id/subcategories/:subId",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const { id, subId } = req.params;
      if (!isValidObjectId(id) || !isValidObjectId(subId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid ID format" });
      }

      const { name, isActive } = req.body;
      const category = await Category.findById(id);
      if (!category)
        return res
          .status(404)
          .json({ success: false, message: "Category not found" });

      const sub = category.subcategories.id(subId);
      if (!sub)
        return res
          .status(404)
          .json({ success: false, message: "Subcategory not found" });

      if (name !== undefined) {
        sub.name = name.trim();
        sub.slug = generateSlug(name);
      }
      if (isActive !== undefined) sub.isActive = isActive;

      await category.save();
      invalidateSubcategoryCaches(id);

      res.status(200).json({ success: true, category });
    } catch (err) {
      console.error("UPDATE SUBCATEGORY ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// @desc    Delete a subcategory from a category
// @route   DELETE /api/categories/:id/subcategories/:subId
router.delete(
  "/:id/subcategories/:subId",
  isAuthenticated,
  isAdmin("admin"),
  async (req, res) => {
    try {
      const { id, subId } = req.params;
      if (!isValidObjectId(id) || !isValidObjectId(subId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid ID format" });
      }

      const category = await Category.findById(id);
      if (!category)
        return res
          .status(404)
          .json({ success: false, message: "Category not found" });

      const sub = category.subcategories.id(subId);
      if (!sub)
        return res
          .status(404)
          .json({ success: false, message: "Subcategory not found" });

      category.subcategories.pull(subId);
      await category.save();
      invalidateSubcategoryCaches(id);

      res.status(200).json({
        success: true,
        message: "Subcategory deleted successfully",
        category,
      });
    } catch (err) {
      console.error("DELETE SUBCATEGORY ERROR:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Bonus: Flattened subcategory list (across all categories)          */
/* ------------------------------------------------------------------ */

// @desc    Get every subcategory from every category
// @route   GET /api/categories/subcategories/all
router.get("/subcategories/all", async (req, res) => {
  try {
    const cacheKey = CACHE_KEYS.allSubs();
    let all = categoryCache.get(cacheKey);
    let cacheHit = false;

    if (all === undefined) {
      const categories = await Category.find()
        .select("name subcategories")
        .lean(); // ← .lean()
      all = categories.flatMap((cat) =>
        cat.subcategories.map((sub) => ({
          ...sub, // sub is already a plain object with .lean()
          category: { _id: cat._id, name: cat.name },
        })),
      );
      categoryCache.set(cacheKey, all);
    } else {
      cacheHit = true;
    }

    res.status(200).json({
      success: true,
      count: all.length,
      cached: cacheHit,
      subcategories: all,
    });
  } catch (err) {
    console.error("GET ALL SUBCATEGORIES ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
