import { unified } from 'unified';
import type { Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root } from 'hast';

const rehypeExternalLinks: Plugin<[], Root> = () => (tree) => {
  visit(tree, { type: 'element', tagName: 'a' }, (node) => {
    node.properties.rel = 'noopener noreferrer';
    node.properties.target = '_blank';
  });
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeExternalLinks)
  .use(rehypeStringify);

export function renderMarkdown(md: string): string {
  return String(processor.processSync(md));
}
