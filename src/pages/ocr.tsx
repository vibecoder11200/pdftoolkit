import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { OcrTool } from '../components/workspace/ocr-tool';

export function OcrToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <OcrTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
