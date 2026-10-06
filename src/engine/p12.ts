/*
 * Real-certificate signing (plan v0.3.0 phase 5). Parses a PKCS#12 bundle
 * (pkijs — already shipped in the lazy signer chunk via js-pdf-signer),
 * attaches a signature placeholder sized from the parsed content, splices
 * the ByteRange hole and builds the CMS — all inside the worker: the private
 * key NEVER leaves this module.
 *
 * Why not js-pdf-signer's cms.js: it derives SignerInfo sid from cert.SUBJECT
 * (correct only for self-signed) and hardcodes RSA — real CA certs break on
 * both (SPIKE 2026-10-06, findings #1). This builder fixes the issuer and
 * supports RSA (RSASSA-PKCS1-v1_5) and EC (ECDSA, raw r‖s → DER for CMS).
 */
// Namespace imports: asn1js/pkijs ESM builds ship named exports only.
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/** Wrong password (PKCS#12 MAC failure) — keep the file, wipe password, retry. */
export class CertBadPasswordError extends Error {
  constructor() {
    super('PKCS#12 MAC verification failed (wrong password?)');
    this.name = 'CertBadPassword';
  }
}

/** Not a P12 at all (ASN.1 garbage, truncated, not the right container). */
export class CertInvalidError extends Error {
  constructor(detail = '') {
    super(`not a valid PKCS#12 bundle ${detail}`.trim());
    this.name = 'CertInvalid';
  }
}

export interface CertKeyInfo {
  /** Leaf certificate common name. */
  cn: string;
  issuerCn: string;
  notBeforeMs: number;
  notAfterMs: number;
  /** Leaf issuer == leaf subject. */
  selfSigned: boolean;
  /** Leaf issuer matches no other embedded subject — chain incomplete. */
  missingIntermediate: boolean;
  keyType: 'RSA' | 'EC';
  keyBits: number;
}

const OID_RSA = '1.2.840.113549.1.1.1';
const OID_EC = '1.2.840.10045.2.1';
const OID_EC_P256 = '1.2.840.10045.3.1.7';
const OID_EC_P384 = '1.3.132.0.34';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const OID_KEY_BAG = '1.2.840.113549.1.12.10.1.2';

const utf8 = new TextEncoder();

function cnOf(name: pkijs.RelativeDistinguishedNames): string {
  const cn = name.typesAndValues.find((tv) => tv.type === '2.5.4.3');
  return cn ? cn.value.valueBlock.value : '';
}

async function parseBags(p12Bytes: Uint8Array, password: Uint8Array) {
  let schema: asn1js.BaseBlock;
  try {
    // Garbage fails HERE (or in the PFX schema check below) — that is the
    // "file invalid" branch, distinct from the MAC failure under parse().
    schema = asn1js.fromBER(p12Bytes).result;
    new pkijs.PFX({ schema });
  } catch {
    throw new CertInvalidError('(ASN.1 parse failed)');
  }
  const pfx = new pkijs.PFX({ schema });
  try {
    // checkIntegrity verifies the MAC with the password — the canonical
    // wrong-password signal (a corrupt file fails earlier, in fromBER).
    await pfx.parseInternalValues({ password, checkIntegrity: true });
  } catch (e) {
    if (e instanceof Error && /integrity/i.test(e.message)) throw new CertBadPasswordError();
    throw new CertInvalidError(e instanceof Error ? `(${e.message})` : '');
  }
  const certs: pkijs.Certificate[] = [];
  let pkcs8: Uint8Array | null = null;
  // parseInternalValues always populates parsedValue or throws above.
  const parsed = pfx.parsedValue as { authenticatedSafe: pkijs.AuthenticatedSafe };
  for (const content of parsed.authenticatedSafe.safeContents) {
    let safeContents: pkijs.SafeContents;
    if (content.contentType === OID_ENCRYPTED_DATA) {
      const encrypted = new pkijs.EncryptedData({ schema: content.content });
      safeContents = pkijs.SafeContents.fromBER(await encrypted.decrypt({ password }));
    } else {
      safeContents = pkijs.SafeContents.fromBER(content.content.getValue());
    }
    for (const bag of safeContents.safeBags) {
      if (bag.bagId === OID_CERT_BAG) {
        const certBag = bag.bagValue as pkijs.CertBag;
        certs.push(
          certBag.parsedValue ??
            new pkijs.Certificate({
              schema: asn1js.fromBER((certBag.certValue as asn1js.OctetString).getValue()).result,
            }),
        );
      }
      if (bag.bagId === OID_KEY_BAG) {
        // parseInternalValues is protected in pkijs types but is the documented
        // way to decrypt the shrouded bag with the user's password.
        const keyBag = bag.bagValue as unknown as {
          parseInternalValues: (p: { password: Uint8Array }) => Promise<void>;
          parsedValue: pkijs.PrivateKeyInfo;
        };
        await keyBag.parseInternalValues({ password });
        pkcs8 = new Uint8Array(keyBag.parsedValue.toSchema().toBER(false));
      }
    }
  }
  if (certs.length === 0) throw new CertInvalidError('(no certificates in bundle)');
  if (!pkcs8) throw new CertInvalidError('(no private key in bundle)');
  return { certs, pkcs8 };
}

type KeyImportAlg = { name: 'ECDSA'; namedCurve?: string } | { name: 'RSASSA-PKCS1-v1_5'; hash: string };

function importAlgFor(spki: pkijs.AlgorithmIdentifier): KeyImportAlg {
  if (spki.algorithmId === OID_EC) {
    const curve = spki.algorithmParams?.valueBlock?.toString();
    const namedCurve = curve === OID_EC_P256 ? 'P-256' : curve === OID_EC_P384 ? 'P-384' : 'P-256';
    return { name: 'ECDSA', namedCurve };
  }
  return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
}

/**
 * Parse + inspect a P12 for the UI preview. Callers pass the password as a
 * UTF-16 string; it is encoded to the BufferSource pkijs's KDF needs and is
 * the ONLY place the plaintext exists outside the sign-tool's wiped ref.
 * Note (ENGINE-API): the password crosses comlink by structured clone — that
 * is accepted for this feature; do not "fix" by moving parse to the main
 * thread (the whole point is the key staying here).
 */
export async function inspectCertificateKey(
  p12Bytes: Uint8Array,
  password: string,
): Promise<CertKeyInfo> {
  const { certs } = await parseBags(p12Bytes, utf8.encode(password));
  const leaf = certs[0];
  const issuerCn = cnOf(leaf.issuer);
  const selfSigned = issuerCn === cnOf(leaf.subject);
  const missingIntermediate = !selfSigned && !certs.some((c) => cnOf(c.subject) === issuerCn);
  const { keyType, keyBits } = keyMeta(certs[0]);
  return {
    cn: cnOf(leaf.subject),
    issuerCn,
    notBeforeMs: leaf.notBefore.value.getTime(),
    notAfterMs: leaf.notAfter.value.getTime(),
    selfSigned,
    missingIntermediate,
    keyType,
    keyBits,
  };
}

function keyMeta(cert: pkijs.Certificate): { keyType: 'RSA' | 'EC'; keyBits: number } {
  const oid = cert.subjectPublicKeyInfo.algorithm.algorithmId;
  if (oid === OID_EC) {
    const curve = cert.subjectPublicKeyInfo.algorithm.algorithmParams?.valueBlock?.toString();
    return { keyType: 'EC', keyBits: curve === OID_EC_P384 ? 384 : 256 };
  }
  // RSA modulus bit length from the SPKI bit string's byte count, floored to
  // a standard key size (BIT STRING overhead + leading zero put 2048 at ~2168)
  // — enough for 2048/3072/4096 without a full PKCS#1 parse.
  const rawBits = cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView.byteLength * 8;
  return { keyType: 'RSA', keyBits: Math.floor(rawBits / 256) * 256 };
}

// ---- CMS (SignedData, detached) -------------------------------------------------

function attribute(oid: string, values: asn1js.BaseBlock[]): asn1js.Sequence {
  return new asn1js.Sequence({
    value: [new asn1js.ObjectIdentifier({ value: oid }), new asn1js.Set({ value: values })],
  });
}

async function buildCms(opts: {
  certs: pkijs.Certificate[];
  privateKey: CryptoKey;
  digest: Uint8Array;
  signingTime?: Date;
}): Promise<Uint8Array> {
  const { certs, privateKey, digest, signingTime = new Date() } = opts;
  const leaf = certs[0];
  const issuerName = new Uint8Array(leaf.issuer.toSchema().toBER(false)); // ISSUER, not subject
  const time =
    signingTime.getUTCFullYear() >= 2050
      ? new asn1js.GeneralizedTime({ valueDate: signingTime })
      : new asn1js.UTCTime({ valueDate: signingTime });
  const attrSeqs = [
    attribute('1.2.840.113549.1.9.3', [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })]),
    attribute('1.2.840.113549.1.9.4', [new asn1js.OctetString({ valueHex: digest })]),
    attribute('1.2.840.113549.1.9.5', [time]),
  ];
  const attrsDer = new Uint8Array(new asn1js.Set({ value: attrSeqs }).toBER(false));

  const isEc = privateKey.algorithm.name === 'ECDSA';
  let signature: Uint8Array;
  let sigAlgOid: string;
  const sigAlgParams: asn1js.Null[] | undefined = isEc ? undefined : [new asn1js.Null()];
  if (isEc) {
    // WebCrypto returns raw r‖s; CMS wants the DER SEQUENCE.
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, attrsDer),
    );
    signature = ecdsaRawToDer(raw);
    sigAlgOid = '1.2.840.10045.4.3.2'; // ecdsa-with-SHA256, params ABSENT
  } else {
    signature = new Uint8Array(
      await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, attrsDer),
    );
    sigAlgOid = OID_RSA; // rsaEncryption, params NULL
  }

  const signedAttrs0 = new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber: 0 },
    value: attrSeqs,
  });
  const signedData = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 1 }),
      new asn1js.Set({
        value: [
          new asn1js.Sequence({
            value: [new asn1js.ObjectIdentifier({ value: '2.16.840.1.101.3.4.2.1' }), new asn1js.Null()],
          }),
        ],
      }),
      new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })] }),
      new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 },
        value: certs.map((c) => asn1js.fromBER(new Uint8Array(c.toSchema(true).toBER(false))).result),
      }),
      new asn1js.Set({
        value: [
          new asn1js.Sequence({
            value: [
              new asn1js.Integer({ value: 1 }),
              new asn1js.Sequence({
                value: [asn1js.fromBER(issuerName).result, leaf.serialNumber],
              }),
              new asn1js.Sequence({
                value: [new asn1js.ObjectIdentifier({ value: '2.16.840.1.101.3.4.2.1' }), new asn1js.Null()],
              }),
              signedAttrs0,
              new asn1js.Sequence({
                value: [new asn1js.ObjectIdentifier({ value: sigAlgOid }), ...(sigAlgParams ?? [])],
              }),
              new asn1js.OctetString({ valueHex: signature }),
            ],
          }),
        ],
      }),
    ],
  });
  return new Uint8Array(
    new asn1js.Sequence({
      value: [
        new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.2' }),
        // content is [0] EXPLICIT — a bare SEQUENCE here breaks readers.
        new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [signedData] }),
      ],
    }).toBER(false),
  );
}

function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const n = raw.length >> 1;
  const encInt = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i += 1;
    const v = b.slice(i);
    const out = v[0] & 0x80 ? [0, ...v] : [...v];
    return [0x02, out.length, ...out];
  };
  const body = [...encInt(raw.slice(0, n)), ...encInt(raw.slice(n))];
  return new Uint8Array([0x30, body.length, ...body]);
}

// ---- placeholder + splice -------------------------------------------------------

export const P12_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Placeholder hex length sized from the parsed bundle (SPIKE finding #2): the
 * default 8192 either bloats small files or truncates big chains. Budget =
 * CMS overhead (~350B) + all embedded certs + signature, with margin.
 */
function placeholderHexLen(certs: pkijs.Certificate[], key: { keyType: string; keyBits: number }): number {
  const certsBytes = certs.reduce((sum, c) => sum + c.toSchema(true).toBER(false).byteLength, 0);
  const sigBytes = key.keyType === 'EC' ? Math.ceil(key.keyBits / 8) * 2 + 16 : key.keyBits / 8;
  return Math.min(Math.ceil((certsBytes + sigBytes + 768) * 2 / 8) * 8, 16384);
}

async function makePlaceholderDoc(pdfBytes: Uint8Array, hexLen: number): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  const { addSignaturePlaceholder } = await import('js-pdf-signer');
  const doc = await pdfLib.PDFDocument.load(pdfBytes.slice());
  const form = doc.getForm();
  if (form.getFields().some((f) => f instanceof pdfLib.PDFSignature)) {
    const err = new Error('already-signed');
    err.name = 'CertAlreadySigned';
    throw err;
  }
  const sigRef = doc.context.nextRef();
  doc.context.assign(
    sigRef,
    doc.context.obj({
      FT: pdfLib.PDFName.of('Sig'),
      T: pdfLib.PDFString.of('Sig1'),
      F: 4,
    }),
  );
  const acroForm = doc.catalog.lookupMaybe(pdfLib.PDFName.of('AcroForm'), pdfLib.PDFDict);
  const fields = acroForm?.lookupMaybe(pdfLib.PDFName.of('Fields'), pdfLib.PDFArray);
  if (!acroForm || !fields) {
    const err = new Error('no-acroform');
    err.name = 'CertInvalid';
    throw err;
  }
  fields.push(sigRef);
  const field = form.getFields().find((f) => f.getName() === 'Sig1');
  if (!field || !(field instanceof pdfLib.PDFSignature)) {
    throw new CertInvalidError('(sig field not created)');
  }
  addSignaturePlaceholder({ pdfLib, pdfDocLib: doc, field, placeholderHexLen: hexLen });
  // Object streams bury the placeholder the splice patches by offset.
  return doc.save({ useObjectStreams: false });
}

/**
 * Sign `pdfBytes` with the certificate/key inside `p12Bytes` (one-shot,
 * stateless: parse → placeholder → ByteRange splice → CMS → insert).
 */
export async function signWithCertificate(
  pdfBytes: Uint8Array,
  p12Bytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (p12Bytes.byteLength > P12_MAX_BYTES) {
    const err = new Error('certificate bundle too large');
    err.name = 'CertTooLarge';
    throw err;
  }
  const { certs, pkcs8 } = await parseBags(p12Bytes, utf8.encode(password));
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, importAlgFor(certs[0].subjectPublicKeyInfo.algorithm), true, ['sign']);
  const meta = keyMeta(certs[0]);

  const hexLen = placeholderHexLen(certs, meta);
  const placeholderBytes = await makePlaceholderDoc(pdfBytes, hexLen);

  let pdf = String.fromCharCode(...placeholderBytes);
  const brPos = pdf.indexOf('/ByteRange');
  const brEnd = pdf.indexOf(']', brPos) + 1;
  const brLen = brEnd - brPos;
  const ctPos = pdf.indexOf('/Contents ', brEnd);
  const phPos = pdf.indexOf('<', ctPos);
  const phEnd = pdf.indexOf('>', phPos);
  const phWith = phEnd + 1 - phPos;
  const phHexLen = phWith - 2;
  const byteRange = [0, phPos, phPos + phWith, pdf.length - (phPos + phWith)];
  const actual = `/ByteRange [${byteRange.join(' ')}]`;
  pdf = pdf.slice(0, brPos) + actual + ' '.repeat(Math.max(0, brLen - actual.length)) + pdf.slice(brEnd);
  const holed = pdf.slice(0, byteRange[1]) + pdf.slice(byteRange[2]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', latin1Bytes(holed)));
  const cms = await buildCms({ certs, privateKey: key, digest });
  const hex = [...cms].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (hex.length > phHexLen) {
    throw new Error(`CMS ${hex.length} hex > placeholder ${phHexLen}`);
  }
  const padded = hex + '0'.repeat(phHexLen - hex.length);
  return latin1Bytes(holed.slice(0, byteRange[1]) + `<${padded}>` + holed.slice(byteRange[1]));
}

function latin1Bytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));
}
