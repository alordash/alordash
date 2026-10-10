
interface Post {
    date: string;
    body: string;
}

const main = document.querySelector("main")!;
const blogLink = document.querySelector<HTMLAnchorElement>("#blog-link")!;
const isPostPage = new URL(".", location.href).href !== blogLink.href;

if (isPostPage) {
    renderPost();
} else {
    showPostDates();
}

async function renderPost() {
    const { marked } = await import("https://cdn.jsdelivr.net/npm/marked@18.1.0/lib/marked.esm.js");
    const post = await loadPost(location.href);

    main.innerHTML = marked.parse(post.body);
    main.prepend(createDateElement(post.date));

    const heading = main.querySelector("h1");
    if (heading) {
        document.title = `${heading.textContent} — ${document.title}`;
    }
}

function showPostDates() {
    for (const link of main.querySelectorAll<HTMLAnchorElement>("li a")) {
        const time = document.createElement("time");
        link.before(time);
        fillDate(link.href, time);
    }
}

async function fillDate(postUrl: string, time: HTMLTimeElement) {
    const post = await loadPost(postUrl);
    setDate(time, post.date);
}

async function loadPost(postUrl: string): Promise<Post> {
    const markdownUrl = new URL("index.md", postUrl);
    const response = await fetch(markdownUrl);

    if (!response.ok) {
        throw new Error(`Failed to load ${markdownUrl}: ${response.status}`);
    }

    const markdown = await response.text();
    const frontMatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    const date = frontMatter?.[1].match(/^date:\s*(\S+)\s*$/m);

    if (!date) {
        throw new Error(`No date in front matter of ${markdownUrl}`);
    }

    return { date: date[1], body: markdown.slice(frontMatter![0].length) };
}

function createDateElement(date: string) {
    const time = document.createElement("time");
    setDate(time, date);
    return time;
}

function setDate(time: HTMLTimeElement, date: string) {
    time.dateTime = date;
    time.textContent = new Date(date).toLocaleDateString("en", { dateStyle: "medium", timeZone: "UTC" });
}
