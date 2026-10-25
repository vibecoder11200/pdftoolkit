import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { EditorTool } from '../components/workspace/editor-tool';

export function EditorToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <EditorTool />
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
