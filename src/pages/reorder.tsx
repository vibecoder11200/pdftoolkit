import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { ReorderTool } from '../components/workspace/reorder-tool';

export function ReorderToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <ReorderTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
