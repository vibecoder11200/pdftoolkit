import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { TablesTool } from '../components/workspace/tables-tool';

export function TablesToolPage() {
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <TablesTool />
      </main>
      <Footer />
    </div>
  );
}
