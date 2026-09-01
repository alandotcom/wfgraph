/** @jsxImportSource hono/jsx */
/* oxlint-disable react/react-in-jsx-scope -- this file uses Hono's JSX runtime. */

const roleDescriptions = [
  ["admin", "All operations, including connections and API keys"],
  ["editor", "Workflow authoring, runs, and the build agent"],
  ["readonly", "Workflow, run, and connection viewing"],
] as const;

const loginCss = String.raw`
  :root { color-scheme: light; font-family: Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f5f5; color: #252525; }
  button, input { font: inherit; }
  .page { min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem; }
  .shell { width: min(100%, 23rem); }
  .brand { display: flex; align-items: center; gap: .625rem; margin-bottom: 1rem; }
  .mark { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: .375rem; background: #252525; color: #fafafa; font: 600 .6875rem/1 ui-monospace, SFMono-Regular, monospace; }
  .brand-name { font-size: .8125rem; font-weight: 600; }
  .card { overflow: hidden; border: 1px solid #e5e5e5; border-radius: .625rem; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
  .card-main { padding: 1.25rem; }
  h1 { margin: 0; font-size: 1rem; line-height: 1.5; font-weight: 600; }
  .lede { margin: .25rem 0 1.25rem; color: #737373; font-size: .75rem; line-height: 1.5; }
  .error { margin: 0 0 1rem; padding: .625rem .75rem; border: 1px solid #fecaca; border-radius: .375rem; background: #fef2f2; color: #991b1b; font-size: .75rem; line-height: 1.5; }
  .field { display: grid; gap: .375rem; margin-bottom: .875rem; }
  label { font-size: .75rem; line-height: 1.25; font-weight: 500; }
  input { width: 100%; height: 2rem; border: 1px solid #e5e5e5; border-radius: .375rem; background: #fafafa; padding: 0 .625rem; color: #252525; font-size: .8125rem; outline: none; transition: border-color 150ms, box-shadow 150ms; }
  input::placeholder { color: #a3a3a3; }
  input:focus-visible { border-color: #737373; box-shadow: 0 0 0 2px rgb(115 115 115 / .18); }
  .button { display: inline-flex; min-height: 2rem; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: .375rem; padding: 0 .75rem; font-size: .75rem; line-height: 1.25; font-weight: 500; text-decoration: none; cursor: pointer; transition: background-color 150ms, transform 150ms; }
  .button:active { transform: scale(.98); }
  .button-primary { width: 100%; background: #252525; color: #fafafa; }
  .button-primary:hover { background: #404040; }
  .button-secondary { background: #fff; border-color: #e5e5e5; color: #252525; }
  .button-secondary:hover { background: #f5f5f5; }
  .roles { border-top: 1px solid #e5e5e5; background: #fafafa; padding: .875rem 1.25rem 1rem; }
  .roles-title { margin: 0 0 .5rem; color: #737373; font-size: .6875rem; font-weight: 500; text-transform: uppercase; letter-spacing: .05em; }
  .role { display: grid; grid-template-columns: 4.25rem 1fr; gap: .5rem; padding: .25rem 0; font-size: .6875rem; line-height: 1.4; }
  .role code { color: #252525; font-weight: 600; }
  .role span { color: #737373; }
  .password { margin: .75rem 0 0; color: #737373; font-size: .6875rem; }
  .password code { color: #252525; }
  .session { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
  .session p { margin: 0; color: #737373; font-size: .75rem; line-height: 1.5; }
  .session strong { color: #252525; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; }
    body { background: #171717; color: #fafafa; }
    .mark { background: #fafafa; color: #171717; }
    .card { border-color: #333; background: #0a0a0a; box-shadow: none; }
    .lede, .session p, .roles-title, .role span, .password { color: #a3a3a3; }
    .roles { border-color: #333; background: #171717; }
    .role code, .password code, .session strong { color: #fafafa; }
    input { border-color: #404040; background: #262626; color: #fafafa; }
    input:focus-visible { border-color: #a3a3a3; box-shadow: 0 0 0 2px rgb(163 163 163 / .2); }
    .button-primary { background: #fafafa; color: #171717; }
    .button-primary:hover { background: #d4d4d4; }
    .button-secondary { border-color: #404040; background: #171717; color: #fafafa; }
    .button-secondary:hover { background: #262626; }
    .error { border-color: #7f1d1d; background: #450a0a; color: #fecaca; }
  }
`;

export function DemoLoginPage({
  username,
  invalidCredentials,
}: {
  username?: string;
  invalidCredentials?: boolean;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sign in | Workflow Graph</title>
        <style>{loginCss}</style>
      </head>
      <body>
        <main class="page">
          <div class="shell">
            <div class="brand">
              <span class="mark" aria-hidden="true">
                WF
              </span>
              <span class="brand-name">Workflow Graph</span>
            </div>
            <section class="card" aria-labelledby="login-title">
              <div class="card-main">
                <h1 id="login-title">Sign in to the example app</h1>
                <p class="lede">
                  Choose a test account to exercise its permissions.
                </p>
                {username ? (
                  <div class="session">
                    <p>
                      Signed in as <strong>{username}</strong>.
                    </p>
                    <form method="post" action="/logout">
                      <button class="button button-secondary" type="submit">
                        Log out
                      </button>
                    </form>
                  </div>
                ) : null}
                {invalidCredentials ? (
                  <p class="error" role="alert">
                    The username or password is incorrect.
                  </p>
                ) : null}
                <form method="post" action="/login">
                  <div class="field">
                    <label for="username">Username</label>
                    <input
                      id="username"
                      name="username"
                      autocomplete="username"
                      placeholder="admin, editor, or readonly"
                      required
                      autofocus
                    />
                  </div>
                  <div class="field">
                    <label for="password">Password</label>
                    <input
                      id="password"
                      name="password"
                      type="password"
                      autocomplete="current-password"
                      required
                    />
                  </div>
                  <button class="button button-primary" type="submit">
                    {username ? "Switch account" : "Sign in"}
                  </button>
                </form>
              </div>
              <div class="roles" aria-label="Available test accounts">
                <p class="roles-title">Test accounts</p>
                {roleDescriptions.map(([account, description]) => (
                  <div class="role" key={account}>
                    <code>{account}</code>
                    <span>{description}</span>
                  </div>
                ))}
                <p class="password">
                  Password for every account: <code>password</code>
                </p>
              </div>
            </section>
          </div>
        </main>
      </body>
    </html>
  );
}
