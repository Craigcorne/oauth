// utils/cache.js
const NodeCache = require("node-cache"); // or Redis client
const cache = new NodeCache({ stdTTL: 600 }); // 10 min default

const getCache = (key) => cache.get(key);
const setCache = (key, value, ttl = 600) => cache.set(key, value, ttl);
const delCache = (key) => cache.del(key);
const flushPattern = (pattern) => {
  const keys = cache.keys();
  keys.forEach((k) => {
    if (k.includes(pattern)) cache.del(k);
  });
};

module.exports = { getCache, setCache, delCache, flushPattern };
