import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { CompareTool } from '../components/workspace/compare-tool';

export function CompareToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <CompareTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
