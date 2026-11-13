import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { OrganizeTool } from '../components/workspace/organize-tool';

export function OrganizeToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <OrganizeTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
