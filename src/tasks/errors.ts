import { NomicLabsHardhatPluginError } from "hardhat/plugins";

import { PLUGIN_NAME } from "../internal/constants";

export class HardhatZKitError extends NomicLabsHardhatPluginError {
  constructor(message: string, parent?: Error) {
    super(PLUGIN_NAME, message, parent);
  }
}
