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
  const stkCallbackResponse = req.body.response;

  successfulCallbackData = stkCallbackResponse;

  console.log("Received STK callback:", req.body);

  const code = stkCallbackResponse.ResultCode;
  const resultId = stkCallbackResponse.CheckoutRequestID;
  const amount = stkCallbackResponse.ExternalReference;
  const ref = stkCallbackResponse.MpesaReceiptNumber;
  const phone = stkCallbackResponse.Phone;

  try {
    if (code === 0) {
      const transaction = new Transaction();
      transaction.customer_number = phone;
      transaction.mpesa_ref = ref;
      transaction.amount = amount;
      transaction.resultId = resultId;
      transaction.type = "deposit";

      const savedTransaction = await transaction.save();

      console.log({
        message: "Transaction saved successfully",
        data: savedTransaction,
      });
    }

    return res.json({
      message: "Callback processed successfully",
    });
  } catch (err) {
    console.error(err.message);
    return res.json({
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
    console.log("result", resultId);

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
