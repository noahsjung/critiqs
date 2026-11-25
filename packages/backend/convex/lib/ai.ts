import { aiDeploymentFromEnv, type AiDeployment } from "@critiqs/server";

/** This deployment's AI, from its environment: Critiqs-managed AI, a default provider, the key that encrypts owners' keys, and allowed endpoints. */
export function deployment(): AiDeployment {
  return aiDeploymentFromEnv(process.env);
}
