import type { PDFDocument } from 'pdf-lib';

/**
 * Self-signed PKCS#7 (detached) signature — spike S3 recipe, see
 * docs/SPIKES.md. pdf-lib 1.17.1 has no API to create a signature field,
 * so the `/FT /Sig` field is built low-level, then js-pdf-signer injects
 * the `/ByteRange` + `/Contents` placeholder and fills it via WebCrypto.
 * The result is verifiable offline (`openssl cms -verify`) but carries a
 * self-created certificate: readers like Adobe/UPDF show it as untrusted.
 */
export async function addSelfSignature(doc: PDFDocument): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  const { addSignaturePlaceholder, signPdfBytes } = await import('js-pdf-signer');
  const { PDFName, PDFString, PDFSignature } = pdfLib;

  const form = doc.getForm();
  if (form.getFields().some((f) => f instanceof PDFSignature)) {
    throw new Error('already-signed');
  }

  // Invisible Sig1 field: plain dict assigned its own ref and appended to
  // the AcroForm /Fields array (getForm() guarantees AcroForm + Fields exist).
  const sigRef = doc.context.nextRef();
  doc.context.assign(
    sigRef,
    doc.context.obj({
      FT: PDFName.of('Sig'),
      T: PDFString.of('Sig1'),
      F: 4,
    }),
  );
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  const fields = acroForm.lookup(PDFName.of('Fields'));
  if (!(fields instanceof pdfLib.PDFArray)) {
    throw new Error('no-acroform-fields');
  }
  fields.push(sigRef);

  const field = form
    .getFields()
    .find((f) => f.getName() === 'Sig1');
  if (!field || !(field instanceof PDFSignature)) {
    throw new Error('sig-field-not-created');
  }

  addSignaturePlaceholder({ pdfLib, pdfDocLib: doc, field });

  // Object streams would bury the placeholder the signer patches by byte
  // offset — the spike proved save() must keep plain objects.
  const placeholderBytes = await doc.save({ useObjectStreams: false });
  return signPdfBytes(placeholderBytes);
}
