require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    arc: {
      url: "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: [process.env.VERIFIER_PRIVATE_KEY],
    },
    litvm: {
      url: "https://liteforge.rpc.caldera.xyz/http",
      chainId: 4441,
      accounts: [process.env.VERIFIER_PRIVATE_KEY],
    },
  },
};
