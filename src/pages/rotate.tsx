import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { RotateTool } from '../components/workspace/rotate-tool';

export function RotateToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <RotateTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
