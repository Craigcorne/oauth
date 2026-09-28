const express = require("express");
const axios = require("axios");
const { isAuthenticated } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const Transaction = require("../models/transaction");
const ErrorHandler = require("../utils/ErrorHandler");

router.post(
  "/stk",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { phone } = req.body;
    const amount = 1;

    const accountReference = "DefaultAccount";
    const transactionDesc = "Payment Description";

    // Required fields
    if (!amount || !phone) {
      return next(new ErrorHandler("Amount and phone are required", 400));
    }

    // Validate amount
    if (typeof amount !== "number" || amount <= 0) {
      return next(new ErrorHandler("Amount must be a positive number", 400));
    }

    // Validate phone format (Kenyan M-Pesa)
    const phoneRegex = /^(0|\+?254)[17]\d{8}$/;
    if (!phoneRegex.test(phone)) {
      return next(new ErrorHandler("Invalid phone number format", 400));
    }
    const cash = Math.ceil(amount);
    const callbackUrl = process.env.callbackUrl || undefined;

    // 3. Validate numeric and range (1 – 250,000)
    if (isNaN(cash) || cash < 1 || cash > 250000) {
      return next(
        new ErrorHandler("Amount must be between 1 and 250,000", 400),
      );
    }

    const encodedAuth = process.env.api_key;

    // Call PalPluss API
    const { data: paymentData } = await axios.post(
      "https://api.palpluss.com/v1/payments/stk",
      {
        amount: cash,
        phone,
        accountReference,
        transactionDesc:
          transactionDesc?.trim() || `Payment for ${accountReference}`,
        channelId: process.env.channelId,
        callbackUrl: callbackUrl || undefined,
      },
      {
        headers: {
          Authorization: `Basic ${encodedAuth}`,
          "Content-Type": "application/json",
        },
      },
    );

    res.status(201).json({
      success: true,
      message: "STK push initiated successfully",
      payment: paymentData,
    });
  }),
);

router.post("/callback", async (req, res) => {
  const FINAL_SUCCESS = ["SUCCESS", "COMPLETED"];

  const tx = req.body?.transaction;

  if (!tx?.id || !tx?.status) {
    return res.status(400).json({ message: "Invalid callback payload" });
  }

  const isSuccess =
    String(tx.result_code) === "0" || FINAL_SUCCESS.includes(tx.status);

  const update = {
    customer_number: tx.phone_number,
    mpesa_ref: tx.mpesa_receipt || null,
    amount: tx.amount,
    resultId: tx.provider_checkout_id,
    type: "deposit",
    status: tx.status,
    result_code: String(tx.result_code ?? ""),
    result_desc: tx.result_desc || "",
  };

  try {
    // Only touch a document that is not already a final SUCCESS.
    // If it is, the filter won't match, the upsert tries an insert,
    // and the unique index on transactionId rejects it (code 11000).
    const saved = await Transaction.findOneAndUpdate(
      { transactionId: tx.id, status: { $nin: FINAL_SUCCESS } },
      { $set: update, $setOnInsert: { transactionId: tx.id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    console.log(
      isSuccess ? "Payment succeeded:" : "Payment failed:",
      saved.transactionId,
      tx.result_desc,
    );

    return res.status(200).json({ message: "Callback processed successfully" });
  } catch (err) {
    // Already stored as SUCCESS: a harmless duplicate or late callback
    if (err.code === 11000) {
      console.log("Duplicate callback ignored:", tx.id);
      return res.status(200).json({ message: "Callback already processed" });
    }

    console.error("Callback error:", err.message);
    // 500 lets the provider retry
    return res.status(500).json({
      message: "Callback processed with error",
      error: err.message,
    });
  }
});

// fetch transaction by resultId

router.get(
  "/:resultId",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { resultId } = req.params;

    const encodedAuth = process.env.api_key;

    const response = await axios.get(
      `https://api.palpluss.com/v1/transactions/${encodeURIComponent(resultId)}`,
      {
        headers: {
          Authorization: `Basic ${encodedAuth}`,
          "Content-Type": "application/json",
        },
      },
    );

    res.status(200).json({
      success: true,
      data: response.data,
    });
  }),
);
module.exports = router;
