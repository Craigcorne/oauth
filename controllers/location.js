const express = require("express");
const router = express.Router();
const Location = require("../models/Location");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");

// ==================== COUNTRY ====================

router.post(
  "/create-country",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { name, code } = req.body;
    const country = await Location.create({ name, code });
    res.status(201).json({ success: true, data: country });
  }),
);

router.get(
  "/get-all-countries",
  catchAsyncErrors(async (req, res, next) => {
    const countries = await Location.find().sort({ name: 1 });
    res
      .status(200)
      .json({ success: true, count: countries.length, data: countries });
  }),
);

router.get(
  "/get-country/:countryId",
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));
    res.status(200).json({ success: true, data: country });
  }),
);

router.put(
  "/update-country/:countryId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findByIdAndUpdate(
      req.params.countryId,
      { name: req.body.name, code: req.body.code },
      { new: true, runValidators: true },
    );
    if (!country) return next(new ErrorHandler("Country not found", 404));
    res.status(200).json({ success: true, data: country });
  }),
);

router.delete(
  "/delete-country/:countryId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findByIdAndDelete(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));
    res
      .status(200)
      .json({ success: true, message: "Country deleted successfully" });
  }),
);

// ==================== COUNTY ====================

router.post(
  "/create-county/:countryId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    country.counties.push(req.body);
    await country.save();

    res
      .status(201)
      .json({
        success: true,
        data: country.counties[country.counties.length - 1],
      });
  }),
);

router.get(
  "/get-counties/:countryId",
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));
    res
      .status(200)
      .json({
        success: true,
        count: country.counties.length,
        data: country.counties,
      });
  }),
);

router.get(
  "/get-county/:countryId/:countyId",
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    res.status(200).json({ success: true, data: county });
  }),
);

router.put(
  "/update-county/:countryId/:countyId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    if (req.body.name) county.name = req.body.name;
    if (req.body.delivery) {
      county.delivery.express = {
        ...county.delivery.express,
        ...req.body.delivery.express,
      };
      county.delivery.standard = {
        ...county.delivery.standard,
        ...req.body.delivery.standard,
      };
    }

    await country.save();
    res.status(200).json({ success: true, data: county });
  }),
);

router.delete(
  "/delete-county/:countryId/:countyId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    county.deleteOne();
    await country.save();

    res
      .status(200)
      .json({ success: true, message: "County deleted successfully" });
  }),
);

// ==================== TOWN ====================

router.post(
  "/create-town/:countryId/:countyId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    county.towns.push(req.body);
    await country.save();

    res
      .status(201)
      .json({ success: true, data: county.towns[county.towns.length - 1] });
  }),
);

router.get(
  "/get-towns/:countryId/:countyId",
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    res
      .status(200)
      .json({ success: true, count: county.towns.length, data: county.towns });
  }),
);

router.get(
  "/get-town/:countryId/:countyId/:townId",
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    const town = county.towns.id(req.params.townId);
    if (!town) return next(new ErrorHandler("Town not found", 404));

    res.status(200).json({ success: true, data: town });
  }),
);

router.put(
  "/update-town/:countryId/:countyId/:townId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    const town = county.towns.id(req.params.townId);
    if (!town) return next(new ErrorHandler("Town not found", 404));

    if (req.body.name) town.name = req.body.name;
    if (req.body.delivery) {
      town.delivery.express = {
        ...town.delivery.express,
        ...req.body.delivery.express,
      };
      town.delivery.standard = {
        ...town.delivery.standard,
        ...req.body.delivery.standard,
      };
    }

    await country.save();
    res.status(200).json({ success: true, data: town });
  }),
);

router.delete(
  "/delete-town/:countryId/:countyId/:townId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    const town = county.towns.id(req.params.townId);
    if (!town) return next(new ErrorHandler("Town not found", 404));

    town.deleteOne();
    await country.save();

    res
      .status(200)
      .json({ success: true, message: "Town deleted successfully" });
  }),
);

// ==================== DELIVERY ====================

router.put(
  "/update-county-delivery/:countryId/:countyId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    if (req.body.express)
      county.delivery.express = {
        ...county.delivery.express,
        ...req.body.express,
      };
    if (req.body.standard)
      county.delivery.standard = {
        ...county.delivery.standard,
        ...req.body.standard,
      };

    await country.save();
    res.status(200).json({ success: true, data: county.delivery });
  }),
);

router.put(
  "/update-town-delivery/:countryId/:countyId/:townId",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const country = await Location.findById(req.params.countryId);
    if (!country) return next(new ErrorHandler("Country not found", 404));

    const county = country.counties.id(req.params.countyId);
    if (!county) return next(new ErrorHandler("County not found", 404));

    const town = county.towns.id(req.params.townId);
    if (!town) return next(new ErrorHandler("Town not found", 404));

    if (req.body.express)
      town.delivery.express = { ...town.delivery.express, ...req.body.express };
    if (req.body.standard)
      town.delivery.standard = {
        ...town.delivery.standard,
        ...req.body.standard,
      };

    await country.save();
    res.status(200).json({ success: true, data: town.delivery });
  }),
);

module.exports = router;
