const QRCodeLib = require("qrcode");
const QRCodeModel = require("../models/qrCode");

/**
 * Generates / updates QR codes for a product.
 *
 * @param {Object} productDoc - Mongoose product document
 * @param {Array} existingQRCodes - Already saved QRCode docs for this product
 * @param {Function} uploadBufferToCloudinary
 * @param {Object} cloudinary
 * @param {Map} skuDiffs - Optional. sku -> delta (new units to print).
 *                         When provided, ONLY these SKUs are processed.
 */
async function syncProductQRCodes(
  productDoc,
  existingQRCodes,
  uploadBufferToCloudinary,
  cloudinary,
  skuDiffs = null,
) {
  const existingBySku = new Map(existingQRCodes.map((qr) => [qr.sku, qr]));
  const resultQRCodes = [];
  const cloudinaryIdsToDestroy = [];

  const isDiffMode = skuDiffs && skuDiffs.size > 0;

  // ── Build a flat map of all SKU -> size data from the product doc ──
  const productSkuMap = new Map();
  for (const variant of productDoc.variants || []) {
    for (const size of variant.sizes || []) {
      if (!size.sku) continue;
      productSkuMap.set(size.sku, {
        size,
        slug: productDoc.slug,
        productId: productDoc._id,
      });
    }
  }

  // ── Determine which SKUs to process ──
  const skusToProcess = isDiffMode
    ? Array.from(skuDiffs.keys()) // UPDATE: only the changed SKUs
    : Array.from(productSkuMap.keys()); // CREATE: all SKUs

  for (const sku of skusToProcess) {
    const productData = productSkuMap.get(sku);
    if (!productData) continue; // safety: SKU not found in product

    const { size, slug, productId } = productData;
    const existing = existingBySku.get(sku);

    const payload = { sku, slug };
    const payloadJson = JSON.stringify(payload);

    // In diff mode, printCount is the DELTA (e.g. 3 for 2→5)
    // In create mode, printCount is the TOTAL stock
    const printCount = isDiffMode ? skuDiffs.get(sku) : Number(size.stock) || 0;

    // ── Re-use existing QR if slug/sku haven't changed ──
    if (existing && existing.data === payloadJson) {
      if (existing.printCount !== printCount) {
        await QRCodeModel.updateOne(
          { _id: existing._id },
          { $set: { printCount } },
        );
        existing.printCount = printCount;
      }
      resultQRCodes.push(existing);
      continue;
    }

    // ── Generate new QR PNG ──
    const qrBuffer = await QRCodeLib.toBuffer(payloadJson, {
      type: "png",
      width: 500,
      margin: 2,
      errorCorrectionLevel: "H",
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });

    const upload = await uploadBufferToCloudinary(qrBuffer, `qrcodes/${slug}`);

    // Destroy old Cloudinary asset if replacing
    if (existing?.publicId) {
      cloudinaryIdsToDestroy.push(existing.publicId);
      await QRCodeModel.deleteOne({ _id: existing._id });
    }

    const qrDoc = await QRCodeModel.create({
      product: productId,
      sku,
      slug,
      data: payloadJson,
      imageUrl: upload.secure_url,
      publicId: upload.public_id,
      printCount,
    });

    resultQRCodes.push(qrDoc);
  }

  // Cleanup Cloudinary in parallel
  if (cloudinaryIdsToDestroy.length) {
    await Promise.allSettled(
      cloudinaryIdsToDestroy.map((id) => cloudinary.uploader.destroy(id)),
    );
  }

  return resultQRCodes;
}

module.exports = { syncProductQRCodes };
