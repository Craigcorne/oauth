const express = require("express");
const router = express.Router();
const { isAuthenticated } = require("../middleware/auth");
const User = require("../models/user");

// GET /api/wishlist
router.get("/wishlist", isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("wishlist");
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ wishlist: user.wishlist || [] });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/wishlist/add
router.post("/wishlist/add", isAuthenticated, async (req, res) => {
  try {
    const { productId } = req.body;
    const user = await User.findById(req.user.id);

    // Safer check: compare as strings to avoid ObjectId casting edge cases
    const alreadyAdded = user.wishlist.some(
      (id) => id.toString() === productId,
    );

    if (!alreadyAdded) {
      user.wishlist.push(productId);
      await user.save();
    }

    res.json({ message: "Added to wishlist" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/wishlist/remove/:id
router.delete("/wishlist/remove/:id", isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    user.wishlist = user.wishlist.filter(
      (item) => item.toString() !== req.params.id,
    );

    await user.save();
    res.json({ message: "Removed from wishlist" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
