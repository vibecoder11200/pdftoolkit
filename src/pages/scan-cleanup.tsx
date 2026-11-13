import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { ScanCleanupTool } from '../components/workspace/scan-cleanup-tool';

export function ScanCleanupToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <ScanCleanupTool />
      </main>
      <Footer />
    </div>
  );
}
