const router = require("express").Router();
const Color = require("../models/colors");

const controller = require("../controllers/color");

// GET /api/v2/color/get-all?family=Neutral
router.get("/get-all", async (req, res) => {
  try {
    const filter = {};
    if (req.query.family) {
      filter.family = req.query.family;
    }

    const colors = await Color.find(filter).sort({ family: 1, name: 1 });

    res.status(200).json({
      success: true,
      count: colors.length,
      colors,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v2/color/families
router.get("/families", async (req, res) => {
  try {
    const families = await Color.distinct("family");
    res.status(200).json({
      success: true,
      families,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
