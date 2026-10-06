import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { DeleteTool } from '../components/workspace/delete-tool';

export function RemoveToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <DeleteTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
