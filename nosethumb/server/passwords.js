// Password hashing with Node's built-in scrypt. We never store the password itself,
// only a random "salt" and the scrambled result. To check a login, we scramble the
// typed password with the same salt and compare.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

// Returns "salt:hash" (both hex), safe to store in a file.
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

// True if `password` matches a stored "salt:hash".
export function checkPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, KEY_LENGTH);
  // timingSafeEqual takes the same time whether or not the first bytes match,
  // so an attacker can't guess the hash by measuring response times.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
