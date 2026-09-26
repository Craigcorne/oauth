const express = require("express");
const router = express.Router();
const Invoice = require("../models/invoice");
const User = require("../models/user");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const NodeCache = require("node-cache");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

/* Cache Setup                                                        */
const invoiceCache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

const CACHE_KEYS = {
  all: () => `invoices:all`,
  single: (id) => `invoice:single:${id}`,
  byUser: (userId) => `invoices:user:${userId}`,
};

// Invalidate all invoice caches on mutations
const flushInvoices = () => invoiceCache.flushAll();

/* ------------------------------------------------------------------ */

// Create invoice
router.post(
  "/create-invoice",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { receiptNo, amount, purpose, userId, type, paid, metadata } =
      req.body;

    if (!purpose || amount === undefined || !type || !userId) {
      return res.status(400).json({
        success: false,
        message: "purpose, amount, type, and userId are required",
      });
    }

    // Optional: fetch user to snapshot their current balance
    const user = await User.findById(userId);
    const balance = user?.availableBalance || 0;

    const invoice = await Invoice.create({
      receiptNo: receiptNo || `INV-${Date.now()}`,
      amount: Number(amount),
      purpose,
      userId,
      type,
      paid: paid || { status: false },
      balance,
      metadata,
    });

    flushInvoices();

    res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      invoice,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* GET / READ (cached) — ALL FIXED WITH .lean()                       */
/* ------------------------------------------------------------------ */

// Get all invoices
router.get(
  "/get-all-invoices",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const cacheKey = CACHE_KEYS.all();
    let invoices = invoiceCache.get(cacheKey);
    let cacheHit = false;

    if (invoices === undefined) {
      invoices = await Invoice.find().sort({ createdAt: -1 }).lean(); // ← .lean()
      invoiceCache.set(cacheKey, invoices);
    } else {
      cacheHit = true;
    }

    res.status(200).json({
      success: true,
      cached: cacheHit,
      invoices,
    });
  }),
);

// Get single invoice by ID
router.get(
  "/get-invoice/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const cacheKey = CACHE_KEYS.single(req.params.id);
    let invoice = invoiceCache.get(cacheKey);
    let cacheHit = false;

    if (invoice === undefined) {
      invoice = await Invoice.findById(req.params.id).lean(); // ← .lean()
      if (!invoice) {
        return next(new ErrorHandler("Invoice not found", 404));
      }
      invoiceCache.set(cacheKey, invoice);
    } else {
      cacheHit = true;
    }

    res.status(200).json({
      success: true,
      cached: cacheHit,
      invoice,
    });
  }),
);

// Get specific user's invoices
router.get(
  "/get-user-invoices/:userId",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const cacheKey = CACHE_KEYS.byUser(req.params.userId);
    let invoices = invoiceCache.get(cacheKey);
    let cacheHit = false;

    if (invoices === undefined) {
      invoices = await Invoice.find({ userId: req.params.userId })
        .sort({ createdAt: -1 })
        .lean(); // ← .lean()
      if (!invoices || invoices.length === 0) {
        return next(new ErrorHandler("No invoices found for this user", 404));
      }
      invoiceCache.set(cacheKey, invoices);
    } else {
      cacheHit = true;
    }

    res.status(200).json({
      success: true,
      cached: cacheHit,
      invoices,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* UPDATE                                                             */
/* ------------------------------------------------------------------ */

// Update invoice
router.put(
  "/update-invoice/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    let invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return next(new ErrorHandler("Invoice not found", 404));
    }

    const { receiptNo, amount, purpose, balance, type, paid } = req.body;

    if (receiptNo !== undefined) invoice.receiptNo = receiptNo;
    if (amount !== undefined) invoice.amount = amount;
    if (purpose !== undefined) invoice.purpose = purpose;
    if (balance !== undefined) invoice.balance = balance;
    if (type !== undefined) invoice.type = type;

    if (paid !== undefined) {
      if (paid.status !== invoice.paid.status) {
        invoice.paid.status = paid.status;
        if (paid.status === true) {
          invoice.paid.paidAt = new Date();
        } else {
          invoice.paid.paidAt = undefined;
        }
      }
    }

    await invoice.save();
    flushInvoices();

    res.status(200).json({
      success: true,
      message: "Invoice updated successfully",
      invoice,
    });
  }),
);

// Mark invoice as paid
router.put(
  "/mark-invoice-paid/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return next(new ErrorHandler("Invoice not found", 404));
    }

    invoice.paid.status = true;
    invoice.paid.paidAt = new Date();

    await invoice.save();
    flushInvoices();

    res.status(200).json({
      success: true,
      message: "Invoice marked as paid",
      invoice,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* DELETE                                                             */
/* ------------------------------------------------------------------ */

// Delete invoice
router.delete(
  "/delete-invoice/:id",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return next(new ErrorHandler("Invoice not found", 404));
    }

    await Invoice.findByIdAndDelete(req.params.id); // ← cleaner
    flushInvoices();

    res.status(200).json({
      success: true,
      message: "Invoice deleted successfully",
    });
  }),
);

module.exports = router;
