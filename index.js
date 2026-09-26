const express = require("express");
require("dotenv").config();
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const passport = require("passport");
const ErrorHandler = require("./middleware/error");
const cloudinary = require("cloudinary");
const user = require("./controllers/user");
const category = require("./controllers/category");
const coupon = require("./controllers/coupon");
const product = require("./controllers/product");
const wishlist = require("./controllers/wishlist");
const invoice = require("./controllers/invoice");
const review = require("./controllers/review");
const qrCode = require("./controllers/admin");
const analytics = require("./controllers/analytics");
const color = require("./routes/color");
const location = require("./controllers/location");
const collection = require("./controllers/collections");
const transaction = require("./controllers/transactions");
const order = require("./controllers/order");
const mongoose = require("mongoose");
const connectDatabase = require("./config/db");
const app = express();

require("./config/passport");
const port = 5000;

connectDatabase();

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  }),
);
// app.use(cors());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(cookieParser());

app.use(passport.initialize());

//config cloundinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Log every request (temporary debugging)
// app.use((req, res, next) => {
//   console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
//   next();
// });

// Routes AFTER middleware
app.use("/api/v2/user", user);
app.use("/api/v2/categories", category);
app.use("/api/v2/product", product);
app.use("/api/v2/coupon", coupon);
app.use("/api/v2/color", color);
app.use("/api/v2/wishlist", wishlist);
app.use("/api/v2/location", location);
app.use("/api/v2/order", order);
app.use("/api/v2/invoice", invoice);
app.use("/api/v2/review", review);
app.use("/api/v2/qrcode", qrCode);
app.use("/api/v2/analytics", analytics);
app.use("/api/v2/collections", collection);
app.use("/api/v2/transaction", transaction);

app.use(ErrorHandler);

app.listen(port, () => console.log(`Example app listening on port ${port}!`));
