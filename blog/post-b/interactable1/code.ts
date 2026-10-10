
const channels = ["red", "green", "blue"].map(id => document.querySelector<HTMLInputElement>(`#${id}`)!);
const swatch = document.querySelector<HTMLDivElement>("#swatch")!;
const hex = document.querySelector<HTMLElement>("#hex")!;

function updateColor() {
    const color = "#" + channels.map(channel => Number(channel.value).toString(16).padStart(2, "0")).join("");

    swatch.style.background = color;
    hex.textContent = color;
}

for (const channel of channels) {
    channel.addEventListener("input", updateColor);
}

updateColor();
