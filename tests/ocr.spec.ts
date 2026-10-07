// Phase 4a unit gates (plan v0.4.0): session config overrides (anti-CDN R14),
// lazy same-origin asset pinning, fold-merge (R8/D7), page cap (D7), abort.
// tesseract.js is mocked — no real OCR runs in unit tests; integration lives
// in phase 4b.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import workerScriptUrl from 'tesseract.js/dist/worker.min.js?url';
import {
  OCR_FOLD_EVERY,
  OCR_PAGE_CAP,
  OcrAbortedError,
  OcrAssetError,
  OcrError,
  OcrPageCapError,
  OcrPageInput,
  assertPageCountOk,
  createOcrSession,
  ensureOcrAssets,
  foldSearchablePdfParts,
  mergeSearchablePdfParts,
  CORE_ASSETS,
} from '../src/lib/ocr';

// Same-origin anchor the module must derive every asset URL from ( asserted
// relative to the env value — never hardcoded — so the desktop '/' base and
// the Pages '/pdftoolkit/' base are both covered).
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

const coreUrls = CORE_ASSETS.map((file) => `${BASE}/${file}`);
const tessdataUrl = (lang: string) => `${BASE}/tessdata/${lang}.traineddata.gz`;

interface FakeWorker {
  recognize: Mock;
  terminate: Mock;
}

function makeFakeWorker(recognize?: Mock, terminate?: Mock): FakeWorker {
  return {
    recognize:
      recognize ??
      vi.fn(async () => ({ jobId: 'job', data: { text: 'page text', confidence: 87 } })),
    terminate: terminate ?? vi.fn(async () => ({})),
  };
}

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

// No real tesseract module load (node-side unit test): OEM.LSTM_ONLY === 1.
vi.mock('tesseract.js', () => ({ OEM: { LSTM_ONLY: 1 }, createWorker: mocks.createWorker }));

const pageInput = {} as OcrPageInput; // mocked worker never inspects it

function stubOcrCache(prefillUrls: string[] = []) {
  const store = new Map<string, Response>(prefillUrls.map((url) => [url, new Response('x')]));
  const cache = {
    match: vi.fn(async (url: string) => store.get(url)),
    put: vi.fn(async (url: string, response: Response) => {
      store.set(url, response);
    }),
  };
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  return { store, cache };
}

function stubFetch(handler?: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    return handler ? handler(url) : new Response('asset-bytes', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const fetchUrls = (fetchMock: Mock) => fetchMock.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  mocks.createWorker.mockReset();
  mocks.createWorker.mockImplementation(async () => makeFakeWorker());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureOcrAssets', () => {
  it('fetches each missed asset exactly once with same-origin URLs and puts it in the store', async () => {
    const { store } = stubOcrCache();
    const fetchMock = stubFetch();

    await ensureOcrAssets('eng');

    const expected = [...coreUrls, tessdataUrl('eng')];
    expect(fetchUrls(fetchMock)).toEqual(expected);
    expect(fetchUrls(fetchMock).every((u) => !/^https?:\/\//.test(u))).toBe(true);
    for (const url of expected) {
      expect(store.has(url)).toBe(true);
    }
  });

  it('parses multi-language sets on "+" and loads one traineddata per language', async () => {
    stubOcrCache();
    const fetchMock = stubFetch();

    await ensureOcrAssets('vie+eng');

    expect(fetchUrls(fetchMock)).toEqual([...coreUrls, tessdataUrl('vie'), tessdataUrl('eng')]);
  });

  it('cache hits skip the network entirely', async () => {
    const expected = [...coreUrls, tessdataUrl('vie'), tessdataUrl('eng')];
    stubOcrCache(expected);
    const fetchMock = stubFetch();

    await ensureOcrAssets('vie+eng');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed fetch throws OcrAssetError and attempts no further network calls', async () => {
    stubOcrCache();
    const fetchMock = stubFetch(() => new Response('gone', { status: 404 }));

    await expect(ensureOcrAssets('eng')).rejects.toBeInstanceOf(OcrAssetError);

    expect(fetchUrls(fetchMock)).toEqual([coreUrls[0]]);
  });

  it('a network-level fetch failure throws OcrAssetError with the cause preserved', async () => {
    stubOcrCache();
    stubFetch(() => {
      throw new Error('offline');
    });

    const error = await ensureOcrAssets('eng').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcrAssetError);
    expect((error as OcrAssetError).cause).toBeInstanceOf(Error);
  });

  it('rejects path-unsafe language codes before any network access', async () => {
    const { cache } = stubOcrCache();
    const fetchMock = stubFetch();

    await expect(ensureOcrAssets('eng+../etc' as 'eng+vie')).rejects.toBeInstanceOf(OcrError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
  });
});

describe('createOcrSession worker config', () => {
  it('overrides every CDN-able path and disables workerBlobURL (R14)', async () => {
    stubOcrCache();
    stubFetch();

    const session = await createOcrSession({ langs: 'vie+eng' });
    await session.dispose();

    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    const [langs, oem, options] = mocks.createWorker.mock.calls[0] as [
      string,
      number,
      Record<string, unknown>,
    ];
    expect(langs).toBe('vie+eng');
    expect(oem).toBe(1); // OEM.LSTM_ONLY
    expect(options.workerBlobURL).toBe(false);
    expect(options.gzip).toBe(true);
    expect(options.workerPath).toBe(workerScriptUrl);
    expect(String(options.workerPath).endsWith('worker.min.js')).toBe(true);
    expect(options.corePath).toBe(`${BASE}/tesseract-core`);
    expect(options.langPath).toBe(`${BASE}/tessdata`);
    for (const value of [options.workerPath, options.corePath, options.langPath]) {
      expect(String(value)).not.toMatch(/cdn\.jsdelivr\.net/);
    }
  });

  it('pins the assets before spawning the worker', async () => {
    const { store } = stubOcrCache();
    stubFetch();

    const session = await createOcrSession({ langs: 'eng' });
    await session.dispose();

    expect(store.size).toBe(coreUrls.length + 1);
  });

  it('pipes worker progress through onProgress', async () => {
    const worker = makeFakeWorker(
      vi.fn(async () => ({ jobId: 'job', data: { text: 'x', confidence: 1 } })),
    );
    mocks.createWorker.mockImplementation(async () => worker);
    const onProgress = vi.fn();
    stubOcrCache();
    stubFetch();

    const session = await createOcrSession({ langs: 'eng', onProgress });
    const [, , options] = mocks.createWorker.mock.calls[0] as [
      string,
      number,
      { logger: (message: { status: string; progress: number }) => void },
    ];
    options.logger({ status: 'recognizing text', progress: 0.5 });
    await session.dispose();

    expect(onProgress).toHaveBeenCalledWith({ status: 'recognizing text', progress: 0.5 });
  });
});

describe('session recognize API', () => {
  it('recognizeText returns text and the page mean confidence', async () => {
    stubOcrCache();
    stubFetch();
    const session = await createOcrSession({ langs: 'eng' });

    await expect(session.recognizeText(pageInput)).resolves.toEqual({
      text: 'page text',
      confidence: 87,
    });
    await session.dispose();
  });

  it('recognizeToPdfPage returns the pdf bytes as Uint8Array', async () => {
    stubOcrCache();
    stubFetch();
    const worker = makeFakeWorker(
      vi.fn(async () => ({ jobId: 'job', data: { text: null, confidence: 0, pdf: [37, 80, 68, 70] } })),
    );
    mocks.createWorker.mockImplementation(async () => worker);
    const session = await createOcrSession({ langs: 'eng' });

    const bytes = await session.recognizeToPdfPage(pageInput);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([37, 80, 68, 70]);
    await session.dispose();
  });

  it('recognizeToPdfPage throws OcrError when tesseract produced no pdf', async () => {
    stubOcrCache();
    stubFetch();
    const session = await createOcrSession({ langs: 'eng' });

    await expect(session.recognizeToPdfPage(pageInput)).rejects.toBeInstanceOf(OcrError);
    await session.dispose();
  });

  it('recycles the worker transparently every 25 recognized pages (R8)', async () => {
    stubOcrCache();
    stubFetch();
    const workers: FakeWorker[] = [];
    mocks.createWorker.mockImplementation(async () => {
      const worker = makeFakeWorker();
      workers.push(worker);
      return worker;
    });
    const session = await createOcrSession({ langs: 'eng' });

    for (let page = 0; page < 25; page += 1) await session.recognizeText(pageInput);

    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(workers[1]!.terminate).not.toHaveBeenCalled();

    await session.dispose();
    expect(workers[1]!.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('abort and dispose', () => {
  it('lets the in-flight page finish, then rejects the next call with OcrAbortedError', async () => {
    stubOcrCache();
    stubFetch();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = makeFakeWorker(
      vi.fn(() => gate.then(() => ({ jobId: 'job', data: { text: 'x', confidence: 50 } }))),
    );
    mocks.createWorker.mockImplementation(async () => worker);
    const session = await createOcrSession({ langs: 'eng' });

    const inFlight = session.recognizeText(pageInput);
    session.abort();
    release();

    await expect(inFlight).resolves.toEqual({ text: 'x', confidence: 50 });
    await expect(session.recognizeText(pageInput)).rejects.toBeInstanceOf(OcrAbortedError);
    await session.dispose();
  });

  it('dispose terminates the worker and later recognizes throw OcrError', async () => {
    stubOcrCache();
    stubFetch();
    const worker = makeFakeWorker();
    mocks.createWorker.mockImplementation(async () => worker);
    const session = await createOcrSession({ langs: 'eng' });

    await session.dispose();
    await session.dispose(); // idempotent
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(session.recognizeText(pageInput)).rejects.toBeInstanceOf(OcrError);
  });
});

describe('page cap (D7)', () => {
  it('accepts counts up to OCR_PAGE_CAP and throws OcrPageCapError above it', () => {
    expect(OCR_PAGE_CAP).toBe(100);
    expect(() => assertPageCountOk(1)).not.toThrow();
    expect(() => assertPageCountOk(OCR_PAGE_CAP)).not.toThrow();

    const error = (() => {
      try {
        assertPageCountOk(OCR_PAGE_CAP + 1);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(OcrPageCapError);
    expect((error as OcrPageCapError).pageCount).toBe(101);
  });
});

describe('searchable pdf merge (R8/D7)', () => {
  async function onePagePdf(label: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([216, 108]).drawText(label, { x: 8, y: 54, size: 12, font });
    return doc.save();
  }

  const pageCountOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

  it('merges all parts in order', async () => {
    const parts = await Promise.all(Array.from({ length: 12 }, (_, i) => onePagePdf(`p${i + 1}`)));

    const merged = await mergeSearchablePdfParts(parts);

    expect(await pageCountOf(merged)).toBe(12);
  });

  it('rejects an empty part list', async () => {
    await expect(mergeSearchablePdfParts([])).rejects.toBeInstanceOf(OcrError);
  });

  it(`folds parts into chunks of OCR_FOLD_EVERY (${OCR_FOLD_EVERY}) without touching inputs`, async () => {
    const parts = await Promise.all(Array.from({ length: 12 }, (_, i) => onePagePdf(`p${i + 1}`)));

    const folded = await foldSearchablePdfParts(parts);

    expect(parts).toHaveLength(12); // pure: inputs preserved
    expect(folded).toHaveLength(2);
    expect(await pageCountOf(folded[0]!)).toBe(10);
    expect(await pageCountOf(folded[1]!)).toBe(2);
    // Merging the folded parts reconstructs the full document.
    expect(await pageCountOf(await mergeSearchablePdfParts(folded))).toBe(12);
  });

  it('exposes the fold constant for phase 5 accumulators', () => {
    expect(OCR_FOLD_EVERY).toBe(10);
  });
});
