(function () {
  "use strict";

  const themeButton = document.getElementById("evalThemeButton");
  if (themeButton) {
    themeButton.addEventListener("click", function () {
      const root = document.documentElement;
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem("twilio-theme", next);
    });
  }

  const notice = document.getElementById("evalReviewNotify");
  const noticeText = document.getElementById("evalReviewText");
  if (!notice || !noticeText) return;
  let checking = false;
  async function pollReviewCount() {
    if (document.hidden || checking) return;
    checking = true;
    try {
      const response = await fetch("/dashboard/api/review-count");
      if (!response.ok) return;
      const payload = await response.json();
      const count = Math.max(0, Number(payload.count) || 0);
      notice.hidden = count === 0;
      noticeText.textContent = count === 1 ? "1 portrait waiting for review" : count + " portraits waiting for review";
      document.body.classList.toggle("review-pending", count > 0);
    } catch {
      // A temporary review-count failure should not interrupt Prompt Lab.
    } finally {
      checking = false;
    }
  }
  pollReviewCount();
  setInterval(pollReviewCount, 15000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) pollReviewCount();
  });
})();
