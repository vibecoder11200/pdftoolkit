import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { ExtractTool } from '../components/workspace/extract-tool';

export function ExtractToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <ExtractTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
