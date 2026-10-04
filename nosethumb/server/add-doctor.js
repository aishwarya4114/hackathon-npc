// Creates (or updates) a doctor account.
// Usage: npm run add-doctor -- doctor@example.com "a password you choose"
// Accounts are stored in doctors.json with a hashed password, never the password itself.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { hashPassword } from "./passwords.js";

const DOCTORS_FILE = process.env.DOCTORS_FILE ?? new URL("./doctors.json", import.meta.url);

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run add-doctor -- doctor@example.com "a password you choose"');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Use a password of at least 8 characters.");
  process.exit(1);
}

const doctors = existsSync(DOCTORS_FILE) ? JSON.parse(readFileSync(DOCTORS_FILE, "utf8")) : {};
doctors[email.toLowerCase()] = { passwordHash: hashPassword(password) };
writeFileSync(DOCTORS_FILE, JSON.stringify(doctors, null, 2) + "\n");

console.log(`Saved doctor account for ${email.toLowerCase()}.`);
