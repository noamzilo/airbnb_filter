// Airbnb Archiver — Milestone 0 (hello world)
// Proves the extension loads, the content script matches airbnb.com pages,
// DOM injection works, and a click handler fires. Nothing else yet.

console.log("[Airbnb Archiver] content script loaded");

const button = document.createElement("button");
button.textContent = "👋 Archiver works";
button.style.cssText = [
  "position: fixed",
  "bottom: 20px",
  "right: 20px",
  "z-index: 999999",
  "padding: 12px 16px",
  "font: 600 14px sans-serif",
  "color: #fff",
  "background: #e0115f",
  "border: none",
  "border-radius: 8px",
  "box-shadow: 0 2px 8px rgba(0,0,0,.3)",
  "cursor: pointer",
].join(";");

button.addEventListener("click", () => {
  alert("Hello from Airbnb Archiver!");
});

document.body.appendChild(button);
