export const DEPLOYMENT_PAGE_STYLES = `    @font-face {
      font-family: "Photon PolySans";
      src: url("https://framerusercontent.com/assets/ITOtz0GJh0f4Y4Fu3osXqgXYuAw.woff2") format("woff2");
      font-display: swap;
      font-style: normal;
      font-weight: 300;
    }
    :root {
      color-scheme: light;
      --bg: #fbfbfa;
      --surface: #ffffff;
      --text: #111110;
      --muted: #70706d;
      --line: #e7e7e4;
      --soft: #f1f1ef;
      --accent: #111110;
      --accent-hover: #30302e;
      --danger: #9b3028;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-inline-size: 20rem;
      min-block-size: 100vh;
      min-block-size: 100svh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: var(--bg);
      color: var(--text);
      font-family: "Photon PolySans", Arial, sans-serif;
      font-size: 1rem;
      font-variation-settings: "wght" 450;
      line-height: 1.5;
    }
    .skip-link { position: fixed; inset-block-start: 0.75rem; inset-inline-start: -100%; z-index: 10; padding: 0.65rem 0.9rem; border: 0.0625rem solid var(--line); border-radius: 0.35rem; background: var(--surface); color: var(--text); }
    .skip-link:focus { inset-inline-start: 0.75rem; }
    .topbar { display: flex; min-block-size: 4.75rem; align-items: center; justify-content: space-between; gap: 1rem; padding-inline: clamp(1.25rem, 4vw, 3.5rem); border-block-end: 0.0625rem solid var(--line); background: var(--surface); }
    .brand { display: inline-flex; min-block-size: 2.75rem; align-items: center; gap: 1rem; color: var(--text); }
    .photon-link { display: inline-flex; inline-size: 2.75rem; block-size: 2.75rem; align-items: center; justify-content: center; border-radius: 0.7rem; color: var(--text); text-decoration: none; }
    .photon-logo { display: block; inline-size: 2.75rem; block-size: 2.75rem; border-radius: 0.7rem; }
    .product-name { font-size: 1rem; font-variation-settings: "wght" 550; }
    .topbar-nav { display: flex; align-items: center; gap: clamp(0.75rem, 3vw, 1.75rem); }
    .topbar-link { display: inline-flex; min-block-size: 2.75rem; align-items: center; color: var(--text); font-size: 0.92rem; font-variation-settings: "wght" 600; text-decoration: none; }
    .topbar-link:hover, .topbar-link:focus-visible { text-decoration: underline; text-underline-offset: 0.3em; }
    .state { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .shell { inline-size: min(100% - 2.5rem, 58rem); margin-inline: auto; padding-block: clamp(2.25rem, 6vw, 3.5rem); }
    .shell > * { animation: enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .shell > :nth-child(2) { animation-delay: 50ms; }
    .shell > :nth-child(3) { animation-delay: 90ms; }
    .shell > :nth-child(4) { animation-delay: 130ms; }
    h1 { max-inline-size: 13ch; margin: 0 0 1rem; font-size: clamp(3rem, 9vw, 6rem); font-weight: 300; font-variation-settings: "wght" 650; line-height: 0.94; letter-spacing: -0.055em; }
    h2 { margin: 0; font-size: clamp(1.5rem, 4vw, 2rem); font-weight: 300; font-variation-settings: "wght" 600; line-height: 1; letter-spacing: -0.035em; }
    .intro { max-inline-size: 39rem; margin: 0 0 clamp(2.25rem, 5vw, 3.5rem); color: var(--muted); font-size: clamp(1.1rem, 3vw, 1.4rem); line-height: 1.45; }
    .stack { display: grid; border-block-start: 0.0625rem solid var(--line); }
    .card { padding-block: clamp(1.75rem, 5vw, 2.75rem); border-block-end: 0.0625rem solid var(--line); background: transparent; }
    .compact { padding-block: 1.75rem; }
    .card-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .card-heading + :not(:empty) { margin-block-start: 1.75rem; }
    .state { color: var(--muted); font-size: 0.8rem; font-weight: 650; letter-spacing: 0.02em; text-align: end; }
    .state.ok, .ready-list { color: var(--text); }
    .auth-flow { display: grid; justify-items: start; gap: 1rem; }
    .auth-flow p, .progress, .owner-help, .owner-summary, .owner-format-help { max-inline-size: 38rem; margin: 0; color: var(--muted); }
    .owner-summary strong { color: var(--text); font-variation-settings: "wght" 650; }
    .owner-form { display: grid; max-inline-size: 28rem; gap: 0.9rem; }
    .owner-form label { font-size: 1rem; font-variation-settings: "wght" 600; }
    .country-fields { display: grid; gap: 0.55rem; }
    .country-fields[hidden] { display: none; }
    .owner-form select { inline-size: 100%; min-block-size: 3rem; padding: 0.7rem 2.25rem 0.7rem 0.85rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--text); font: inherit; }
    .phone-control { display: grid; grid-template-columns: auto minmax(0, 1fr); inline-size: 100%; }
    .phone-prefix { display: inline-flex; min-block-size: 3rem; align-items: center; padding-inline: 0.85rem; border: 0.0625rem solid var(--line); border-inline-end: 0; border-start-start-radius: 0.4rem; border-end-start-radius: 0.4rem; background: var(--soft); color: var(--muted); font: 1.05rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .phone-prefix[hidden] { display: none; }
    .owner-form input { inline-size: 100%; min-inline-size: 0; min-block-size: 3rem; padding: 0.7rem 0.85rem; border: 0.0625rem solid var(--line); border-radius: 0 0.4rem 0.4rem 0; background: var(--surface); color: var(--text); font: 1.05rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .phone-prefix[hidden] + input { border-radius: 0.4rem; }
    .country-toggle { inline-size: fit-content; min-block-size: 2.75rem; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 0.9rem; font-variation-settings: "wght" 600; text-decoration: underline; text-underline-offset: 0.25em; cursor: pointer; }
    .owner-form input:focus-visible, .owner-form select:focus-visible, .country-toggle:focus-visible, .owner-replace summary:focus-visible { position: relative; z-index: 1; outline: 0.2rem solid var(--text); outline-offset: 0.2rem; }
    .owner-form .error:empty { display: none; }
    .owner-replace { margin-block-start: 1rem; }
    .owner-replace summary { inline-size: fit-content; min-block-size: 2.75rem; cursor: pointer; font-variation-settings: "wght" 600; }
    .owner-replace[open] .owner-form { margin-block-start: 1rem; }
    .codex-progress { position: relative; inline-size: 100%; block-size: 0.35rem; margin-block-start: 1.35rem; overflow: hidden; border-radius: 999rem; background: var(--line); }
    .codex-progress span { display: block; inline-size: 34%; block-size: 100%; border-radius: inherit; background: var(--accent); animation: codex-progress 1.4s ease-in-out infinite; transform: translateX(-110%); }
    .device-code-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
    .device-code { display: block; padding: 0.85rem 1rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; background: var(--soft); font: 750 clamp(1.2rem, 6vw, 2rem) ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em; }
    .button { display: inline-flex; min-block-size: 3rem; align-items: center; justify-content: center; padding: 0.72rem 1.15rem; border: 0.0625rem solid var(--accent); border-radius: 999rem; background: var(--accent); color: white; font: inherit; font-size: 1rem; font-variation-settings: "wght" 550; text-decoration: none; cursor: pointer; transition: transform 160ms ease, background-color 160ms ease; }
    .button:hover, .button:focus-visible { background: var(--accent-hover); transform: translateY(-0.1rem); }
    .button:focus-visible, a:focus-visible { outline: 0.2rem solid var(--text); outline-offset: 0.2rem; }
    .button[disabled] { cursor: wait; opacity: 0.65; }
    .error { color: var(--danger); }
    .error code { font-size: 0.8em; }
    .error + .button { margin-block-start: 0.75rem; }
    .ready-card { display: grid; gap: 1.5rem; margin-block-start: 2rem; padding-block: 2rem; border-block: 0.0625rem solid var(--line); }
    .ready-list { display: grid; gap: 0.7rem; margin: 0; padding: 0; list-style: none; font-size: 1.35rem; }
    .agent-start { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem 1.5rem; }
    .agent-number { display: grid; gap: 0.2rem; }
    .agent-number span { color: var(--muted); }
    .agent-number strong { font-size: clamp(2rem, 7vw, 3.5rem); font-weight: 400; letter-spacing: -0.035em; }
    .agent-or { color: var(--muted); }
    .text-agent-button { flex: 0 0 auto; }
    .ready-message { margin: 0; font-size: 1.3rem; }
    .advanced-card { margin-block-start: 1.5rem; }
    .advanced-card summary { min-block-size: 2.75rem; cursor: pointer; font-size: 1.15rem; font-variation-settings: "wght" 600; }
    .advanced-card[open] summary { margin-block-end: 1.5rem; }
    .model-summary { display: grid; gap: 0.8rem; margin: 0 0 1.5rem; }
    .model-summary div { display: grid; grid-template-columns: minmax(8rem, 0.35fr) 1fr; gap: 1rem; }
    .model-summary dt { color: var(--muted); }
    .model-summary dd { margin: 0; }
    .model-settings-form { display: grid; max-inline-size: 32rem; gap: 0.65rem; }
    .model-settings-form label { margin-block-start: 0.35rem; font-variation-settings: "wght" 600; }
    .model-settings-form select { inline-size: 100%; min-block-size: 3rem; padding: 0.7rem 2.25rem 0.7rem 0.85rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--text); font: inherit; }
    .model-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-block-start: 0.75rem; }
    .secondary-button { background: var(--surface); color: var(--text); }
    .secondary-button:hover, .secondary-button:focus-visible { background: var(--soft); }
    .copy-code-button { flex: 0 0 auto; }
    .copy-code-status { min-block-size: 1.5rem; margin: 0; color: var(--muted); }
    #model-settings-status:empty, #model-fallback-explanation[hidden] { display: none; }
    .site-footer { border-block-start: 0.0625rem solid var(--line); background: var(--soft); }
    .footer-inner { display: flex; inline-size: min(100% - 2.5rem, 64rem); min-block-size: 5rem; margin-inline: auto; align-items: center; justify-content: space-between; gap: 1.5rem; padding-block: 1rem; }
    .footer-copy { margin: 0; color: var(--muted); }
    .footer-copy strong { color: var(--text); font-variation-settings: "wght" 600; }
    .footer-links { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.35rem 1.25rem; }
    .footer-links a { display: inline-flex; min-block-size: 2.75rem; align-items: center; color: var(--text); font-size: 0.9rem; font-variation-settings: "wght" 600; text-underline-offset: 0.25em; }
    .visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @keyframes enter { from { opacity: 0; transform: translateY(0.6rem); } to { opacity: 1; transform: translateY(0); } }
    @keyframes codex-progress { 0% { transform: translateX(-110%); } 55% { transform: translateX(105%); } 100% { transform: translateX(300%); } }
    @media (max-width: 32rem) { .card-heading { align-items: flex-start; } .state { max-inline-size: 10rem; } .ready-shell { padding-block: 1.5rem; } .ready-shell h1 { font-size: 2.6rem; } .ready-card { gap: 1.1rem; margin-block-start: 1.25rem; padding-block: 1.25rem; } .ready-list { gap: 0.45rem; font-size: 1.15rem; } .agent-start { align-items: flex-start; flex-direction: column; gap: 0.8rem; } .ready-message { font-size: 1.1rem; } .footer-inner { align-items: flex-start; flex-direction: column; gap: 0.25rem; } .footer-links { justify-content: flex-start; } }
    @media (prefers-contrast: more) { :root { --muted: #3f3f3d; --line: #777772; } .card, .device-code { border-width: 0.125rem; } }
    @media (prefers-contrast: forced) { .codex-progress { border: 0.125rem solid CanvasText; } .codex-progress span { background: Highlight; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } .codex-progress span { inline-size: 38%; animation: none !important; opacity: 0.55; transform: none; } }`;
