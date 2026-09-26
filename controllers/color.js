// require("dotenv").config();
// global.crypto = require("crypto");
// const mongoose = require("mongoose");
// const axios = require("axios");
// const Color = require("../models/colors");
// // ─── Color helpers ────────────────────────────────────────────────────────────

// /**
//  * Parse a hex string (with or without #) into { r, g, b } 0-255.
//  */
// function hexToRgb(hex) {
//   const clean = hex.replace(/^#/, "");
//   const int = parseInt(clean, 16);
//   return {
//     r: (int >> 16) & 255,
//     g: (int >> 8) & 255,
//     b: int & 255,
//   };
// }

// function rgbToHsv({ r, g, b }) {
//   const rn = r / 255;
//   const gn = g / 255;
//   const bn = b / 255;

//   const max = Math.max(rn, gn, bn);
//   const min = Math.min(rn, gn, bn);
//   const delta = max - min;

//   let h = 0;
//   if (delta !== 0) {
//     if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
//     else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
//     else h = 60 * ((rn - gn) / delta + 4);
//   }
//   if (h < 0) h += 360;

//   const s = max === 0 ? 0 : delta / max;
//   const v = max;

//   return { h, s, v };
// }

// function classifyFamily(hex) {
//   const rgb = hexToRgb(hex);
//   const { h, s, v } = rgbToHsv(rgb);

//   // ── Achromatic checks (neutrals) ──────────────────────────────────────────
//   if (v < 0.15) return "Black";
//   if (s < 0.12) {
//     if (v > 0.88) return "White";
//     if (v > 0.55) return "Gray";
//     return "Black";
//   }

//   // ── Brown  (warm, desaturated / dark hues in orange-red range) ───────────
//   if (h >= 10 && h < 45 && s < 0.55 && v < 0.65) return "Brown";

//   // ── Chromatic — hue wheel ─────────────────────────────────────────────────
//   //  Red      0–15  and  345–360
//   //  Orange  15–45
//   //  Yellow  45–70
//   //  Green   70–160
//   //  Cyan   160–195
//   //  Blue   195–260
//   //  Violet 260–290
//   //  Pink   290–345  (magenta/rose/hot-pink zone)

//   if (h < 15 || h >= 345) return "Red";
//   if (h < 45) return "Orange";
//   if (h < 70) return "Yellow";
//   if (h < 160) return "Green";
//   if (h < 195) return "Cyan";
//   if (h < 260) return "Blue";
//   if (h < 290) return "Violet";
//   return "Pink";
// }

// // ─── Main ─────────────────────────────────────────────────────────────────────
// const SOURCE_URL =
//   "https://raw.githubusercontent.com/meodai/wikipedia-color-names/main/colors.min.json";

// const BATCH_SIZE = 200; // how many bulkWrite ops per round-trip

// async function seed() {
//   const uri = process.env.MONGO_URI;

//   console.log("🔌 Connecting to MongoDB …");
//   await mongoose.connect(uri);
//   console.log("✅ Connected.\n");

//   // ── Fetch ──────────────────────────────────────────────────────────────────
//   console.log(`⬇️  Fetching colors from:\n   ${SOURCE_URL}\n`);
//   const { data } = await axios.get(SOURCE_URL);

//   // colors.min.json is an array of { name, hex, link }
//   if (!Array.isArray(data)) {
//     throw new Error("Unexpected response shape — expected an array.");
//   }
//   console.log(`📦 Fetched ${data.length} colors.\n`);

//   // ── Classify ───────────────────────────────────────────────────────────────
//   const docs = data.map(({ name, hex }) => ({
//     name,
//     hex: hex.toLowerCase(),
//     family: classifyFamily(hex),
//   }));

//   // Quick family distribution summary
//   const dist = docs.reduce((acc, { family }) => {
//     acc[family] = (acc[family] || 0) + 1;
//     return acc;
//   }, {});
//   console.log("🎨 Family distribution:");
//   Object.entries(dist)
//     .sort((a, b) => b[1] - a[1])
//     .forEach(([f, n]) => console.log(`   ${f.padEnd(8)} ${n}`));
//   console.log();

//   // ── Bulk upsert in batches ─────────────────────────────────────────────────
//   let inserted = 0;
//   let updated = 0;
//   let errors = 0;

//   for (let i = 0; i < docs.length; i += BATCH_SIZE) {
//     const batch = docs.slice(i, i + BATCH_SIZE);

//     const ops = batch.map((doc) => ({
//       updateOne: {
//         filter: { name: doc.name },
//         update: { $set: doc },
//         upsert: true,
//       },
//     }));

//     try {
//       const result = await Color.bulkWrite(ops, { ordered: false });
//       inserted += result.upsertedCount;
//       updated += result.modifiedCount;
//     } catch (err) {
//       // bulkWrite with ordered:false continues past errors; log them
//       console.error(
//         `⚠️  Batch ${i / BATCH_SIZE + 1} partial error:`,
//         err.message,
//       );
//       errors++;
//     }

//     process.stdout.write(
//       `\r💾 Progress: ${Math.min(i + BATCH_SIZE, docs.length)} / ${docs.length}`,
//     );
//   }

//   console.log("\n");
//   console.log("✅ Done!");
//   console.log(`   Inserted : ${inserted}`);
//   console.log(`   Updated  : ${updated}`);
//   if (errors) console.log(`   ⚠️  Batch errors: ${errors}`);

//   await mongoose.disconnect();
//   console.log("\n🔌 Disconnected.");
// }

// seed().catch((err) => {
//   console.error("❌ Fatal error:", err.message);
//   mongoose.disconnect().finally(() => process.exit(1));
// });
