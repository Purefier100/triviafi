const { ethers } = require("ethers");

module.exports = async function verifyWallet(req, res, next) {
  const { wallet, message, signature } = req.body;
  if (!wallet || !message || !signature) return next();
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() === wallet.toLowerCase()) {
      req.verifiedWallet = wallet.toLowerCase();
    }
  } catch (_) {}
  next();
};
