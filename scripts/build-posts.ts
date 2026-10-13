import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

marked.setOptions({ gfm: true });

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    emptyLangClass: "hljs",
    highlight(code, language) {
      const lang = hljs.getLanguage(language) ? language : "plaintext";
      return hljs.highlight(code, { language: lang }).value;
    },
  }),
);

function slugify(html: string): string {
  return html
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&[^;]*;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slugify(text);
      return `<h${depth} id="${id}"><a class="header-anchor" href="#${id}" aria-label="Link to this header">#</a>${text}</h${depth}>\n`;
    },
  },
});

const root = process.cwd();
const distBlog = join(root, "dist", "blog");

function renderPostTemplate(
  indexHtml: string,
  postHtml: string,
  title: string,
): string {
  return indexHtml
    .replace(/<title>([\s\S]*?)<\/title>/i, `<title>${title}</title>`)
    .replace(/(href|src)="\.\//g, '$1="../../')
    .replace(/<main>[\s\S]*?<\/main>/i, `<main>${postHtml}</main>`);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractTitle(md: string): string {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "Post";
}

const slugs = readdirSync(distBlog, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const indexHtml = readFileSync(join(root, "index.html"), "utf8");
for (const slug of slugs) {
  const postDir = join(distBlog, slug);
  const mdPath = join(postDir, "index.md");
  if (!existsSync(mdPath)) continue;

  const md = readFileSync(mdPath, "utf8");
  const title = extractTitle(md);
  const postHtml = marked.parse(md) as string;
  const out = renderPostTemplate(indexHtml, postHtml, title);
  writeFileSync(join(postDir, "index.html"), out);
}
