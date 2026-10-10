import { marked } from "marked";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

marked.setOptions({ gfm: true });

const root = process.cwd();
const distBlog = join(root, "dist", "blog");

function renderPostTemplate(rootRel: string, title: string, htmlContent: string): string {
  return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)} — Test Blog</title>
        <link rel="stylesheet" href="${rootRel}style.css" />
    </head>
    <body>
        <header>
            <a href="${rootRel}">Home</a>
            •
            <a href="${rootRel}blog/">Blog</a>
        </header>

        <main id="post">${htmlContent}</main>
    </body>
</html>`;
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
  .filter((d) => d.name.startsWith("post-"))
  .map((d) => d.name);

for (const slug of slugs) {
  const postDir = join(distBlog, slug);
  const mdPath = join(postDir, "index.md");
  if (!existsSync(mdPath)) continue;

  const md = readFileSync(mdPath, "utf8");
  const title = extractTitle(md);
  const html = marked.parse(md) as string;
  const out = renderPostTemplate("../../", title, html);
  writeFileSync(join(postDir, "index.html"), out);
}
