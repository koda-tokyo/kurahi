// XML-DSig verification for SAML (enveloped signatures only), node:crypto + c14n.ts.
//
// The profile is deliberately narrow; anything else is refused:
//   - the ds:Signature is a direct child of the element it signs, and SignedInfo holds exactly
//     one Reference whose URI is "#" + that element's ID attribute;
//   - Transforms are exactly enveloped-signature then exc-c14n (optionally with an
//     InclusiveNamespaces PrefixList); SignedInfo is canonicalised with exc-c14n;
//   - SignatureMethod rsa-sha256 / rsa-sha512 / ecdsa-sha256, DigestMethod sha256 / sha512
//     (SHA-1 is refused);
//   - the verifying key is one of the configured IdP certificates; KeyInfo in the message is
//     never used to choose or build a key.
// Wrapping defence lives in sp.ts (one assertion, unique IDs, values read only from the element
// whose signature was verified); this module answers "is THIS element signed by THAT key".
import { createHash, type KeyObject, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { canonicalizeExclusive } from "./c14n.js";
import { attr, childElements, onlyChild, textOf, type XmlElement } from "./xml.js";

export const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
export const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
export const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

const SIG_ALGS: Record<string, { hash: string; ec: boolean }> = {
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": { hash: "sha256", ec: false },
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": { hash: "sha512", ec: false },
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256": { hash: "sha256", ec: true },
};
const DIGEST_ALGS: Record<string, string> = {
  "http://www.w3.org/2001/04/xmlenc#sha256": "sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512": "sha512",
};

export type SignatureFailure =
  | "unsigned"
  | "signature_malformed"
  | "unsupported_algorithm"
  | "reference_mismatch"
  | "digest_mismatch"
  | "bad_signature";

export class SignatureError extends Error {
  constructor(readonly reason: SignatureFailure) {
    super(`signature refused: ${reason}`);
    this.name = "SignatureError";
  }
}

const exc = (el: XmlElement, prefixes: string[] = [], omit?: XmlElement) =>
  canonicalizeExclusive(el, { inclusivePrefixes: prefixes, omit: omit ?? null });

function b64(text: string): Buffer {
  const compact = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new SignatureError("signature_malformed");
  }
  return Buffer.from(compact, "base64");
}

function algorithmOf(el: XmlElement | null): string {
  const a = el ? attr(el, "Algorithm") : null;
  if (!a) {
    throw new SignatureError("signature_malformed");
  }
  return a;
}

function prefixList(transform: XmlElement): string[] {
  const inc = childElements(transform, EXC_C14N, "InclusiveNamespaces");
  if (inc.length > 1 || childElements(transform).length !== inc.length) {
    throw new SignatureError("signature_malformed");
  }
  const list = inc[0] ? (attr(inc[0], "PrefixList") ?? "") : "";
  return list.split(/\s+/).filter(Boolean);
}

/** The ds:Signature children of `el` (direct children only). */
export function signaturesOf(el: XmlElement): XmlElement[] {
  return childElements(el, DSIG_NS, "Signature");
}

/**
 * Verify that `signed` carries a valid enveloped signature by one of `keys`. Throws
 * SignatureError; returns the verified Signature element.
 */
export function verifyEnvelopedSignature(signed: XmlElement, keys: KeyObject[]): XmlElement {
  const sigs = signaturesOf(signed);
  if (sigs.length === 0) {
    throw new SignatureError("unsigned");
  }
  if (sigs.length > 1) {
    throw new SignatureError("signature_malformed");
  }
  const sig = sigs[0];
  const signedInfo = onlyChild(sig, DSIG_NS, "SignedInfo");
  const sigValueEl = onlyChild(sig, DSIG_NS, "SignatureValue");
  if (!signedInfo || !sigValueEl) {
    throw new SignatureError("signature_malformed");
  }
  const c14nMethod = onlyChild(signedInfo, DSIG_NS, "CanonicalizationMethod");
  if (!c14nMethod || algorithmOf(c14nMethod) !== EXC_C14N) {
    throw new SignatureError("unsupported_algorithm");
  }
  const sigAlg = SIG_ALGS[algorithmOf(onlyChild(signedInfo, DSIG_NS, "SignatureMethod"))];
  if (!sigAlg) {
    throw new SignatureError("unsupported_algorithm");
  }
  const refs = childElements(signedInfo, DSIG_NS, "Reference");
  if (refs.length !== 1) {
    throw new SignatureError("reference_mismatch");
  }
  const ref = refs[0];
  const id = attr(signed, "ID");
  if (!id || attr(ref, "URI") !== `#${id}`) {
    throw new SignatureError("reference_mismatch");
  }
  const transformsEl = onlyChild(ref, DSIG_NS, "Transforms");
  const transforms = transformsEl ? childElements(transformsEl) : [];
  if (
    transforms.length !== 2 ||
    transforms.some((t) => t.ns !== DSIG_NS || t.local !== "Transform") ||
    attr(transforms[0], "Algorithm") !== ENVELOPED ||
    attr(transforms[1], "Algorithm") !== EXC_C14N ||
    childElements(transforms[0]).length > 0
  ) {
    throw new SignatureError("unsupported_algorithm");
  }
  const digestAlg = DIGEST_ALGS[algorithmOf(onlyChild(ref, DSIG_NS, "DigestMethod"))];
  if (!digestAlg) {
    throw new SignatureError("unsupported_algorithm");
  }
  const digestEl = onlyChild(ref, DSIG_NS, "DigestValue");
  if (!digestEl) {
    throw new SignatureError("signature_malformed");
  }
  const expected = b64(textOf(digestEl));
  const actual = createHash(digestAlg)
    .update(exc(signed, prefixList(transforms[1]), sig), "utf8")
    .digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new SignatureError("digest_mismatch");
  }
  const signatureValue = b64(textOf(sigValueEl));
  const canonicalSignedInfo = Buffer.from(exc(signedInfo, prefixList(c14nMethod)), "utf8");
  for (const key of keys) {
    const isEc = key.asymmetricKeyType === "ec";
    if (isEc !== sigAlg.ec) {
      continue;
    }
    const ok = cryptoVerify(
      sigAlg.hash,
      canonicalSignedInfo,
      isEc ? { key, dsaEncoding: "ieee-p1363" } : key,
      signatureValue,
    );
    if (ok) {
      return sig;
    }
  }
  throw new SignatureError("bad_signature");
}
