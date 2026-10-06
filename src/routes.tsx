import { Suspense } from 'react';
import { createBrowserRouter, Outlet } from 'react-router-dom';
import { HomePage } from './pages/home';
import { ComingSoonPage } from './pages/tool-placeholder';
import { LaunchBanner } from './components/layout/launch-banner';
import { MergeToolPage } from './pages/merge';
import { SplitToolPage } from './pages/split';
import { ExtractToolPage } from './pages/extract';
import { RemoveToolPage } from './pages/remove';
import { ReorderToolPage } from './pages/reorder';
import { RotateToolPage } from './pages/rotate';
import { CompressToolPage } from './pages/compress';
import { PdfToImgToolPage } from './pages/pdf-to-img';
import { ImgToPdfToolPage } from './pages/img-to-pdf';
import { EncryptToolPage } from './pages/encrypt';
import { MetadataToolPage } from './pages/metadata';
import { SignToolPage } from './pages/sign';

const toolRoutes = [
  'merge',
  'split',
  'extract',
  'remove',
  'reorder',
  'rotate',
  'compress',
  'pdf-to-img',
  'img-to-pdf',
  'encrypt',
  'metadata',
  'sign',
].map((path) => ({
  path: `/tools/${path}`,
  element:
    path === 'merge' ? (
      <MergeToolPage />
    ) : path === 'split' ? (
      <SplitToolPage />
    ) : path === 'extract' ? (
      <ExtractToolPage />
    ) : path === 'remove' ? (
      <RemoveToolPage />
    ) : path === 'reorder' ? (
      <ReorderToolPage />
    ) : path === 'rotate' ? (
      <RotateToolPage />
    ) : path === 'compress' ? (
      <CompressToolPage />
    ) : path === 'pdf-to-img' ? (
      <PdfToImgToolPage />
    ) : path === 'img-to-pdf' ? (
      <ImgToPdfToolPage />
    ) : path === 'encrypt' ? (
      <EncryptToolPage />
    ) : path === 'metadata' ? (
      <MetadataToolPage />
    ) : (
      <SignToolPage />
    ),
}));

// LaunchBanner lives at the root so an OS "open with" launch can surface it
// above any route without remounting page components.
function RootLayout() {
  return (
    <>
      <LaunchBanner />
      <Outlet />
    </>
  );
}

export const router = createBrowserRouter(
  [
    {
      element: <RootLayout />,
      children: [
        { path: '/', element: <HomePage /> },
        // Explicit "under development" entry (validation D2) — click shows the
        // coming-soon state instead of silently falling through to the catch-all.
        { path: '/tools/convert', element: <ComingSoonPage /> },
        ...toolRoutes,
        { path: '*', element: <HomePage /> },
      ],
    },
  ],
  { basename: '/pdftoolkit' },
);

export function RouterFallback() {
  return <Suspense fallback={null}>{null}</Suspense>;
}
