
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
    const markdown = await loadMarkdown(location.href);

    main.innerHTML = marked.parse(markdown);

    const heading = main.querySelector("h1");
    if (heading) {
        document.title = `${heading.textContent} — ${document.title}`;
    }
}

function showPostDates() {
    for (const time of main.querySelectorAll<HTMLTimeElement>("li time")) {
        setDate(time, time.dateTime);
    }
}

async function loadMarkdown(postUrl: string): Promise<string> {
    const markdownUrl = new URL("index.md", postUrl);
    const response = await fetch(markdownUrl);

    if (!response.ok) {
        throw new Error(`Failed to load ${markdownUrl}: ${response.status}`);
    }

    return await response.text();
}

function setDate(time: HTMLTimeElement, date: string) {
    time.dateTime = date;
    time.textContent = new Date(date).toLocaleDateString("en", { dateStyle: "medium", timeZone: "UTC" });
}
