import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { BlankPagesTool } from '../components/workspace/blank-pages-tool';

export function BlankPagesToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <BlankPagesTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
