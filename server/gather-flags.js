import { hostOnlyMode } from "./host-model.js";
import { firebaseEnabled } from "./firebase-auth.js";
export const GATHER_ORIGIN = "https://gather.ilymmd.com";
export const passwordlessEnabled = (env) =>
  !hostOnlyMode(env) &&
  (firebaseEnabled(env) ||
    (env.PASSWORDLESS_ENABLED === "true" &&
      env.PASSWORDLESS_ACTIVATION_APPROVED === "true"));
export const universalEnabled = (env) =>
  hostOnlyMode(env) ||
  (passwordlessEnabled(env) && env.GATHER_UNIVERSAL_ENABLED === "true");
export const universalRoutingEnabled = (env) =>
  universalEnabled(env) && env.GATHER_DOMAIN_APPROVED === "true";

export const authSmsEnabled = (env) =>
  passwordlessEnabled(env) && env.AUTH_SMS_ENABLED === "true";
