import { Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { HomePage } from './pages/home';
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

export const router = createBrowserRouter(
  [
    { path: '/', element: <HomePage /> },
    ...toolRoutes,
    { path: '*', element: <HomePage /> },
  ],
  { basename: '/pdftoolkit' },
);

export function RouterFallback() {
  return <Suspense fallback={null}>{null}</Suspense>;
}
