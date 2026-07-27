// The SPA imports stylesheets for their side effect, e.g. `import "@/routes/globals.css"` in
// main.tsx and the React Flow stylesheet in the canvas components. Only the bundler knows how
// to resolve those specifiers. TypeScript 7 turned on `noUncheckedSideEffectImports` by default,
// which makes a side-effect import it cannot resolve an error (TS2882).
//
// Declaring the `*.css` pattern here tells the compiler these specifiers are legitimate, and the
// check stays active for genuine typos in module paths elsewhere.
declare module "*.css";
