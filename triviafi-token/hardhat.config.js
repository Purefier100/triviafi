require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC,
      chainId: 5042002,
      accounts: [process.env.ADMIN_PRIVATE_KEY],
    },
    litvmTestnet: {
      url: "https://liteforge.rpc.caldera.xyz/http",
      chainId: 4441,
      accounts: [process.env.ADMIN_PRIVATE_KEY],
    },
  },
};
