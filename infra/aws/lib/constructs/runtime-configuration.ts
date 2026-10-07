import { CfnParameter } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  CONFIGURATION_KEYS, CONFIGURATION_PARAMETER_NAMES, type RuntimeConfigurationKey,
} from "../runtime-environment";

export class RuntimeConfiguration extends Construct {
  private readonly parameters = new Map<RuntimeConfigurationKey, CfnParameter>();

  constructor(scope: Construct, constructId: string) {
    super(scope, constructId);
    for (const name of CONFIGURATION_KEYS) {
      const logicalId = CONFIGURATION_PARAMETER_NAMES[name];
      const parameter = new CfnParameter(this, logicalId, {
        type: "String", default: "", description: "Non-secret runtime setting: " + name,
      });
      parameter.overrideLogicalId(logicalId);
      this.parameters.set(name, parameter);
    }
  }

  getEnvironment(keys: readonly RuntimeConfigurationKey[]): { name: string; value: string }[] {
    return keys.map((name) => {
      const parameter = this.parameters.get(name);
      if (!parameter) throw new Error("Missing runtime parameter: " + name);
      return { name, value: parameter.valueAsString };
    });
  }
}
