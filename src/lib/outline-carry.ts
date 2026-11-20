/*
 * Outline carry-over (v0.13.0 phase 4): reads each source PDF's outline
 * (pdf.js, main thread — engine/pdfjs getOutlineTree), resolves dests to
 * 1-based source pages, then remaps them onto the concatenated organize
 * output (source i's pages shift by the total page count of sources 0..i-1).
 * THE differentiator for the queue's organize op vs merge: without this the
 * "giữ dấu trang" claim would be a lie (engine organizeExport writes
 * caller-supplied bookmarks ONLY; nothing in the repo read outlines before
 * this module).
 *
 * Failure posture: a source that fails outline reading contributes an empty
 * tree (organize proceeds merge-like) — the honest degraded behavior. Type
 * imports from the engine are TYPE-ONLY (no pdf-lib in the entry chunk).
 */

import { getOutlineTree, getPageCount, type OutlineTreeNode } from '../engine/pdfjs';
import type { OrganizeBookmarkWrite } from '../engine/pdf-lib';

/** Remap a resolved tree onto the output page numbering. */
function remapTree(
  nodes: OutlineTreeNode[],
  offset: number,
): OrganizeBookmarkWrite[] {
  return nodes.map((node) => ({
    title: node.title,
    ...(node.destPage != null ? { destPage: node.destPage + offset } : {}),
    ...(node.children.length > 0
      ? { children: remapTree(node.children, offset) }
      : {}),
  }));
}

/**
 * Concatenated carry-over for the organize adapter's default keep-source-
 * order plan: tree of source 0 first, then source 1 (offset by its page
 * count), and so on. Sources whose outline read fails contribute nothing
 * (never throws — the queue op must not die on a bookmarkless PDF).
 */
export async function carryOverBookmarks(sources: Uint8Array[]): Promise<OrganizeBookmarkWrite[]> {
  const out: OrganizeBookmarkWrite[] = [];
  let offset = 0;
  for (const bytes of sources) {
    try {
      const tree = await getOutlineTree(bytes);
      const count = await getPageCount(bytes);
      out.push(...remapTree(tree, offset));
      offset += count;
    } catch {
      // Count the pages even when the outline fails, so later offsets stay
      // correct; if even the count fails, assume 1 page (honest fallback).
      try {
        offset += await getPageCount(bytes);
      } catch {
        offset += 1;
      }
    }
  }
  return out;
}

// token-mapped
