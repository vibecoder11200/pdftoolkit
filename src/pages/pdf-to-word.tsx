import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { PdfToWordTool } from '../components/workspace/pdf-to-word-tool';

export function PdfToWordToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <PdfToWordTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
