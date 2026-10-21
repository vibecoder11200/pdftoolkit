import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { PageNumbersTool } from '../components/workspace/page-numbers-tool';

export function PageNumbersToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <PageNumbersTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
