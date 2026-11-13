import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { DiagnosticsTool } from '../components/workspace/diagnostics-tool';

export function DiagnosticsToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <DiagnosticsTool />
      </main>
      <Footer />
    </div>
  );
}
