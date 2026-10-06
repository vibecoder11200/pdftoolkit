import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { MetadataTool } from '../components/workspace/metadata-tool';

export function MetadataToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <MetadataTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
