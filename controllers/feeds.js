const express = require("express");
const Product = require("../models/product");
const router = express.Router();

const SITE_URL = (process.env.SITE_URL || "https://yourdomain.com").replace(
  /\/$/,
  "",
);
const FEED_KEY = process.env.META_FEED_KEY;
const CACHE_MS = 15 * 60 * 1000; // rebuild at most every 15 minutes

const COLUMNS = [
  "id",
  "item_group_id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "sale_price",
  "link",
  "image_link",
  "additional_image_link",
  "brand",
  "color",
  "size",
  "gender",
  "age_group",
  "material",
  "product_type",
];

let cache = { at: 0, csv: "" };

const csvCell = (v) => {
  const s =
    v === undefined || v === null ? "" : String(v).replace(/\r?\n/g, " ");
  return `"${s.replace(/"/g, '""')}"`;
};

const money = (n, currency) => `${Number(n).toFixed(2)} ${currency || "KES"}`;

// Meta only accepts: male | female | unisex. Adjust to your `sex` values.
function toGender(sex = "") {
  const s = sex.toLowerCase();
  if (["women", "woman", "female", "ladies", "girls"].includes(s))
    return "female";
  if (["men", "man", "male", "boys"].includes(s)) return "male";
  return "unisex";
}

// Meta needs JPG/PNG at 500px+ ; ask Cloudinary for a JPG so WebP/AVIF
// sources never get rejected.
function metaImage(url) {
  if (!url) return "";
  return url.includes("/upload/")
    ? url.replace("/upload/", "/upload/f_jpg,q_auto,w_1200,c_limit/")
    : url;
}

function buildDescription(p) {
  if (p.description) return p.description; // use it if you add this field
  return [
    `${p.name} by ${p.brand}.`,
    p.material && `Made from ${p.material}.`,
    p.fit && `${p.fit} fit.`,
    p.sleeve && `${p.sleeve} sleeves.`,
    p.occassion && `Perfect for ${p.occassion}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function productToRows(p) {
  const rows = [];
  const onSale = p.originalPrice && p.originalPrice > p.basePrice;

  for (const variant of p.variants) {
    const images = (variant.images || [])
      .map((i) => metaImage(i.url))
      .filter(Boolean);
    if (!images.length) continue; // Meta rejects items without an image

    for (const size of variant.sizes) {
      const link = `${SITE_URL}/products/${p.slug}?color=${encodeURIComponent(
        variant.color.name,
      )}&size=${encodeURIComponent(size.size)}`;

      const row = {
        id: size.sku,
        item_group_id: String(p._id),
        title: `${p.name} - ${variant.color.name}`,
        description: buildDescription(p),
        availability: size.stock > 0 ? "in stock" : "out of stock",
        condition: "new",
        // Meta: `price` is the regular price, `sale_price` the discounted one
        price: money(onSale ? p.originalPrice : p.basePrice, p.currency),
        sale_price: onSale ? money(p.basePrice, p.currency) : "",
        link,
        image_link: images[0],
        additional_image_link: images.slice(1, 11).join(","),
        brand: p.brand,
        color: variant.color.name,
        size: size.size,
        gender: toGender(p.sex),
        age_group: "adult",
        material: p.material,
        product_type: [p.category?.name, p.subcategory?.name]
          .filter(Boolean)
          .join(" > "),
      };
      rows.push(COLUMNS.map((c) => csvCell(row[c])).join(","));
    }
  }
  return rows;
}

router.get("/meta-catalog.csv", async (req, res) => {
  if (!FEED_KEY || req.query.key !== FEED_KEY) return res.sendStatus(401);

  try {
    if (Date.now() - cache.at > CACHE_MS) {
      const products = await Product.find({ isActive: true }).lean();
      const lines = [COLUMNS.join(",")];
      for (const p of products) lines.push(...productToRows(p));
      cache = { at: Date.now(), csv: lines.join("\n") };
    }
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.send(cache.csv);
  } catch (err) {
    console.error("Meta feed error:", err);
    res.sendStatus(500);
  }
});

module.exports = router;

// In your server entry file:
//   app.use("/feeds", require("./routes/metaFeed"));
// Feed URL for Commerce Manager:
//   https://yourdomain.com/feeds/meta-catalog.csv?key=YOUR_META_FEED_KEY
