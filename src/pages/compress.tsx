import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { CompressTool } from '../components/workspace/compress-tool';

export function CompressToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <CompressTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
