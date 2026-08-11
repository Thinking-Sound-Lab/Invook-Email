## Project rules

- Never guess or imagine requirements, behavior, data, states, labels, fields, actions, or design details. Implement only what the user explicitly provides or what the repository, connected services, or real stored data prove. When information is absent, preserve an honest empty or unavailable state.
- Never use dummy, mock, placeholder, synthetic, seeded, or fixture product data. Product flows must use real connected data. If a live integration is unavailable, show an honest empty or setup state instead of fabricating content.
- When replacing an implementation, remove its superseded code, routes, scripts, dependencies, environment variables, configuration, and implementation documentation in the same change. Do not retain legacy paths or compatibility shims unless the user explicitly requires them. Finish replacement work with a repository-wide search for obsolete implementation remnants.
- After every change, remove all dead or unused files, folders, functions, exports, routes, scripts, dependencies, environment variables, configuration, and documentation introduced or made obsolete by that change. Finish with a repository-wide search to confirm that no dead implementation remnants remain.
- Never use `setTimeout`, deadline options named `timeout`, or timer-based polling in project code or configuration. Prefer event-driven signals, database notifications, queue state, and platform-native health or retry behavior.
- For UUID generation and UUID utilities, always use the `uuid` package. Do not use UUID APIs from `node:crypto`, including `randomUUID`.
- Use Fastify for the API server. For outbound HTTP client requests in both frontend and backend application code, always use `axios`. Do not use the native `fetch` API, `node:http` client APIs, or `node:https` client APIs for application requests.
- Use an open-source-friendly repository structure. Put deployable applications in `apps/`, shared libraries and configuration in `packages/`, and container-related files in `docker/`.
- For frontend interfaces, use `shadcn/ui` components and conventions.
- Use Plus Jakarta Sans for all product interface typography. Do not introduce another product font without explicit approval.
- For frontend icons, use only the free Hugeicons icon pack unless the user explicitly approves another icon source.
- Do not use icon fonts, emoji, text glyphs, or hand-drawn SVGs as interface icons.
- Do not add borders or divider lines by default. Use spacing, typography, color, and surface contrast first; add a border only when it conveys necessary structure or state.
