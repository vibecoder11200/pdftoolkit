import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { SignTool } from '../components/workspace/sign-tool';

export function SignToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <SignTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
