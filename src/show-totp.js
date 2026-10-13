// Prints the current code so it can be compared with the authenticator app.
import { loadTotpSecret } from "./secret-store.js";
import { generateTotp, totpSecondsRemaining } from "./totp.js";

const secret = loadTotpSecret();
if (!secret) {
  console.error("ERROR: No TOTP secret is stored. Run: npm run totp:set");
  process.exit(1);
}

console.log(
  JSON.stringify({ code: generateTotp(secret), validForSeconds: totpSecondsRemaining(secret) }, null, 2)
);
