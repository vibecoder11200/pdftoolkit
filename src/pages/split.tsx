import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { SplitTool } from '../components/workspace/split-tool';

export function SplitToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <SplitTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
