
const grid = document.querySelector<HTMLDivElement>("#grid")!;
const count = document.querySelector<HTMLSpanElement>("#count")!;

let activeCells = 0;

for (let i = 0; i < 40; i++) {
    const cell = document.createElement("button");

    cell.className = "cell";
    cell.type = "button";
    cell.setAttribute("aria-label", `Cell ${i + 1}`);
    cell.setAttribute("aria-pressed", "false");

    cell.addEventListener("click", () => {
        const active = cell.classList.toggle("active");

        cell.setAttribute("aria-pressed", String(active));
        activeCells += active ? 1 : -1;
        count.textContent = String(activeCells);
    });

    grid.appendChild(cell);
}
