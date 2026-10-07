import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { FillFormTool } from '../components/workspace/fill-form-tool';

export function FillFormToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <FillFormTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
