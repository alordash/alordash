
const main = document.querySelector("main")!;
const blogLink = document.querySelector<HTMLAnchorElement>("#blog-link")!;
const isPostPage = new URL(".", location.href).href !== blogLink.href;

if (!isPostPage) {
    showPostDates();
}

function showPostDates() {
    for (const time of main.querySelectorAll<HTMLTimeElement>("li time")) {
        setDate(time, time.dateTime);
    }
}

function setDate(time: HTMLTimeElement, date: string) {
    time.dateTime = date;
    time.textContent = new Date(date).toLocaleDateString("en", { dateStyle: "medium", timeZone: "UTC" });
}
