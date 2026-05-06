require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    arc_testnet: {
      url: "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: [process.env.PRIVATE_KEY],
    },
    litvm: {
      url: "https://liteforge.rpc.caldera.xyz/http",
      chainId: 4441,
      accounts: [process.env.PRIVATE_KEY],
      gasPrice: "auto",
    }
  }
};
