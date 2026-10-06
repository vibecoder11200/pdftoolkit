import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import asn1js from 'asn1js';
import pkijs from 'pkijs';
import { PDFDocument } from 'pdf-lib';
import {
  CertBadPasswordError,
  CertInvalidError,
  inspectCertificateKey,
  signWithCertificate,
} from '../src/engine/p12';

/*
 * Real-cert signing (phase 5). These run the worker module DIRECTLY — Node 24
 * ships the same WebCrypto primitives the browser uses (importKey pkcs8/spki,
 * RSASSA-PKCS1-v1_5, ECDSA, digest), so the assertions carry over. Fixtures
 * are openssl-generated at gen-time (tests/fixtures/gen.mjs); the suite
 * self-skips when openssl was unavailable.
 */
const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const hasFixtures = ['cert-rsa', 'cert-ec', 'cert-chain'].every((n) => {
  try {
    readFileSync(fx(`fixture-${n}.p12`));
    return true;
  } catch {
    return false;
  }
});
const d = hasFixtures ? describe : describe.skip;
const PASSWORD = 'cert-pass';

d('inspectCertificateKey', () => {
  it('reads the RSA leaf: CN, issuer, self-signed, key type/size', async () => {
    const info = await inspectCertificateKey(readFileSync(fx('fixture-cert-rsa.p12')), PASSWORD);
    expect(info.cn).toBe('cert-rsa Test');
    expect(info.issuerCn).toBe('cert-rsa Test'); // self-signed: issuer == subject
    expect(info.selfSigned).toBe(true);
    expect(info.missingIntermediate).toBe(false);
    expect(info.keyType).toBe('RSA');
    expect(info.keyBits).toBe(2048);
    expect(info.notAfterMs).toBeGreaterThan(Date.now());
    expect(info.notBeforeMs).toBeLessThan(Date.now());
  });

  it('reads the EC leaf as P-256 ECDSA', async () => {
    const info = await inspectCertificateKey(readFileSync(fx('fixture-cert-ec.p12')), PASSWORD);
    expect(info.keyType).toBe('EC');
    expect(info.keyBits).toBe(256);
    expect(info.selfSigned).toBe(true);
  });

  it('chain bundle: leaf issuer is the intermediate, chain complete', async () => {
    const info = await inspectCertificateKey(readFileSync(fx('fixture-cert-chain.p12')), PASSWORD);
    expect(info.cn).toBe('cert-chain Chained Leaf');
    expect(info.issuerCn).toBe('cert-chain Intermediate');
    expect(info.selfSigned).toBe(false);
    expect(info.missingIntermediate).toBe(false);
  });
});

d('wrong password / corrupt file (comlink-visible branches)', () => {
  it('wrong password → CertBadPassword (retryable), NOT a parse error', async () => {
    const err = (await inspectCertificateKey(readFileSync(fx('fixture-cert-rsa.p12')), 'WRONG').catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(CertBadPasswordError);
    expect(err.name).toBe('CertBadPassword'); // UI maps by name, never message
  });

  it('garbage bytes → CertInvalid', async () => {
    const err = (await inspectCertificateKey(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), PASSWORD).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(CertInvalidError);
    expect(err.name).toBe('CertInvalid');
  });
});

// ---- independent verification (asn1js positional parse, no builder reuse) ----

// asn1js's TS types are too narrow for positional CMS walking — a structural
// cast keeps the reader readable without fighting the union types.
const kids = (b: asn1js.BaseBlock): asn1js.BaseBlock[] =>
  (b.valueBlock as unknown as { value: asn1js.BaseBlock[] }).value;
const valueHex = (b: asn1js.BaseBlock): ArrayBuffer =>
  (b.valueBlock as unknown as { valueHex: ArrayBuffer }).valueHex;

function derToEcdsaRaw(der: Uint8Array, size: number): Uint8Array {
  const [r, s] = kids(asn1js.fromBER(der).result).map((v) => new Uint8Array(valueHex(v)));
  const pad = (b: Uint8Array) =>
    Uint8Array.from({ length: size }, (_, i) => (i < size - b.length ? 0 : b[i - (size - b.length)]));
  const out = new Uint8Array(size * 2);
  out.set(pad(r), 0);
  out.set(pad(s), size);
  return out;
}

async function verifySigned(signedBytes: Uint8Array, expectedCerts: number, keyType: 'RSA' | 'EC') {
  const pdf = Buffer.from(signedBytes).toString('latin1');
  // 1. pdf-lib reloads without complaint
  const doc = await PDFDocument.load(signedBytes);
  expect(doc.getPageCount()).toBeGreaterThan(0);
  // 2. positional CMS extraction — the SIG dict is the only place /Contents
  // follows /ByteRange (page dicts also have /Contents refs).
  const brPos = pdf.indexOf('/ByteRange');
  const phPos = pdf.indexOf('/Contents ', brPos);
  const hexStart = pdf.indexOf('<', phPos) + 1;
  const hexEnd = pdf.indexOf('>', hexStart);
  const fullHex = pdf.slice(hexStart, hexEnd);
  const lenByte = parseInt(fullHex.slice(2, 4), 16);
  const derLen =
    lenByte < 0x80
      ? 2 + lenByte
      : 2 + (lenByte & 0x7f) + parseInt(fullHex.slice(4, 4 + 2 * (lenByte & 0x7f)), 16);
  const cms = new Uint8Array(
    (fullHex.slice(0, derLen * 2).match(/../g) ?? []).map((h) => parseInt(h, 16)),
  );
  // ContentInfo[contentType, [0] SignedData[ver, digests, encap, [0] certs, signerInfos]]
  const signedData = kids(kids(asn1js.fromBER(cms).result)[1])[0];
  const [, , , certsTag, signerInfos] = kids(signedData);
  const signerInfo = kids(signerInfos)[0];
  const sigAttrs = kids(kids(signerInfo)[3]);
  // 3. embedded cert count (chain → all bundled certs present)
  expect(kids(certsTag).length).toBe(expectedCerts);
  // 4. messageDigest attr == SHA-256 over the ByteRange spans
  const md = sigAttrs.find((a) => kids(a)[0].valueBlock.toString() === '1.2.840.113549.1.9.4')!;
  const claimed = new Uint8Array(valueHex(kids(kids(md)[1])[0]));
  const [, , len1, offset2, len2] = Array.from(
    pdf.match(/\/ByteRange \[\s*(\d+) (\d+) (\d+) (\d+)\s*\]/)!,
    Number,
  );
  const spanned = new Uint8Array(len1 + len2);
  spanned.set(signedBytes.slice(0, len1), 0);
  spanned.set(signedBytes.slice(offset2), len1);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spanned));
  expect(Buffer.from(claimed).equals(Buffer.from(digest))).toBe(true);
  // 5. signature verifies with the embedded leaf's public key
  const leafDer = new Uint8Array(kids(certsTag)[0].toBER(false));
  const cert = new pkijs.Certificate({ schema: asn1js.fromBER(leafDer).result });
  const isEc = keyType === 'EC';
  const importAlg = isEc
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const verifyAlg = isEc
    ? { name: 'ECDSA', hash: 'SHA-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const pub = await crypto.subtle.importKey(
    'spki',
    new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false)),
    importAlg,
    true,
    ['verify'],
  );
  const attrsDer = new Uint8Array(new asn1js.Set({ value: sigAttrs }).toBER(false));
  const sigBytes = new Uint8Array(valueHex(kids(signerInfo)[5]));
  const ok = await crypto.subtle.verify(
    verifyAlg,
    pub,
    isEc ? derToEcdsaRaw(sigBytes, 32) : sigBytes,
    attrsDer,
  );
  expect(ok).toBe(true);
}

d('signWithCertificate end-to-end (independent re-verify)', () => {
  const pdfBytes = new Uint8Array(readFileSync(fx('fixture-1mb.pdf')));

  it('RSA: signs, re-loads, digest matches, signature verifies, 1 cert embedded', async () => {
    const out = await signWithCertificate(pdfBytes, readFileSync(fx('fixture-cert-rsa.p12')), PASSWORD);
    await verifySigned(out, 1, 'RSA');
  });

  it('EC P-256: signs and verifies (DER ↔ raw conversion)', async () => {
    const out = await signWithCertificate(pdfBytes, readFileSync(fx('fixture-cert-ec.p12')), PASSWORD);
    await verifySigned(out, 1, 'EC');
  });

  it('chain: all 3 bundled certs embedded in [0] certificates', async () => {
    const out = await signWithCertificate(pdfBytes, readFileSync(fx('fixture-cert-chain.p12')), PASSWORD);
    await verifySigned(out, 3, 'RSA');
  });

  it('second signature on a signed file → CertAlreadySigned (one sig per file)', async () => {
    const once = await signWithCertificate(pdfBytes, readFileSync(fx('fixture-cert-rsa.p12')), PASSWORD);
    const err = (await signWithCertificate(once, readFileSync(fx('fixture-cert-rsa.p12')), PASSWORD).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.name).toBe('CertAlreadySigned');
  });

  it('wrong password at sign time → CertBadPassword (same branch as inspect)', async () => {
    const err = (await signWithCertificate(pdfBytes, readFileSync(fx('fixture-cert-rsa.p12')), 'NOPE').catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(CertBadPasswordError);
  });
});
