exports.success = (res, data) => {
  res.json({
    success: true,

    data,
  });
};
