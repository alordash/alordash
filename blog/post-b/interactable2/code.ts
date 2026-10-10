
const bars = document.querySelector<HTMLDivElement>("#bars")!;
const total = document.querySelector<HTMLSpanElement>("#total")!;

const minSum = 2;
const sumCounts = new Array<number>(11).fill(0);
const fills: HTMLDivElement[] = [];

for (let i = 0; i < sumCounts.length; i++) {
    const bar = document.createElement("div");
    const fill = document.createElement("div");
    const label = document.createElement("span");

    bar.className = "bar";
    fill.className = "fill";
    label.textContent = String(minSum + i);

    bar.append(fill, label);
    bars.appendChild(bar);
    fills.push(fill);
}

function rollDie() {
    return 1 + Math.floor(Math.random() * 6);
}

function render() {
    const maxCount = Math.max(1, ...sumCounts);

    fills.forEach((fill, i) => {
        fill.style.height = `${(sumCounts[i] / maxCount) * 90}%`;
        fill.title = `${sumCounts[i]} rolls`;
    });

    total.textContent = String(sumCounts.reduce((sum, count) => sum + count, 0));
}

document.querySelector("#roll")!.addEventListener("click", () => {
    for (let i = 0; i < 100; i++) {
        sumCounts[rollDie() + rollDie() - minSum]++;
    }
    render();
});

document.querySelector("#reset")!.addEventListener("click", () => {
    sumCounts.fill(0);
    render();
});

render();
