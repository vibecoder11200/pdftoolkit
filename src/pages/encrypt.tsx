import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { EncryptTool } from '../components/workspace/encrypt-tool';

export function EncryptToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <EncryptTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
