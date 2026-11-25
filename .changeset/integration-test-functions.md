---
"@wfgraph/core": major
"@wfgraph/plugins": major
---

`defineIntegration` takes the connection test and each config options provider as the function itself. Write `test: testMyService` and `configOptions: { templates: { answers: "options", load: templateOptions } }`, with `testMyService` and `templateOptions` imported statically from their modules. A `test` or `load` written as `async () => (await import("...")).fn` fails to type-check. The `ConfigOptionsLoader` type is removed from `@wfgraph/core/plugin`; name `ConfigOptionsFunction` in its place. The change exists because, in a bundled Cloudflare Worker, a dynamic import made the bundler wrap every module the import reached in a lazy initializer, which added startup time and bundle size.
