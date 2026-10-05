// Site-wide menu, injected at the top of every public page so there is one
// list of pages to maintain. Self-contained styles so it looks the same on
// pages with different themes.
(function () {
  var LINKS = [
    ["/", "Home"],
    ["/methodology", "Methodology"],
    ["/lists", "Lists we check"],
    ["/docs", "API docs"],
  ];
  var path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/landing") path = "/";

  var css = document.createElement("style");
  css.textContent =
    "#site-nav{font:500 13.5px/1.2 Inter,-apple-system,'Segoe UI',sans-serif;background:#fbfaf7;" +
    "border-bottom:1px solid #d9d6cd;position:sticky;top:0;z-index:1000}" +
    "#site-nav .in{max-width:1080px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:6px;" +
    "overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch}" +
    "#site-nav .brand{font:700 15px Georgia,serif;color:#1a1a18;text-decoration:none;padding:13px 14px 13px 0;margin-right:8px}" +
    "#site-nav a.l{color:#6b6a63;text-decoration:none;padding:13px 10px;border-bottom:2px solid transparent}" +
    "#site-nav a.l:hover{color:#1a1a18}" +
    "#site-nav a.l.on{color:#1a1a18;border-bottom-color:#1a1a18}";
  document.head.appendChild(css);

  var nav = document.createElement("nav");
  nav.id = "site-nav";
  nav.setAttribute("aria-label", "Site");
  nav.innerHTML =
    '<div class="in"><a class="brand" href="/">PayPerScreen</a>' +
    LINKS.map(function (l) {
      return '<a class="l' + (l[0] === path ? " on" : "") + '" href="' + l[0] + '">' + l[1] + "</a>";
    }).join("") + "</div>";
  document.body.insertBefore(nav, document.body.firstChild);
})();
