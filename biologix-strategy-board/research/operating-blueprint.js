(function () {
  const links = Array.from(document.querySelectorAll(".blueprint-nav a"));
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if (!("IntersectionObserver" in window) || sections.length === 0) {
    return;
  }

  const linkById = new Map(
    links.map((link) => [link.getAttribute("href").slice(1), link])
  );
  const navList = document.querySelector(".blueprint-nav ol");

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

      if (visible.length === 0) {
        return;
      }

      links.forEach((link) => link.removeAttribute("aria-current"));
      const active = linkById.get(visible[0].target.id);
      if (active) {
        active.setAttribute("aria-current", "true");
        if (navList && navList.scrollWidth > navList.clientWidth) {
          active.scrollIntoView({
            behavior: "auto",
            block: "nearest",
            inline: "center"
          });
        }
      }
    },
    {
      rootMargin: "-128px 0px -58% 0px",
      threshold: [0, 0.1]
    }
  );

  sections.forEach((section) => observer.observe(section));
})();
