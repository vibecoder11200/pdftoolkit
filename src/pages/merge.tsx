import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { MergeTool } from '../components/workspace/merge-tool';

export function MergeToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <MergeTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
