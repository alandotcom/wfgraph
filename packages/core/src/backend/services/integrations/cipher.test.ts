import { describe, expect, it } from "vitest";
import {
  assertValidEncryptionKey,
  createIntegrationCipher,
  EncryptionKeyMismatch,
} from "#src/backend/services/integrations/cipher";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

const cipher = createIntegrationCipher({ key: KEY });

/** The three fields of a sealed envelope, for a case that damages one of them. */
function envelope(config: Record<string, string>): [string, string, string] {
  const [iv, authTag, ciphertext] = cipher.seal(config).split(":");
  return [iv, authTag, ciphertext];
}

// An absent key sends the reader to their secret store and a malformed one to the
// value they already have, so the two are told apart rather than merged.
describe("assertValidEncryptionKey", () => {
  it("names an unset key apart from a wrong-length one", () => {
    expect(() => assertValidEncryptionKey(undefined)).toThrow("is unset");
    expect(() => assertValidEncryptionKey("   ")).toThrow("is unset");
    expect(() => assertValidEncryptionKey("abc123")).toThrow(
      "64-character hex string"
    );
  });
});

describe("sealing and opening a config", () => {
  it("gives back what was sealed", () => {
    const config = { API_KEY: "secret", ACCOUNT_SID: "AC123" };

    expect(cipher.open(cipher.seal(config))).toEqual(config);
  });

  // The IV is fresh per seal, so two rows holding one credential do not hold one
  // ciphertext for anybody reading the column.
  it("seals one config to a different envelope each time", () => {
    const config = { API_KEY: "secret" };

    expect(cipher.seal(config)).not.toBe(cipher.seal(config));
  });
});

// A row this key cannot parse is one connection the editor can still show and
// repair, so the read answers for it. A key that authenticates nothing is the
// whole process, and that is what the last two cases hold to a refusal.
describe("opening something this key cannot read", () => {
  it("answers an empty config for a column holding no envelope", () => {
    expect(cipher.open(null)).toEqual({});
    expect(cipher.open({ API_KEY: "never sealed" })).toEqual({});
    expect(cipher.open("not-an-envelope")).toEqual({});
    expect(cipher.open("zz:zz:zz")).toEqual({});
  });

  // Buffer.from truncates invalid hex rather than refusing it, so a short field
  // would otherwise reach the decipher and be reported as a key mismatch.
  it("answers an empty config for an envelope of the wrong shape", () => {
    const [iv, authTag, ciphertext] = envelope({ API_KEY: "secret" });

    expect(cipher.open(`${iv.slice(2)}:${authTag}:${ciphertext}`)).toEqual({});
    expect(cipher.open(`${iv}:${authTag.slice(2)}:${ciphertext}`)).toEqual({});
    expect(cipher.open(`${iv}:${authTag}:${ciphertext}:extra`)).toEqual({});
  });

  it("refuses an envelope another key sealed", () => {
    const sealed = createIntegrationCipher({ key: OTHER_KEY }).seal({
      API_KEY: "secret",
    });

    expect(() => cipher.open(sealed)).toThrow(EncryptionKeyMismatch);
    expect(() => cipher.open(sealed)).toThrow("encryption.key");
  });

  // Same key, altered ciphertext: GCM refuses it on the same tag check and the
  // read cannot tell the two apart. Refusing suits both, since a row nobody wrote
  // is not a row to show either.
  it("refuses an envelope whose ciphertext was altered", () => {
    const [iv, authTag, ciphertext] = envelope({ API_KEY: "secret" });
    const altered = ciphertext.startsWith("0")
      ? `1${ciphertext.slice(1)}`
      : `0${ciphertext.slice(1)}`;

    expect(() => cipher.open(`${iv}:${authTag}:${altered}`)).toThrow(
      EncryptionKeyMismatch
    );
  });
});
