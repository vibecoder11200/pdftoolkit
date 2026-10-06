import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { ImgToPdfTool } from '../components/workspace/img-to-pdf-tool';

export function ImgToPdfToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <ImgToPdfTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
