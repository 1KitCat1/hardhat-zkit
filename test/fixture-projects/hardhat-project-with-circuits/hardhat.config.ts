import { HardhatUserConfig } from "hardhat/config";

import config from "../hardhat.config";

const defaultConfig: HardhatUserConfig = {
  ...config,
  zkit: {
    circuitsDir: "circuits",
    compilationSettings: {
      artifactsDir: "zkit/artifacts",
      skipFiles: ["vendor"],
      quiet: true,
    },
    verifiersDir: "contracts/verifiers",
    ptauDir: "zkit/ptau",
    ptauDownload: true,
  },
};

export default defaultConfig;
