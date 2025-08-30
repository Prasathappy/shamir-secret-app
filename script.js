const form = document.getElementById("uploadForm");
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const secretEl = document.getElementById("secret");
const summaryEl = document.getElementById("summary");
const wrongEl = document.getElementById("wrong");
const inliersEl = document.getElementById("inliers");

let chart;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  statusBox.textContent = "Uploading & processing...";
  resultBox.classList.add("hidden");

  const fd = new FormData(form);
  try {
    const resp = await fetch("/upload", { method: "POST", body: fd });
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || "Processing error");
    }

    // Fill UI
    secretEl.textContent = data.secret;
    summaryEl.innerHTML = `
      <li>Total shares parsed: <b>${data.totalShares}</b></li>
      <li>Minimum shares (k): <b>${data.minShares}</b></li>
    `;
    wrongEl.textContent = data.wrongShares.length ? data.wrongShares.join(", ") : "None";
    inliersEl.textContent = data.inlierShares.length ? data.inlierShares.join(", ") : "None";

    // Prepare data for plotting
    const validSet = new Set(data.inlierShares);
    const wrongSet = new Set(data.wrongShares);

    const validPoints = [];
    const wrongPoints = [];

    // X as numeric share ID, Y as decimal BigInt -> Number (may overflow; ok for visual only)
    for (const p of data.points) {
      const pt = { x: Number(p.x), y: Number(p.y) };
      if (wrongSet.has(p.id)) wrongPoints.push(pt);
      else if (validSet.has(p.id)) validPoints.push(pt);
      else validPoints.push(pt);
    }

    drawScatter(validPoints, wrongPoints);
    statusBox.textContent = "Done.";
    resultBox.classList.remove("hidden");
  } catch (err) {
    statusBox.textContent = "";
    resultBox.classList.add("hidden");
    alert(err.message);
  }
});

function drawScatter(validPoints, wrongPoints) {
  const ctx = document.getElementById("plot").getContext("2d");
  if (chart) { chart.destroy(); }

  chart = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Valid Shares",
          data: validPoints,
          pointRadius: 3
        },
        {
          label: "Wrong Shares",
          data: wrongPoints,
          pointRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { position: "top" }
      },
      scales: {
        x: {
          title: { display: true, text: "Share ID (x)" },
          ticks: { precision: 0 }
        },
        y: {
          title: { display: true, text: "Decoded Value (y)" }
        }
      }
    }
  });
}
