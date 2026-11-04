#!/usr/bin/env node
/**
 * Generate an encrypted project wallet in the keystore and print its public key.
 *
 *   TENFOLD_KEYSTORE_PASSWORD=... npm run wallet:new -- --label mytoken
 *
 * The founder deposits tokens and SOL to the printed address. The secret key is only ever read by the
 * engine process (signer); the Telegram agent cannot access the keystore.
 */
import { loadEnv } from "@tenfold/core";
import { createWallet } from "@tenfold/exec";

const env = loadEnv();
if (!env.keystorePassword) {
  console.error("TENFOLD_KEYSTORE_PASSWORD is required");
  process.exit(1);
}
const i = process.argv.indexOf("--label");
const label = i >= 0 ? process.argv[i + 1] : "project";
const pubkey = createWallet(env.keystoreDir, env.keystorePassword, label);
console.log(pubkey);
