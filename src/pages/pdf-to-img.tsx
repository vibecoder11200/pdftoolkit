import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { PdfToImgTool } from '../components/workspace/pdf-to-img-tool';

export function PdfToImgToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <PdfToImgTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
